import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address();
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test server did not start');
}

test('API key detail endpoint is authenticated, converts balances, and never returns keys', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-api-keys-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/user/self/groups') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { default: { ratio: 1 }, vip: { ratio: 0.72 } } }));
      return;
    }
    if (req.url?.startsWith('/api/token/?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: {
          total: 2,
          items: [
            { id: 1, key: 'acct********aaaa', name: 'account-primary', status: 1, remain_quota: 500000, used_quota: 100000, unlimited_quota: false, group: 'default', expired_time: -1 },
            { id: 2, key: 'acct********bbbb', name: 'account-vip', status: 1, remain_quota: 1000000, used_quota: 500000, unlimited_quota: false, group: 'vip', expired_time: -1 },
          ],
        },
      }));
      return;
    }
    if (req.url === '/api/user/self') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { quota: 2500000 } }));
      return;
    }
    if (req.url !== '/api/usage/token') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
      return;
    }
    const authorization = String(req.headers.authorization || '');
    const second = authorization === 'Bearer sk-private-integration-2222';
    const valid = second || authorization === 'Bearer sk-private-integration-1111';
    res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(valid ? {
      code: true,
      data: {
        name: second ? 'secondary' : 'primary',
        total_granted: second ? 1500000 : 1000000,
        total_used: second ? 500000 : 250000,
        total_available: second ? 1000000 : 750000,
        unlimited_quota: false,
        group: second ? 'vip' : 'default',
        group_ratio: second ? 0.7 : 1,
      },
    } : { success: false, message: `invalid ${authorization}` }));
  });
  const upstreamAddress = await listen(upstream);
  const appPort = 21000 + Math.floor(Math.random() * 2000);
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      DATA_FILE: path.join(tempDir, 'db.json'),
      MASTER_KEY: 'api-key-details-master-key-with-32-characters',
      SESSION_SECRET: 'api-key-details-session-secret-with-32-characters',
      ADMIN_USERNAME: 'OpsOwner',
      ADMIN_PASSWORD: 'Strong-Console-Password9!',
      AUTH_DISABLED: 'false',
      SEED_DEMO: 'false',
      TURNSTILE_SOLVER: 'none',
      DASHBOARD_TURNSTILE_SITE_KEY: '',
      DASHBOARD_TURNSTILE_SECRET_KEY: '',
      MONITOR_TICK_MS: '3600000',
    },
    stdio: 'ignore',
  });

  let cookie = '';
  const request = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };

  try {
    await waitForServer(baseUrl, child);

    let result = await request('/api/accounts/missing/api-keys');
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error, 'AUTH_REQUIRED');

    result = await request('/api/session/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'OpsOwner', password: 'Strong-Console-Password9!' }),
    });
    assert.equal(result.response.status, 200);
    assert.ok(cookie.includes('frosted_session='));

    result = await request('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        upstreamName: 'Shared Provider',
        name: 'Integration New API',
        type: 'newapi',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
        region: 'test',
        authMode: 'api_token',
        tokenStrategy: 'sticky',
        balancePath: 'data.total_available',
        formula: 'x / 500000 * 1',
        rawUnit: 'quota',
        thresholdLow: 10,
        thresholdRecover: 20,
        pollIntervalMinutes: 5,
        enabled: true,
        notifications: { resend: false, feishu: false },
        credentials: {
          apiTokens: ['sk-private-integration-1111', 'sk-private-integration-2222'],
        },
      }),
    });
    assert.equal(result.response.status, 201);
    const accountId = result.body.account.id;
    const sharedUpstreamId = result.body.account.upstreamId;

    result = await request(`/api/accounts/${accountId}/api-keys`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.keyCount, 2);
    assert.deepEqual(result.body.summary, { available: 2, unavailable: 0 });
    assert.equal(result.body.keys[0].convertedCny, 1.5);
    assert.equal(result.body.keys[1].convertedCny, 2);
    assert.equal(result.body.keys[1].rateMultiplier, 0.7);
    assert.equal(result.body.keys[1].totalUsed, 500000);
    const serialized = JSON.stringify(result.body);
    assert.doesNotMatch(serialized, /sk-private-integration/);
    assert.match(result.body.keys[0].maskedToken, /1111$/);

    result = await request('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        upstreamName: 'shared provider',
        name: 'Official account token',
        type: 'newapi',
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
        region: 'test',
        authMode: 'access_token',
        userId: '1090',
        balancePath: 'data.quota',
        formula: 'x / 500000 * 1',
        rawUnit: 'quota',
        thresholdLow: 10,
        thresholdRecover: 20,
        pollIntervalMinutes: 5,
        enabled: true,
        notifications: { resend: false, feishu: false },
        credentials: { accessToken: 'private-account-access-token' },
      }),
    });
    assert.equal(result.response.status, 201);
    const accessAccountId = result.body.account.id;
    assert.equal(result.body.account.upstreamId, sharedUpstreamId);

    result = await request(`/api/accounts/${accessAccountId}/api-keys`);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.mode, 'access_token');
    assert.equal(result.body.keyCount, 2);
    assert.equal(result.body.keys[0].convertedCny, 1);
    assert.equal(result.body.keys[1].convertedCny, 2);
    assert.equal(result.body.keys[1].rateMultiplier, 0.72);
    assert.doesNotMatch(JSON.stringify(result.body), /private-account-access-token/);

    result = await request('/api/dashboard');
    assert.equal(result.body.upstreams.filter((upstream) => upstream.id === sharedUpstreamId).length, 1);
    assert.equal(result.body.upstreams.find((upstream) => upstream.id === sharedUpstreamId).accountCount, 2);

    result = await request(`/api/accounts/${accessAccountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ upstreamName: 'Moved Provider' }),
    });
    assert.equal(result.response.status, 200);
    assert.notEqual(result.body.account.upstreamId, sharedUpstreamId);
    result = await request('/api/dashboard');
    assert.equal(result.body.upstreams.filter((upstream) => upstream.name === 'Moved Provider').length, 1);
  } finally {
    child.kill();
    if (child.exitCode == null) await once(child, 'exit');
    upstream.close();
    await once(upstream, 'close');
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
