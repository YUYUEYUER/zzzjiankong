import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../server/config.js';
import {
  browserCookiesFromHeader,
  buildSystemBrowserArgs,
  cancelUpstreamLogin,
  clearStaleBrowserLocks,
  createBrowserProfileId,
  extractSub2SessionTokens,
  getUpstreamLogin,
  normalizeBrowserProxyServer,
  shutdownUpstreamLogins,
  startUpstreamBrowserSession,
  startUpstreamLogin,
  sweepExpiredUpstreamLogins,
  validateBrowserProfileId,
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
  assert.ok(args.includes('--disable-quic'));
  assert.ok(args.includes('--user-data-dir=C:\\isolated-profile'));
  assert.ok(!args.some((arg) => /headless|enable-automation/i.test(arg)));
});

test('browser proxy arguments disable direct QUIC, loopback bypass, DNS prefetch, and WebRTC UDP', () => {
  const args = buildSystemBrowserArgs({
    origin: 'https://sub2.example.com',
    profilePath: 'C:\\isolated-profile',
    proxyServer: 'http://mihomo:17890',
  }, 19093);
  assert.ok(args.includes('--proxy-server=http://mihomo:17890'));
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(args.includes('--disable-quic'));
  assert.ok(args.includes('--dns-prefetch-disable'));
  assert.ok(args.includes('--disable-features=AsyncDns'));
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.equal(normalizeBrowserProxyServer('socks5://proxy.example.com:1080/'), 'socks5://proxy.example.com:1080');
  assert.throws(() => normalizeBrowserProxyServer('http://user:secret@proxy.example.com:8080'), /不含凭据/);
  assert.throws(() => normalizeBrowserProxyServer('file:///tmp/proxy'), /仅支持/);
});

test('direct browser sessions pin the validated upstream address', () => {
  const args = buildSystemBrowserArgs({
    origin: 'https://sub2.example.com',
    targetUrl: 'https://sub2.example.com/login',
    profilePath: 'C:\\isolated-profile',
    resolvedAddresses: [{ address: '93.184.216.34', family: 4 }],
  }, 19094);
  assert.ok(args.includes('--host-resolver-rules=MAP sub2.example.com 93.184.216.34, EXCLUDE localhost'));
});

test('browser profile identifiers are random, path-safe, and accept legacy saved identifiers', () => {
  const first = createBrowserProfileId();
  const second = createBrowserProfileId();
  assert.match(first, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(first, second);
  assert.equal(validateBrowserProfileId(first), first);
  assert.equal(validateBrowserProfileId('0123456789abcdef01234567'), '0123456789abcdef01234567');
  for (const invalid of ['', 'too-short', '../profile-id-that-is-invalid', ' profile-id-that-is-24xx ', 'profile.id.that.is.not.safe']) {
    assert.throws(() => validateBrowserProfileId(invalid), /资料标识无效/);
  }
  assert.throws(() => startUpstreamBrowserSession({
    type: 'sub2api',
    baseUrl: 'https://sub2.example.com',
  }), /资料标识无效/);
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

test('saved profiles are locked independently, globally capped, and proactively reclaimed at absolute TTL', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-browser-jobs-'));
  const previous = {
    dataFile: config.dataFile,
    upstreamBrowserMaxActive: config.upstreamBrowserMaxActive,
    upstreamBrowserAbsoluteTtlMs: config.upstreamBrowserAbsoluteTtlMs,
  };
  config.dataFile = path.join(tempDir, 'db.json');
  config.upstreamBrowserMaxActive = 1;
  config.upstreamBrowserAbsoluteTtlMs = 10 * 60_000;
  try {
    const profile = createBrowserProfileId();
    const job = startUpstreamBrowserSession({
      type: 'sub2api',
      baseUrl: 'https://sub2.example.com',
      browserProfileId: profile,
      proxyServer: 'http://mihomo:17890',
    });
    const reused = startUpstreamBrowserSession({
      type: 'sub2api',
      baseUrl: 'https://sub2.example.com/path',
      browserProfileId: profile,
      proxyServer: 'http://mihomo:17890',
    });
    assert.equal(reused.id, job.id);
    assert.throws(() => startUpstreamBrowserSession({
      type: 'sub2api',
      baseUrl: 'https://other.example.com',
      browserProfileId: profile,
      proxyServer: 'http://mihomo:17890',
    }), (error) => error.statusCode === 409);
    assert.throws(() => startUpstreamBrowserSession({
      type: 'sub2api',
      baseUrl: 'https://sub2.example.com',
      browserProfileId: profile,
    }), (error) => error.statusCode === 409);
    assert.throws(() => startUpstreamBrowserSession({
      type: 'sub2api',
      baseUrl: 'https://sub2.example.com',
      browserProfileId: createBrowserProfileId(),
      proxyServer: 'http://mihomo:17890',
    }), (error) => error.statusCode === 429);

    assert.equal(await sweepExpiredUpstreamLogins(Date.parse(job.expiresAt) + 1), 1);
    assert.equal(getUpstreamLogin(job.id).status, 'expired');

    const replacement = startUpstreamBrowserSession({
      type: 'sub2api',
      baseUrl: 'https://sub2.example.com',
      browserProfileId: createBrowserProfileId(),
      proxyServer: 'http://mihomo:17890',
    });
    assert.notEqual(replacement.id, job.id);
    await cancelUpstreamLogin(replacement.id);

    config.upstreamBrowserMaxActive = 2;
    const firstLogin = startUpstreamLogin({ type: 'sub2api', baseUrl: 'https://sub2.example.com' });
    const secondLogin = startUpstreamLogin({ type: 'sub2api', baseUrl: 'https://sub2.example.com' });
    assert.notEqual(firstLogin.id, secondLogin.id, 'same-origin accounts must receive independent login jobs');
    await Promise.all([cancelUpstreamLogin(firstLogin.id), cancelUpstreamLogin(secondLogin.id)]);
  } finally {
    await shutdownUpstreamLogins();
    config.dataFile = previous.dataFile;
    config.upstreamBrowserMaxActive = previous.upstreamBrowserMaxActive;
    config.upstreamBrowserAbsoluteTtlMs = previous.upstreamBrowserAbsoluteTtlMs;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
