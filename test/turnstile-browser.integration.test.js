import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { collectBalance } from '../server/collectors.js';
import { config } from '../server/config.js';
import { browserSolveTurnstile } from '../server/turnstile-browser.js';

const challengeToken = 'mock-turnstile-token-with-enough-entropy-123456789';
const upstreamPrefix = '/tenant';

function loginPage(observerUrl, loginPath) {
  return `<!doctype html>
  <html lang="zh-CN">
    <body>
      <img src="${observerUrl}/pixel" alt="" />
      <form id="login-form">
        <input type="email" name="email" />
        <input type="password" name="password" />
        <input type="hidden" name="cf-turnstile-response" value="${challengeToken}" />
        <button type="submit">登录</button>
      </form>
      <script>
        document.querySelector('#login-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const response = await fetch('${loginPath}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: document.querySelector('[name="email"]').value,
              password: document.querySelector('[name="password"]').value,
              cf_turnstile_response: document.querySelector('[name="cf-turnstile-response"]').value,
            }),
          });
          const body = await response.json();
          document.body.dataset.login = body.success ? 'ok' : 'failed';
        });
      </script>
    </body>
  </html>`;
}

test('browser solver verifies sessions and preserves explicit tokens across profile failure', { timeout: 180000 }, async () => {
  let loginCalls = 0;
  let profileCalls = 0;
  let returnExplicitTokens = false;
  let profileFailure = false;
  let protectProfileWithCf = false;
  let interstitialResponses = 0;
  let profileInterstitialResponses = 0;
  let crossOriginHeaders = null;
  const originalSolveTimeout = config.turnstileSolveTimeoutMs;
  const originalHeadless = config.turnstileHeadless;
  config.turnstileSolveTimeoutMs = 20000;
  config.turnstileHeadless = true;
  const observer = http.createServer((req, res) => {
    crossOriginHeaders = req.headers;
    res.writeHead(204);
    res.end();
  });
  observer.listen(0, '127.0.0.1');
  await once(observer, 'listening');
  const observerAddress = observer.address();
  const observerUrl = `http://127.0.0.1:${observerAddress.port}`;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === `${upstreamPrefix}/login`) {
      if (!/(?:^|;\s*)cf_clearance=mock-clearance(?:;|$)/.test(req.headers.cookie || '')) {
        interstitialResponses += 1;
        res.writeHead(403, {
          'content-type': 'text/html; charset=utf-8',
          'cf-mitigated': 'challenge',
          'set-cookie': `cf_clearance=mock-clearance; HttpOnly; Path=${upstreamPrefix}; SameSite=Lax`,
        });
        res.end('<!doctype html><title>Just a moment...</title><script>setTimeout(() => location.reload(), 200)</script><div id="challenge-stage">Checking your browser</div>');
        return;
      }
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Not found</title>');
      return;
    }
    if (req.method === 'GET' && req.url === `${upstreamPrefix}/sign-in`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(loginPage(
        observerUrl,
        returnExplicitTokens
          ? `${upstreamPrefix}/api/v1/auth/login`
          : `${upstreamPrefix}/api/user/login`,
      ));
      return;
    }
    if (req.method === 'POST' && [
      `${upstreamPrefix}/api/user/login`,
      `${upstreamPrefix}/api/v1/auth/login`,
    ].includes(req.url)) {
      loginCalls += 1;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ok = body.username === 'owner@example.com'
        && body.password === 'test-password'
        && body.cf_turnstile_response === challengeToken
        && req.headers['cf-access-client-id'] === 'service-client-id'
        && req.headers['cf-access-client-secret'] === 'service-client-secret';
      res.writeHead(ok ? 200 : 401, {
        'content-type': 'application/json',
        ...(ok ? { 'set-cookie': `session=verified; HttpOnly; Path=${upstreamPrefix}; SameSite=Lax` } : {}),
      });
      res.end(JSON.stringify(ok
        ? returnExplicitTokens
          ? { success: true, data: { access_token: 'browser-new-at', refresh_token: 'browser-new-rt' } }
          : { success: true }
        : { success: false, message: 'rejected' }));
      return;
    }
    if (req.method === 'GET' && req.url === `${upstreamPrefix}/api/user/self`) {
      profileCalls += 1;
      if (protectProfileWithCf && !/(?:^|;\s*)cf_profile_clearance=verified(?:;|$)/.test(req.headers.cookie || '')) {
        profileInterstitialResponses += 1;
        const isNavigation = req.headers['sec-fetch-mode'] === 'navigate'
          || String(req.headers.accept || '').includes('text/html');
        res.writeHead(403, {
          'content-type': 'text/html; charset=utf-8',
          'cf-mitigated': 'challenge',
          ...(isNavigation ? {
            'set-cookie': `cf_profile_clearance=verified; HttpOnly; Path=${upstreamPrefix}; SameSite=Lax`,
          } : {}),
        });
        res.end('<!doctype html><title>Just a moment...</title><script>setTimeout(() => location.reload(), 200)</script><div id="challenge-stage">Checking protected API</div>');
        return;
      }
      if (profileFailure) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'profile unavailable' }));
        return;
      }
      const sessionOk = /(?:^|;\s*)session=verified(?:;|$)/.test(req.headers.cookie || '');
      const accessTokenOk = req.headers.authorization === 'existing-access-token'
        && req.headers['new-api-user'] === '12';
      const ok = (sessionOk || accessTokenOk)
        && req.headers['cf-access-client-id'] === 'service-client-id'
        && req.headers['cf-access-client-secret'] === 'service-client-secret';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok
        ? { success: true, data: { quota: 500000, status: 1 } }
        : { success: false, message: 'unauthorized' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'not found' }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const rootUrl = `http://127.0.0.1:${address.port}${upstreamPrefix}`;

  try {
    const result = await browserSolveTurnstile({
      rootUrl,
      platform: 'newapi',
      email: 'owner@example.com',
      password: 'test-password',
      headless: true,
      timeoutMs: 20000,
      verificationPaths: ['/api/user/self'],
      verificationBalancePath: 'data.quota',
      upstreamHeaders: {
        'CF-Access-Client-Id': 'service-client-id',
        'CF-Access-Client-Secret': 'service-client-secret',
      },
    });
    assert.equal(result.method, 'browser_verified_session');
    assert.equal(result.token, '');
    assert.equal(result.tokenConsumed, true);
    assert.match(result.cookies, /session=verified/);
    assert.equal(result.profile.body.data.quota, 500000);
    assert.equal(loginCalls, 1);
    assert.equal(interstitialResponses, 1);
    assert.ok(profileCalls >= 1);
    assert.ok(crossOriginHeaders);
    assert.equal(crossOriginHeaders['cf-access-client-id'], undefined);
    assert.equal(crossOriginHeaders['cf-access-client-secret'], undefined);

    returnExplicitTokens = true;
    profileFailure = true;
    const pending = await browserSolveTurnstile({
      rootUrl,
      platform: 'sub2api',
      email: 'owner@example.com',
      password: 'test-password',
      headless: true,
      timeoutMs: 12000,
      verificationPaths: ['/api/user/self'],
      verificationBalancePath: 'data.balance',
      upstreamHeaders: {
        'CF-Access-Client-Id': 'service-client-id',
        'CF-Access-Client-Secret': 'service-client-secret',
      },
    });
    assert.equal(pending.method, 'browser_login_tokens_pending_profile');
    assert.equal(pending.tokensPendingVerification, true);
    assert.equal(pending.accessToken, 'browser-new-at');
    assert.equal(pending.refreshToken, 'browser-new-rt');
    assert.equal(pending.profile, null);
    assert.equal(pending.tokenConsumed, true);
    assert.equal(loginCalls, 2);
    assert.equal(interstitialResponses, 2);

    profileFailure = false;
    protectProfileWithCf = true;
    const accessProfile = await collectBalance({
      type: 'newapi',
      authMode: 'access_token',
      baseUrl: rootUrl,
      userId: '12',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
      tokenStrategy: 'sticky',
    }, {
      accessToken: 'bad-access-token',
      accessTokens: ['bad-access-token', 'existing-access-token'],
      tokenCursor: 0,
      cfAccessClientId: 'service-client-id',
      cfAccessClientSecret: 'service-client-secret',
    });
    assert.equal(accessProfile.rawBalance, 500000);
    assert.equal(accessProfile.metadata.authSource, 'access_token_after_cloudflare');
    assert.equal(accessProfile.metadata.tokenSlot, 2);
    assert.equal(accessProfile.updatedSecret.tokenCursor, 1);
    assert.match(accessProfile.updatedSecret.cfClearanceCookie, /cf_profile_clearance=verified/);
    assert.ok(profileInterstitialResponses >= 2);
    assert.equal(loginCalls, 2);
    assert.equal(interstitialResponses, 3);
  } finally {
    config.turnstileSolveTimeoutMs = originalSolveTimeout;
    config.turnstileHeadless = originalHeadless;
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
    observer.closeAllConnections?.();
    observer.close();
    await once(observer, 'close');
  }
});
