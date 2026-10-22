import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startTestServer, stopTestServer } from './helpers/server-process.js';

test('PATCH account merges notification switches per channel instead of resetting them', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-patch-notify-'));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { quota: 100 } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const serverProcess = await startTestServer({
    DATA_FILE: path.join(tempDir, 'db.json'),
    MASTER_KEY: 'patch-notify-master-key-with-32-characters',
    SESSION_SECRET: 'patch-notify-session-secret-with-32-characters',
    ADMIN_USERNAME: 'OpsOwner',
    ADMIN_PASSWORD: 'Strong-Console-Password9!',
    AUTH_DISABLED: 'false',
    SEED_DEMO: 'false',
    TURNSTILE_SOLVER: 'none',
    DASHBOARD_TURNSTILE_SITE_KEY: '',
    DASHBOARD_TURNSTILE_SECRET_KEY: '',
    MONITOR_TICK_MS: '3600000',
  });
  const { child, baseUrl } = serverProcess;

  let cookie = '';
  const request = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...options,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };

  try {
    let result = await request('/api/session/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'OpsOwner', password: 'Strong-Console-Password9!' }),
    });
    assert.equal(result.response.status, 200);

    result = await request('/api/upstreams', {
      method: 'POST',
      body: JSON.stringify({ name: 'Notify Provider', proxyMode: 'direct' }),
    });
    assert.equal(result.response.status, 201);
    const upstreamId = result.body.upstream.id;

    result = await request('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        upstreamId,
        name: 'Patch Target',
        type: 'newapi',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        region: 'test',
        authMode: 'api_token',
        balancePath: 'data.quota',
        formula: 'x',
        rawUnit: 'quota',
        thresholdLow: 10,
        thresholdRecover: 20,
        notifications: { resend: false, feishu: false, telegram: false, wecom: false },
        credentials: { apiToken: 'sk-patch-target' },
      }),
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    const accountId = result.body.account.id;
    assert.deepEqual(result.body.account.notifications, { resend: false, feishu: false, telegram: false, wecom: false });

    // 只提交一个渠道：其余渠道必须保持原状，不能被 schema 默认值重置为开启。
    result = await request(`/api/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notifications: { resend: true } }),
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.account.notifications, { resend: true, feishu: false, telegram: false, wecom: false });

    // 不带 notifications 的 PATCH 不得触碰开关。
    result = await request(`/api/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ thresholdLow: 15 }),
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body.account.notifications, { resend: true, feishu: false, telegram: false, wecom: false });
  } finally {
    await stopTestServer(child);
    upstream.close();
    await once(upstream, 'close');
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
