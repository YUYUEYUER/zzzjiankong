import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generate } from 'otplib';

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('test server did not start');
}

test('first setup, TOTP enablement, login challenge, and recovery code form a complete auth flow', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-security-'));
  const port = 19000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: path.join(dir, 'db.json'),
      MASTER_KEY: 'integration-master-key-with-more-than-32-characters',
      SESSION_SECRET: 'integration-session-secret-with-more-than-32-characters',
      ADMIN_PASSWORD: '',
      AUTH_DISABLED: 'false',
      SEED_DEMO: 'false',
      TURNSTILE_SOLVER: 'none',
      DASHBOARD_TURNSTILE_SITE_KEY: '',
      DASHBOARD_TURNSTILE_SECRET_KEY: '',
    },
    stdio: 'ignore',
  });
  let cookie = '';
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...options,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };

  try {
    await waitForServer(base, child);
    let result = await request('/api/session');
    assert.equal(result.body.setupRequired, true);

    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password: 'weak' }) });
    assert.equal(result.response.status, 400);

    const password = 'Strong-Console-Password9!';
    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    assert.equal(result.response.status, 201);
    assert.ok(cookie.includes('frosted_session='));

    result = await request('/api/security/2fa/setup', { method: 'POST', body: '{}' });
    assert.equal(result.response.status, 200);
    assert.match(result.body.qrCodeDataUrl, /^data:image\/png;base64,/);
    const secret = result.body.secret;
    const firstCode = await generate({ secret });

    result = await request('/api/security/2fa/enable', { method: 'POST', body: JSON.stringify({ code: firstCode }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.recoveryCodes.length, 8);
    const recoveryCode = result.body.recoveryCodes[0];

    await request('/api/session/logout', { method: 'POST', body: '{}' });
    cookie = '';
    result = await request('/api/session/login', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    assert.equal(result.body.requiresTwoFactor, true);
    assert.ok(result.body.challengeToken);

    const secondCode = await generate({ secret });
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: result.body.challengeToken, code: secondCode }) });
    assert.equal(result.response.status, 200);
    assert.ok(cookie.includes('frosted_session='));

    await request('/api/session/logout', { method: 'POST', body: '{}' });
    cookie = '';
    result = await request('/api/session/login', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: result.body.challengeToken, code: recoveryCode }) });
    assert.equal(result.response.status, 200);
    result = await request('/api/security');
    assert.equal(result.body.recoveryCodesRemaining, 7);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
