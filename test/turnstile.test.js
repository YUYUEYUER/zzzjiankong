import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  consumeOneShotTurnstileToken,
  detectTurnstileChallenge,
  discoverTurnstileSiteKey,
  extractSiteKeyFromText,
  getTurnstileSolverStatus,
  isTurnstileFailure,
  TURNSTILE_TOKEN_TTL_MS,
  turnstileTokenState,
  withTurnstileBrowserSlot,
  withTurnstileOriginLock,
} from '../server/turnstile.js';
import { isCloudflareChallenge } from '../server/collectors.js';
import {
  browserSelectors,
  extractSubmittedTurnstileToken,
  extractLoginTokensFromPayload,
  isUpstreamLoginEndpoint,
  isSuccessfulLoginPayload,
  isVerifiedProfilePayload,
  resolveUpstreamUrl,
} from '../server/turnstile-browser.js';

test('detects TURNSTILE_VERIFICATION_FAILED reason', () => {
  assert.equal(isTurnstileFailure({ reason: 'TURNSTILE_VERIFICATION_FAILED' }), true);
  assert.equal(isTurnstileFailure({ message: 'invalid password' }), false);
  assert.equal(isTurnstileFailure({}, 'Cloudflare captcha required'), true);
  assert.equal(isTurnstileFailure({ error: '人机验证失败' }), true);
});

test('extracts turnstile sitekey from HTML and JS snippets', () => {
  const html = '<div class="cf-turnstile" data-sitekey="0x4AAAAAAAbCdEfGhIjKlMnOp"></div>';
  assert.equal(extractSiteKeyFromText(html), '0x4AAAAAAAbCdEfGhIjKlMnOp');

  const js = 'const cfg={siteKey:"0x4AAAAAAAxYz1234567890abcd",mode:"managed"}';
  assert.equal(extractSiteKeyFromText(js), '0x4AAAAAAAxYz1234567890abcd');

  const envStyle = 'VITE_TURNSTILE_SITE_KEY="0x4AAAAAAAEnvStyleKey000001"';
  assert.equal(extractSiteKeyFromText(envStyle), '0x4AAAAAAAEnvStyleKey000001');

  assert.equal(extractSiteKeyFromText('no key here'), '');
});

