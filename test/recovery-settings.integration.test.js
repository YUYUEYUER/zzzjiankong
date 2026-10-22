import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, stopTestServer } from './helpers/server-process.js';

test('recovery settings persist custom counts from 1 through 100 and reject invalid values without changing settings', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-recovery-settings-'));
  const password = `Test-${crypto.randomBytes(24).toString('hex')}!`;
  let child;
  try {
    const server = await startTestServer({
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      DATA_FILE: path.join(tempDir, 'db.json'),
      MASTER_KEY: crypto.randomBytes(32).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      ADMIN_USERNAME: 'RecoveryTest',
      ADMIN_PASSWORD: password,
      AUTH_DISABLED: 'false',
      SEED_DEMO: 'false',
      TURNSTILE_SOLVER: 'none',
      DASHBOARD_TURNSTILE_SITE_KEY: '',
      DASHBOARD_TURNSTILE_SECRET_KEY: '',
      MONITOR_TICK_MS: '3600000',
    });
    child = server.child;
    let cookie = '';
    const request = async (route, options = {}) => {
      const response = await fetch(`${server.baseUrl}${route}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
      });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      return { status: response.status, body: await response.json() };
    };

    const login = await request('/api/session/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'RecoveryTest', password }),
    });
    assert.equal(login.status, 200);
    const initial = await request('/api/dashboard');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.recoveryConfirmations, 2);
    const settings = initial.body.settings;

    for (const recoveryConfirmations of [1, 4, 7, 100]) {
      const saved = await request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...settings, recoveryConfirmations }),
      });
      assert.equal(saved.status, 200, `saving ${recoveryConfirmations} confirmations`);
      assert.equal(saved.body.settings.recoveryConfirmations, recoveryConfirmations);
      const reloaded = await request('/api/dashboard');
      assert.equal(reloaded.body.settings.recoveryConfirmations, recoveryConfirmations);
    }

    for (const recoveryConfirmations of ['', 0, -1, 1.5, 101, 'invalid', null, undefined]) {
      const rejected = await request('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ ...settings, recoveryConfirmations }),
      });
      assert.equal(rejected.status, 400, `rejecting ${String(recoveryConfirmations)}`);
      assert.ok(rejected.body.issues.some((issue) => issue.path.includes('recoveryConfirmations')));
      const unchanged = await request('/api/dashboard');
      assert.equal(unchanged.body.settings.recoveryConfirmations, 100);
    }
  } finally {
    if (child) await stopTestServer(child);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
