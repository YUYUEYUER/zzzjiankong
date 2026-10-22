import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, stopTestServer } from './helpers/server-process.js';

const PASSWORD = 'Strong-Console-Password9!';
const APP_ORIGIN = 'https://panel.example.test';

function cookieValue(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function startAuthServer({ initialized = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-auth-hardening-'));
  const serverProcess = await startTestServer({
    DATA_FILE: path.join(dir, 'db.json'),
    NODE_ENV: initialized ? 'development' : 'production',
    APP_ORIGIN,
    TRUST_PROXY: 'true',
    MASTER_KEY: 'auth-hardening-master-key-with-more-than-32-characters',
    SESSION_SECRET: 'auth-hardening-session-secret-with-more-than-32-characters',
    ADMIN_USERNAME: initialized ? 'admin' : '',
    ADMIN_PASSWORD: initialized ? PASSWORD : '',
    BOOTSTRAP_TOKEN: initialized ? '' : 'auth-hardening-bootstrap-token-with-more-than-32-characters',
    AUTH_DISABLED: 'false',
    SEED_DEMO: 'false',
    TURNSTILE_SOLVER: 'none',
    DASHBOARD_TURNSTILE_SITE_KEY: '',
    DASHBOARD_TURNSTILE_SECRET_KEY: '',
  });
  return { dir, ...serverProcess };
}

test('state-changing requests require the exact configured scheme and secure cookies follow HTTPS app origin', async () => {
  const server = await startAuthServer();
  try {
    const login = await fetch(`${server.baseUrl}/api/session/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
        Host: 'panel.example.test',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieValue(login);
    assert.match(String(login.headers.get('set-cookie')), /Secure/);
    assert.match(String(login.headers.get('set-cookie')), /HttpOnly/);
    assert.match(String(login.headers.get('set-cookie')), /SameSite=Strict/);

    const blocked = await fetch(`${server.baseUrl}/api/upstreams`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: 'http://panel.example.test',
        Host: 'panel.example.test',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ name: 'blocked-origin', proxyMode: 'direct' }),
    });
    assert.equal(blocked.status, 403);

    const allowed = await fetch(`${server.baseUrl}/api/upstreams`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: APP_ORIGIN,
        Host: 'panel.example.test',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ name: 'allowed-origin', proxyMode: 'direct' }),
    });
    assert.equal(allowed.status, 201);
  } finally {
    await stopTestServer(server.child);
    await fs.rm(server.dir, { recursive: true, force: true });
  }
});

test('bootstrap setup attempts are rate limited per IP and username', async () => {
  const server = await startAuthServer({ initialized: false });
  try {
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${server.baseUrl}/api/session/setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: APP_ORIGIN,
          Host: 'panel.example.test',
          'X-Forwarded-Proto': 'https',
        },
        body: JSON.stringify({
          username: 'admin',
          password: PASSWORD,
          bootstrapToken: 'wrong-bootstrap-token',
        }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
  } finally {
    await stopTestServer(server.child);
    await fs.rm(server.dir, { recursive: true, force: true });
  }
});

test('two-factor enrollment attempts are rate limited', async () => {
  const server = await startAuthServer();
  try {
    const login = await fetch(`${server.baseUrl}/api/session/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
        Host: 'panel.example.test',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = cookieValue(login);
    const statuses = [];
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(`${server.baseUrl}/api/security/2fa/setup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: APP_ORIGIN,
          Host: 'panel.example.test',
          'X-Forwarded-Proto': 'https',
        },
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  } finally {
    await stopTestServer(server.child);
    await fs.rm(server.dir, { recursive: true, force: true });
  }
});
