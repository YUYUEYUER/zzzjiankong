import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  collectBalance,
  cloudflareAccessHeaders,
  effectiveTokenTiming,
  normalizeApiTokenPool,
  normalizeTokenPool,
  scheduledTokenIndexes,
  tokenTiming,
  turnstileRequestFields,
} from '../server/collectors.js';
import { config } from '../server/config.js';
import { takeCredentialCheckpoint } from '../server/credential-checkpoint.js';

function jwt(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp })}.signature`;
}

test('New API token pool keeps order and schedules from the expected slot', () => {
  assert.deepEqual(normalizeTokenPool({ accessTokens: ['a', 'b', 'a'], accessToken: 'b' }), ['a', 'b']);
  assert.deepEqual(normalizeApiTokenPool({ apiTokens: ['first', 'sk-second', 'first'] }), ['first', 'sk-second']);
  assert.deepEqual(scheduledTokenIndexes(3, 'sticky', 1), [1, 2, 0]);
  assert.deepEqual(scheduledTokenIndexes(3, 'round_robin', 1), [2, 0, 1]);
});

test('opaque token timing uses the stored expiry and login payload includes compatibility fields', () => {
  const current = Date.now();
  const timing = effectiveTokenTiming(
    'opaque-access-token',
    new Date(current + 60000).toISOString(),
    5 * 60000,
    current,
  );
  assert.equal(timing.source, 'stored');
  assert.equal(timing.expired, false);
  assert.equal(timing.expiringSoon, true);
  assert.deepEqual(turnstileRequestFields('verified-token'), {
    turnstile_token: 'verified-token',
    cf_turnstile_response: 'verified-token',
    'cf-turnstile-response': 'verified-token',
  });
  assert.deepEqual(cloudflareAccessHeaders({
    cfAccessClientId: 'client-id.access',
    cfAccessClientSecret: 'client-secret',
  }), {
    'CF-Access-Client-Id': 'client-id.access',
    'CF-Access-Client-Secret': 'client-secret',
  });
  assert.deepEqual(cloudflareAccessHeaders({ cfAccessClientId: 'missing-secret' }), {});
});

test('New API password mode reuses a verified browser session before logging in again', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, data: { quota: 800000, status: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await collectBalance({
      type: 'newapi',
      authMode: 'password',
      baseUrl: 'https://newapi.example.com',
      username: 'owner@example.com',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
    }, {
      password: 'not-used-during-this-poll',
      sessionCookie: 'session=verified',
      sessionUserAgent: 'Verified Browser UA',
      cfAccessClientId: 'client-id.access',
      cfAccessClientSecret: 'client-secret',
    });
    assert.equal(result.rawBalance, 800000);
    assert.equal(result.metadata.authSource, 'saved_browser_session');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://newapi.example.com/api/user/self');
    assert.equal(calls[0].options.headers.Cookie, 'session=verified');
    assert.equal(calls[0].options.headers['User-Agent'], 'Verified Browser UA');
    assert.equal(calls[0].options.headers['CF-Access-Client-Id'], 'client-id.access');
    assert.equal(calls[0].options.headers['CF-Access-Client-Secret'], 'client-secret');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a stored one-shot Turnstile token is removed on both success and failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    success: true,
    data: { quota: 100000 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const success = await collectBalance({
      type: 'newapi',
      baseUrl: 'https://newapi.example.com',
      userId: '7',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
    }, { accessToken: 'valid-token', turnstileToken: 'one-shot-success-token-value-123456' });
    assert.equal(success.updatedSecret.turnstileToken, undefined);
    assert.equal(success.updatedSecret.accessToken, 'valid-token');

    global.fetch = async () => new Response(JSON.stringify({ message: 'please sign in' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    let failure;
    try {
      await collectBalance({
        type: 'newapi',
        baseUrl: 'https://newapi.example.com',
        userId: '7',
        profilePath: '/api/user/self',
        balancePath: 'data.quota',
      }, { accessToken: 'valid-token', turnstileToken: 'one-shot-failure-token-value-123456' });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const checkpoint = takeCredentialCheckpoint(failure);
    assert.equal(checkpoint.turnstileToken, undefined);
    assert.equal(checkpoint.accessToken, 'valid-token');
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API raw API key reads key quota without login or User ID', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://newapi.example.com/api/usage/token');
    assert.equal(options.headers.Authorization, 'Bearer monitor');
    assert.equal(options.headers['New-Api-User'], undefined);
    return new Response(JSON.stringify({
      code: true,
      data: {
        name: 'balance-monitor',
        total_granted: 1500000,
        total_used: 500000,
        total_available: 1000000,
        unlimited_quota: false,
        expires_at: -1,
      },
    }), { status: 200 });
  };

  try {
    const result = await collectBalance({
      type: 'newapi', authMode: 'api_token', baseUrl: 'https://newapi.example.com', tokenStrategy: 'sticky',
    }, { apiToken: 'monitor' });
    assert.equal(result.rawBalance, 1000000);
    assert.equal(result.metadata.authSource, 'api_key');
    assert.equal(result.metadata.balanceScope, 'api_key');
    assert.equal(result.metadata.tokenName, 'balance-monitor');
    assert.equal(result.metadata.apiTokenSlot, 1);
    assert.equal(result.metadata.tokenPrefixMode, 'as_entered');
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API raw API key retries with sk prefix only after auth failure', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization === 'Bearer raw-token') {
      return new Response(JSON.stringify({ success: false, message: 'unauthorized token' }), { status: 401 });
    }
    return new Response(JSON.stringify({ code: true, data: { total_available: 250000, unlimited_quota: false } }), { status: 200 });
  };

  try {
    const result = await collectBalance({
      type: 'newapi', authMode: 'api_token', baseUrl: 'https://newapi.example.com',
    }, { apiToken: 'raw-token' });
    assert.equal(result.rawBalance, 250000);
    assert.deepEqual(calls, ['Bearer raw-token', 'Bearer sk-raw-token']);
    assert.equal(result.metadata.tokenPrefixMode, 'sk_compat');
    assert.equal(result.updatedSecret, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API API key pool fails over and remembers the working slot', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (_url, options) => {
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization === 'Bearer sk-unlimited') {
      return new Response(JSON.stringify({ code: true, data: { unlimited_quota: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: true, data: { total_available: 750000, unlimited_quota: false } }), { status: 200 });
  };

  try {
    const result = await collectBalance({
      type: 'newapi', authMode: 'api_token', baseUrl: 'https://newapi.example.com', tokenStrategy: 'sticky',
    }, { apiTokens: ['sk-unlimited', 'sk-finite'], apiTokenCursor: 0 });
    assert.equal(result.rawBalance, 750000);
    assert.deepEqual(calls, ['Bearer sk-unlimited', 'Bearer sk-finite']);
    assert.equal(result.metadata.apiTokenSlot, 2);
    assert.equal(result.metadata.tokenFailovers, 1);
    assert.equal(result.updatedSecret.apiTokenCursor, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API rejects an unlimited API key as an unmonitorable balance', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    code: true, data: { unlimited_quota: true },
  }), { status: 200 });

  try {
    await assert.rejects(
      collectBalance({ type: 'newapi', authMode: 'api_token', baseUrl: 'https://newapi.example.com' }, { apiToken: 'sk-unlimited' }),
      /无限额度/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API user access token requires User ID, fails over, and remembers the successful slot', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(options.headers.Authorization);
    assert.equal(options.headers['New-Api-User'], '12');
    if (options.headers.Authorization === 'bad-token') {
      return new Response(JSON.stringify({ code: 401, message: 'unauthorized token' }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, data: { quota: 500000, status: 1 } }), { status: 200 });
  };
  const account = {
    type: 'newapi', baseUrl: 'https://newapi.example.com', userId: '12', profilePath: '/api/user/self',
    balancePath: 'data.quota', tokenStrategy: 'sticky',
  };
  try {
    const first = await collectBalance(account, { accessToken: 'bad-token', accessTokens: ['bad-token', 'good-token'], tokenCursor: 0 });
    assert.equal(first.rawBalance, 500000);
    assert.deepEqual(calls, ['bad-token', 'good-token']);
    assert.equal(first.metadata.authSource, 'access_token');
    assert.equal(first.metadata.tokenSlot, 2);
    assert.equal(first.metadata.tokenFailovers, 1);
    assert.equal(first.updatedSecret.tokenCursor, 1);

    calls.length = 0;
    const second = await collectBalance(account, first.updatedSecret);
    assert.equal(second.rawBalance, 500000);
    assert.deepEqual(calls, ['good-token']);
    assert.equal(second.metadata.tokenSlot, 2);
    assert.equal(second.updatedSecret, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API preserves typed token-pool auth failure and falls back to password session', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/api/user/login')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'session=fallback; Path=/; HttpOnly' },
      });
    }
    if (options.headers?.Cookie === 'session=fallback') {
      return new Response(JSON.stringify({ success: true, data: { quota: 600000 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ message: 'please sign in' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await collectBalance({
      type: 'newapi',
      authMode: 'access_token',
      baseUrl: 'https://newapi.example.com',
      username: 'owner@example.com',
      userId: '12',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
    }, { accessToken: 'expired-user-token', password: 'valid-password' });
    assert.equal(result.rawBalance, 600000);
    assert.equal(result.metadata.authSource, 'password_session');
    assert.ok(calls.some((call) => call.url.endsWith('/api/user/login')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API checkpoints tokens issued by password login when profile is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/user/login')) {
      return new Response(JSON.stringify({
        success: true,
        data: { access_token: 'newapi-password-at', refresh_token: 'newapi-password-rt' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false, message: 'profile unavailable' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      collectBalance({
        type: 'newapi',
        authMode: 'password',
        baseUrl: 'https://newapi.example.com',
        username: 'owner@example.com',
        profilePath: '/api/user/self',
        balancePath: 'data.quota',
      }, { password: 'valid-password' }),
      (error) => {
        const checkpoint = takeCredentialCheckpoint(error);
        return checkpoint?.accessToken === 'newapi-password-at'
          && checkpoint?.refreshToken === 'newapi-password-rt';
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API rejects failed login envelopes even when they contain tokens', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      code: 401,
      message: 'invalid credentials',
      data: { access_token: 'must-not-be-checkpointed', refresh_token: 'must-not-be-checkpointed' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await assert.rejects(
      collectBalance({
        type: 'newapi',
        authMode: 'password',
        baseUrl: 'https://newapi.example.com',
        username: 'owner@example.com',
        profilePath: '/api/user/self',
        balancePath: 'data.quota',
      }, { password: 'invalid-password' }),
      (error) => takeCredentialCheckpoint(error) === undefined,
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API proactively refreshes a near-expiry AT, rotates RT, and falls back to the official profile path', async () => {
  const originalFetch = global.fetch;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const oldAccess = jwt(nowSeconds + 60);
  const oldRefresh = jwt(nowSeconds + 3600);
  const newAccess = jwt(nowSeconds + 7200);
  const newRefresh = jwt(nowSeconds + 10800);
  const calls = [];

  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/v1/auth/refresh')) {
      return new Response(JSON.stringify({ code: 0, data: { access_token: newAccess, refresh_token: newRefresh, expires_in: 7200 } }), { status: 200 });
    }
    if (String(url).endsWith('/api/v1/user/profile')) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    return new Response(JSON.stringify({ code: 0, data: { balance: 125.5, status: 'active' } }), { status: 200 });
  };

  try {
    const result = await collectBalance({
      type: 'sub2api', baseUrl: 'https://sub2.example.com', profilePath: '/api/v1/user/profile', balancePath: 'data.balance',
    }, { accessToken: oldAccess, refreshToken: oldRefresh });
    assert.equal(result.rawBalance, 125.5);
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/api/v1/auth/refresh', '/api/v1/user/profile', '/api/v1/users/me']);
    assert.equal(result.metadata.refreshReason, 'access_token_expiring');
    assert.equal(result.metadata.refreshTokenRotated, true);
    assert.equal(result.updatedSecret.accessToken, newAccess);
    assert.equal(result.updatedSecret.refreshToken, newRefresh);
    assert.equal(tokenTiming(result.updatedSecret.accessToken).expiringSoon, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API exposes rotated AT/RT as a checkpoint when every profile request fails', async () => {
  const originalFetch = global.fetch;
  const current = Math.floor(Date.now() / 1000);
  const oldAccess = jwt(current + 30);
  const oldRefresh = jwt(current + 3600);
  const newAccess = jwt(current + 7200);
  const newRefresh = jwt(current + 10800);
  let refreshCalls = 0;

  global.fetch = async (url) => {
    if (String(url).endsWith('/api/v1/auth/refresh')) {
      refreshCalls += 1;
      return new Response(JSON.stringify({
        code: 0,
        data: { access_token: newAccess, refresh_token: newRefresh, expires_in: 7200 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false, message: 'profile temporarily unavailable' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      collectBalance({
        type: 'sub2api',
        baseUrl: 'https://sub2.example.com',
        profilePath: '/api/v1/user/profile',
        balancePath: 'data.balance',
      }, { accessToken: oldAccess, refreshToken: oldRefresh }),
      (error) => {
        const checkpoint = takeCredentialCheckpoint(error);
        return checkpoint?.accessToken === newAccess && checkpoint?.refreshToken === newRefresh;
      },
    );
    assert.equal(refreshCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API checkpoints tokens issued by password login when profile is unavailable', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).endsWith('/api/v1/auth/login')) {
      return new Response(JSON.stringify({
        code: 0,
        data: { access_token: 'password-new-at', refresh_token: 'password-new-rt' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ success: false, message: 'profile unavailable' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(
      collectBalance({
        type: 'sub2api',
        baseUrl: 'https://sub2.example.com',
        username: 'owner@example.com',
        profilePath: '/api/v1/users/me',
        balancePath: 'data.balance',
      }, { password: 'valid-password' }),
      (error) => {
        const checkpoint = takeCredentialCheckpoint(error);
        return checkpoint?.accessToken === 'password-new-at'
          && checkpoint?.refreshToken === 'password-new-rt';
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API stops token-pool failover when Cloudflare challenges the origin', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('<html><title>Just a moment...</title></html>', {
      status: 403,
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    });
  };
  try {
    await assert.rejects(
      collectBalance({
        type: 'newapi',
        baseUrl: 'https://newapi.example.com',
        userId: '12',
        profilePath: '/api/user/self',
        balancePath: 'data.quota',
      }, { accessTokens: ['first-token', 'second-token'] }),
      /Cloudflare\/Turnstile/,
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API does not fan a server failure across every token slot', async () => {
  const originalFetch = global.fetch;
  const authorizations = [];
  global.fetch = async (_url, options) => {
    authorizations.push(options.headers.Authorization);
    return new Response(JSON.stringify({ success: false, message: 'temporary upstream failure' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(
      collectBalance({
        type: 'newapi',
        baseUrl: 'https://newapi.example.com',
        userId: '12',
        profilePath: '/api/user/self',
        balancePath: 'data.quota',
      }, { accessTokens: ['first-token', 'second-token', 'third-token'] }),
      /temporary upstream failure/,
    );
    assert.ok(authorizations.length >= 1);
    assert.ok(authorizations.every((value) => value === 'first-token'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('upstream credentials are never followed across an origin redirect', async () => {
  let receiverCalls = 0;
  const receiver = http.createServer((_req, res) => {
    receiverCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { balance: 1 } }));
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const receiverAddress = receiver.address();
  const receiverUrl = `http://127.0.0.1:${receiverAddress.port}`;

  const source = http.createServer((_req, res) => {
    res.writeHead(302, { location: `${receiverUrl}/stolen` });
    res.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceAddress = source.address();

  try {
    await assert.rejects(
      collectBalance({
        type: 'generic',
        baseUrl: `http://127.0.0.1:${sourceAddress.port}`,
        profilePath: '/profile',
        balancePath: 'data.balance',
      }, {
        accessToken: 'sensitive-access-token',
        cfAccessClientId: 'sensitive-client-id',
        cfAccessClientSecret: 'sensitive-client-secret',
      }),
      /跨域重定向/,
    );
    assert.equal(receiverCalls, 0);
  } finally {
    source.closeAllConnections?.();
    source.close();
    await once(source, 'close');
    receiver.closeAllConnections?.();
    receiver.close();
    await once(receiver, 'close');
  }
});

test('Sub2API initial HTML challenge enters the Turnstile handling branch', async () => {
  const originalFetch = global.fetch;
  const originalSolver = config.turnstileSolver;
  config.turnstileSolver = 'none';
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script></html>', {
      status: 403,
      headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
    });
  };

  try {
    await assert.rejects(
      collectBalance({
        type: 'sub2api',
        baseUrl: 'https://sub2.example.com',
        username: 'owner@example.com',
        balancePath: 'data.balance',
      }, { password: 'valid-upstream-password' }),
      (error) => /Turnstile 自动处理失败/.test(error.message)
        && /站点启用了 Cloudflare 防护/.test(error.message),
    );
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    config.turnstileSolver = originalSolver;
  }
});
