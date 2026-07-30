import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  browserCookiesFromHeader,
  buildSystemBrowserArgs,
  clearStaleBrowserLocks,
  extractSub2SessionTokens,
  startUpstreamLogin,
} from '../server/upstream-login.js';

test('interactive Sub2 browser capture accepts explicit auth/access and refresh token fields', () => {
  assert.deepEqual(extractSub2SessionTokens({
    data: {
      auth_token: 'browser-access-token',
      refreshToken: 'browser-refresh-token',
    },
  }), {
    accessToken: 'browser-access-token',
    refreshToken: 'browser-refresh-token',
  });

  assert.deepEqual(extractSub2SessionTokens(JSON.stringify({
    access_token: 'response-access-token',
    refresh_token: 'response-refresh-token',
  })), {
    accessToken: 'response-access-token',
    refreshToken: 'response-refresh-token',
  });
});

test('interactive browser capture excludes generic challenge tokens and rejects invalid targets', () => {
  assert.deepEqual(extractSub2SessionTokens({ token: 'two-factor-challenge', temp_token: 'temporary' }), {});
  assert.throws(
    () => startUpstreamLogin({ type: 'newapi', baseUrl: 'https://example.com' }),
    /仅支持 Sub2API/,
  );
  assert.throws(
    () => startUpstreamLogin({ type: 'sub2api', baseUrl: 'ftp://example.com' }),
    /HTTP\(S\)/,
  );
});

test('interactive login launches a visible system browser with an isolated loopback session', () => {
  const args = buildSystemBrowserArgs({
    origin: 'https://sub2.example.com',
    profilePath: 'C:\\isolated-profile',
  }, 19091);
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--start-maximized'));
  assert.ok(args.includes('--new-window'));
  assert.ok(args.includes('--user-data-dir=C:\\isolated-profile'));
  assert.ok(!args.some((arg) => /headless|enable-automation/i.test(arg)));
});

test('saved browser sessions open the upstream root and restore cookie values without exposing headers', () => {
  const args = buildSystemBrowserArgs({
    origin: 'https://sub2.example.com',
    profilePath: 'C:\\isolated-profile',
    targetUrl: 'https://sub2.example.com/',
  }, 19092);
  assert.equal(args.at(-1), 'https://sub2.example.com/');
  assert.deepEqual(browserCookiesFromHeader('https://sub2.example.com', 'session=abc=123; theme=dark; invalid name=x'), [
    { name: 'session', value: 'abc=123', url: 'https://sub2.example.com/' },
    { name: 'theme', value: 'dark', url: 'https://sub2.example.com/' },
  ]);
});

test('browser restart removes only stale Chrome process locks from a persistent profile', async () => {
  const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-browser-profile-'));
  try {
    await Promise.all([
      fs.writeFile(path.join(profilePath, 'SingletonLock'), 'stale'),
      fs.writeFile(path.join(profilePath, 'SingletonCookie'), 'stale'),
      fs.writeFile(path.join(profilePath, 'SingletonSocket'), 'stale'),
      fs.writeFile(path.join(profilePath, 'DevToolsActivePort'), 'stale'),
      fs.writeFile(path.join(profilePath, 'Preferences'), '{"kept":true}'),
    ]);
    await clearStaleBrowserLocks(profilePath);
    assert.deepEqual((await fs.readdir(profilePath)).sort(), ['Preferences']);
  } finally {
    await fs.rm(profilePath, { recursive: true, force: true });
  }
});
