import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generate } from 'otplib';
import { startTestServer, stopTestServer } from './helpers/server-process.js';

test('first setup, TOTP enablement, login challenge, and recovery code form a complete auth flow', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-security-'));
  const serverProcess = await startTestServer({
      DATA_FILE: path.join(dir, 'db.json'),
      MASTER_KEY: 'integration-master-key-with-more-than-32-characters',
      SESSION_SECRET: 'integration-session-secret-with-more-than-32-characters',
      ADMIN_PASSWORD: '',
      BOOTSTRAP_TOKEN: 'test-bootstrap-token-with-more-than-32-characters',
      AUTH_DISABLED: 'false',
      SEED_DEMO: 'false',
      TURNSTILE_SOLVER: 'none',
      DASHBOARD_TURNSTILE_SITE_KEY: '',
      DASHBOARD_TURNSTILE_SECRET_KEY: '',
  });
  const { child, baseUrl: base } = serverProcess;
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
    let result = await request('/api/session');
    assert.equal(result.body.setupRequired, true);
    assert.equal(result.body.bootstrapRequired, true);
    assert.equal(JSON.stringify(result.body).includes('test-bootstrap-token'), false);

    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password: 'weak' }) });
    assert.equal(result.response.status, 400);

    const password = 'Strong-Console-Password9!';
    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    assert.equal(result.response.status, 403);
    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password, bootstrapToken: 'wrong-token' }) });
    assert.equal(result.response.status, 403);
    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password, bootstrapToken: 'test-bootstrap-token-with-more-than-32-characters' }) });
    assert.equal(result.response.status, 201);
    assert.ok(cookie.includes('frosted_session='));
    const activeCookie = cookie;
    result = await fetch(`${base}/api/session/logout`, { method: 'POST', headers: { Cookie: 'frosted_session=invalid-token' } });
    assert.equal(result.status, 200);
    result = await fetch(`${base}/api/security`, { headers: { Cookie: activeCookie } });
    assert.equal(result.status, 200);
    result = await request('/api/session/setup', { method: 'POST', body: JSON.stringify({ username: 'OtherOwner', password, bootstrapToken: 'test-bootstrap-token-with-more-than-32-characters' }) });
    assert.equal(result.response.status, 410);

    result = await request('/api/security/2fa/setup', { method: 'POST', body: '{}' });
    assert.equal(result.response.status, 200);
    assert.match(result.body.qrCodeDataUrl, /^data:image\/png;base64,/);
    const secret = result.body.secret;
    const firstCode = await generate({ secret });

    result = await request('/api/security/2fa/enable', { method: 'POST', body: JSON.stringify({ code: firstCode }) });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.recoveryCodes.length, 8);
    const recoveryCode = result.body.recoveryCodes[0];

    const cookieBeforeLogout = cookie;
    await request('/api/session/logout', { method: 'POST', body: '{}' });
    result = await fetch(`${base}/api/dashboard`, { headers: { Cookie: cookieBeforeLogout } });
    assert.equal(result.status, 401);
    cookie = '';
    result = await request('/api/session/login', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    assert.equal(result.body.requiresTwoFactor, true);
    assert.ok(result.body.challengeToken);
    const totpChallenge = result.body.challengeToken;

    const secondCode = await generate({ secret });
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: totpChallenge, code: secondCode }) });
    assert.equal(result.response.status, 200);
    assert.ok(cookie.includes('frosted_session='));
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: totpChallenge, code: secondCode }) });
    assert.equal(result.response.status, 401);

    await request('/api/session/logout', { method: 'POST', body: '{}' });
    cookie = '';
    result = await request('/api/session/login', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: result.body.challengeToken, code: secondCode }) });
    assert.equal(result.response.status, 401);
    result = await request('/api/session/login', { method: 'POST', body: JSON.stringify({ username: 'OpsOwner', password }) });
    const recoveryChallenge = result.body.challengeToken;
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: recoveryChallenge, code: recoveryCode }) });
    assert.equal(result.response.status, 200);
    result = await request('/api/session/verify-2fa', { method: 'POST', body: JSON.stringify({ challengeToken: recoveryChallenge, code: await generate({ secret }) }) });
    assert.equal(result.response.status, 401);
    result = await request('/api/security');
    assert.equal(result.body.recoveryCodesRemaining, 7);
  } finally {
    await stopTestServer(child);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