test('discovers the New API sitekey from the public status endpoint', async () => {
  const siteKey = '0x4AAAAAAAStatusEndpointKey001';
  const server = http.createServer((req, res) => {
    if (req.url === '/tenant/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: { turnstile_check: true, turnstile_site_key: siteKey },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address();
    const discovered = await discoverTurnstileSiteKey(
      `http://127.0.0.1:${address.port}/tenant`,
      { skipCache: true, timeoutMs: 2000 },
    );
    assert.equal(discovered, siteKey);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
});

test('solver status: browser enabled without api key', () => {
  assert.deepEqual(getTurnstileSolverStatus({ turnstileSolver: 'none', turnstileSolverApiKey: '' }), {
    enabled: false,
    provider: 'none',
    mode: 'off',
  });
  assert.equal(getTurnstileSolverStatus({ turnstileSolver: 'browser', turnstileHeadless: true }).enabled, true);
  assert.equal(getTurnstileSolverStatus({ turnstileSolver: 'browser' }).provider, 'browser');
  assert.equal(getTurnstileSolverStatus({ turnstileSolver: 'browser' }).mode, 'dom_human');
  assert.deepEqual(getTurnstileSolverStatus({ turnstileSolver: 'capsolver', turnstileSolverApiKey: '' }), {
    enabled: false,
    provider: 'none',
    mode: 'off',
  });
  assert.deepEqual(getTurnstileSolverStatus({ turnstileSolver: 'capsolver', turnstileSolverApiKey: 'sk-test' }), {
    enabled: true,
    provider: 'capsolver',
    mode: 'api',
  });
});

test('browser selector packs cover turnstile and login fields', () => {
  assert.ok(browserSelectors.TURNSTILE_HOST_SELECTORS.some((s) => s.includes('cf-turnstile')));
  assert.ok(browserSelectors.TOKEN_INPUT_SELECTORS.some((s) => s.includes('cf-turnstile-response')));
  assert.ok(browserSelectors.EMAIL_SELECTORS.some((s) => s.includes('email')));
  assert.ok(browserSelectors.PASSWORD_SELECTORS.some((s) => s.includes('password')));
  assert.ok(browserSelectors.SUBMIT_SELECTORS.length >= 3);
});

test('isCloudflareChallenge covers pages and turnstile bodies', () => {
  assert.equal(isCloudflareChallenge(new Error('上游返回了 Cloudflare 挑战页而非 JSON (403)')), true);
  assert.equal(isCloudflareChallenge({ reason: 'TURNSTILE_VERIFICATION_FAILED' }), true);
  assert.equal(isCloudflareChallenge(new Error('余额字段无效')), false);
});

test('classifies Cloudflare challenge responses without treating ordinary failures as challenges', async () => {
  const mitigated = new Response('<html>challenge</html>', {
    status: 403,
    headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
  });
  assert.deepEqual(
    detectTurnstileChallenge({ response: mitigated, text: '<html>challenge</html>' }),
    { detected: true, source: 'cf-mitigated', status: 403, contentType: 'text/html' },
  );

  const html = new Response('<script src="/cdn-cgi/challenge-platform/h/g/orchestrate"></script>', {
    status: 503,
    headers: { 'content-type': 'text/html', server: 'cloudflare' },
  });
  assert.equal(detectTurnstileChallenge({ response: html, text: await html.text() }).source, 'html');

  for (const status of [403, 429]) {
    const ordinary = new Response(JSON.stringify({ message: 'quota rejected' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(detectTurnstileChallenge({ response: ordinary, body: { message: 'quota rejected' } }).detected, false);
  }

  const successfulFeatureMessage = new Response(JSON.stringify({
    success: true,
    message: 'Turnstile is enabled for password login',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal(detectTurnstileChallenge({
    response: successfulFeatureMessage,
    body: { success: true, message: 'Turnstile is enabled for password login' },
  }).detected, false);
});

test('turnstile token lifecycle enforces single use and the five-minute boundary', () => {
  const current = Date.now();
  const token = 'turnstile-token-with-enough-entropy-123456';
  assert.equal(turnstileTokenState({
    token,
    tokenObtainedAt: new Date(current - TURNSTILE_TOKEN_TTL_MS + 1).toISOString(),
    tokenConsumed: false,
  }, current).usable, true);
  assert.equal(turnstileTokenState({
    token,
    tokenObtainedAt: new Date(current - TURNSTILE_TOKEN_TTL_MS).toISOString(),
    tokenConsumed: false,
  }, current).reason, 'expired');
  assert.equal(turnstileTokenState({
    token,
    tokenObtainedAt: new Date(current).toISOString(),
    tokenConsumed: true,
  }, current).reason, 'already_consumed');

  const manual = 'manual-turnstile-token-with-enough-entropy-123456';
  assert.equal(consumeOneShotTurnstileToken(manual, current), true);
  assert.equal(consumeOneShotTurnstileToken(manual, current + 1), false);
  assert.equal(consumeOneShotTurnstileToken(manual, current + TURNSTILE_TOKEN_TTL_MS), true);
});

test('browser login parser accepts only explicit access tokens and explicit success', () => {
  assert.deepEqual(extractLoginTokensFromPayload({ data: { token: 'two-factor-challenge' } }), {
    accessToken: '',
    refreshToken: '',
  });
  assert.equal(isSuccessfulLoginPayload(200, { data: { token: 'two-factor-challenge' } }), false);
  assert.equal(isSuccessfulLoginPayload(200, { success: true, data: {} }), true);
  assert.equal(isSuccessfulLoginPayload(200, { success: true, data: { require_2fa: true } }), false);
  assert.equal(isSuccessfulLoginPayload(401, { success: true }), false);
  assert.equal(isSuccessfulLoginPayload(200, { success: false, access_token: 'not-valid' }), false);
  assert.equal(isSuccessfulLoginPayload(200, { code: 401, access_token: 'not-valid' }), false);
  assert.equal(isSuccessfulLoginPayload(200, { error: 'invalid credentials', access_token: 'not-valid' }), false);
  assert.equal(isSuccessfulLoginPayload(200, { reason: 'blocked', access_token: 'not-valid' }), false);
  assert.equal(isUpstreamLoginEndpoint(
    'https://upstream.example.com/api/user/login',
    'https://upstream.example.com',
    'newapi',
  ), true);
  assert.equal(
    resolveUpstreamUrl('https://upstream.example.com/subpath', '/api/user/self').toString(),
    'https://upstream.example.com/subpath/api/user/self',
  );
  assert.equal(isUpstreamLoginEndpoint(
    'https://attacker.example.com/api/user/login',
    'https://upstream.example.com',
    'newapi',
  ), false);
  assert.equal(isUpstreamLoginEndpoint(
    'https://upstream.example.com/subpath/api/v1/auth/login',
    'https://upstream.example.com/subpath',
    'sub2api',
  ), true);
  assert.equal(isVerifiedProfilePayload('newapi', { success: true, data: { quota: '500000' } }, 'data.quota'), true);
  assert.equal(isVerifiedProfilePayload('newapi', { code: 401, data: { quota: 0 } }, 'data.quota'), false);
  assert.equal(isVerifiedProfilePayload('newapi', { error: 'unauthorized' }, 'data.quota'), false);
  assert.equal(isVerifiedProfilePayload('newapi', { success: true, data: { quota: null } }, 'data.quota'), false);
  assert.equal(isVerifiedProfilePayload('newapi', { success: true, data: { quota: '' } }, 'data.quota'), false);
  assert.equal(isVerifiedProfilePayload('newapi', { success: true, data: { quota: false } }, 'data.quota'), false);
});

test('submitted token parser covers JSON, URL-encoded, and multipart login requests', () => {
  const token = 'turnstile-token-with-enough-entropy-123456';
  assert.equal(extractSubmittedTurnstileToken(
    '',
    '',
    `https://upstream.example.com/api/user/login?turnstile=${encodeURIComponent(token)}`,
  ), token);
  assert.equal(extractSubmittedTurnstileToken(
    JSON.stringify({ cf_turnstile_response: token }),
    'application/json',
  ), token);
  assert.equal(extractSubmittedTurnstileToken(
    `email=a%40b.test&cf-turnstile-response=${encodeURIComponent(token)}`,
    'application/x-www-form-urlencoded',
  ), token);
  assert.equal(extractSubmittedTurnstileToken(
    `--boundary\r\nContent-Disposition: form-data; name="turnstile_token"\r\n\r\n${token}\r\n--boundary--\r\n`,
    'multipart/form-data; boundary=boundary',
  ), token);
});

test('turnstile solves are serialized per upstream origin and the lock releases after errors', async () => {
  const events = [];
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = withTurnstileOriginLock('https://upstream.example.com/login', async () => {
    events.push('first:start');
    markStarted();
    await gate;
    events.push('first:end');
  });
  await started;
  const second = withTurnstileOriginLock('https://upstream.example.com/profile', async () => {
    events.push('second:start');
  });
  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);

  await assert.rejects(
    withTurnstileOriginLock('https://error.example.com', async () => { throw new Error('expected'); }),
    /expected/,
  );
  assert.equal(await withTurnstileOriginLock('https://error.example.com/again', async () => 42), 42);
});

test('browser solve concurrency is bounded globally', async () => {
  const events = [];
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withTurnstileBrowserSlot(async () => {
    events.push('first:start');
    markStarted();
    await gate;
    events.push('first:end');
  }, 1);
  await started;
  const second = withTurnstileBrowserSlot(async () => {
    events.push('second:start');
  }, 1);
  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('browser solve queue rejects excess work instead of growing without bound', async () => {
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withTurnstileBrowserSlot(async () => {
    markStarted();
    await gate;
  }, 1, 1);
  await started;
  const second = withTurnstileBrowserSlot(async () => 'queued', 1, 1);
  await assert.rejects(
    withTurnstileBrowserSlot(async () => 'overflow', 1, 1),
    (error) => error.code === 'TURNSTILE_SOLVER_BUSY',
  );
  releaseFirst();
  await first;
  assert.equal(await second, 'queued');
});
