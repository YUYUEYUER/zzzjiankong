import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from 'otplib';
import {
  consumeRecoveryCode,
  createSessionToken,
  createTotpEnrollment,
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  passwordIssues,
  verifyPassword,
  verifySessionToken,
  verifyTotpCode,
  verifyTurnstileToken,
} from '../server/security.js';
import { config } from '../server/config.js';

test('strong passwords are hashed with bcrypt and weak passwords are rejected', async () => {
  assert.ok(passwordIssues('weak').length >= 4);
  const hash = await hashPassword('Strong-Console-Password9!');
  assert.match(hash, /^\$2[aby]\$12\$/);
  assert.equal(await verifyPassword('Strong-Console-Password9!', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
});

test('sessions are bound to the username and session version', () => {
  const auth = { username: 'Owner', usernameCanonical: 'owner', passwordHash: 'hash', sessionVersion: 3 };
  const token = createSessionToken(auth);
  assert.equal(verifySessionToken(token, auth), true);
  assert.equal(verifySessionToken(token, { ...auth, sessionVersion: 4 }), false);
  assert.equal(verifySessionToken(token, { ...auth, usernameCanonical: 'other' }), false);
});

test('TOTP enrollment verifies authenticator codes', async () => {
  const enrollment = createTotpEnrollment('Owner');
  const code = await generate({ secret: enrollment.secret });
  assert.equal(await verifyTotpCode(enrollment.secret, code), true);
  assert.equal(await verifyTotpCode(enrollment.secret, '000000'), false);
});

test('recovery codes are one-time and stored as hashes', () => {
  const codes = generateRecoveryCodes(2);
  const hashes = codes.map(hashRecoveryCode);
  assert.notEqual(hashes[0], codes[0]);
  const used = consumeRecoveryCode(codes[0], hashes);
  assert.equal(used.valid, true);
  assert.equal(used.hashes.length, 1);
  assert.equal(consumeRecoveryCode(codes[0], used.hashes).valid, false);
});

test('Turnstile is always verified through Cloudflare Siteverify when enabled', async () => {
  const originalFetch = global.fetch;
  const previous = {
    enabled: config.dashboardTurnstileEnabled,
    secret: config.dashboardTurnstileSecretKey,
  };
  config.dashboardTurnstileEnabled = true;
  config.dashboardTurnstileSecretKey = 'turnstile-secret';
  let posted = '';
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    posted = String(options.body);
    return new Response(JSON.stringify({ success: true, action: 'login' }), { status: 200 });
  };
  try {
    const result = await verifyTurnstileToken('single-use-token', '127.0.0.1', 'login');
    assert.equal(result.success, true);
    assert.match(posted, /secret=turnstile-secret/);
    assert.match(posted, /response=single-use-token/);
  } finally {
    global.fetch = originalFetch;
    config.dashboardTurnstileEnabled = previous.enabled;
    config.dashboardTurnstileSecretKey = previous.secret;
  }
});
