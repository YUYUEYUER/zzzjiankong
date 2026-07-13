import test from 'node:test';
import assert from 'node:assert/strict';
import { collectBalance, normalizeApiTokenPool, normalizeTokenPool, scheduledTokenIndexes, tokenTiming } from '../server/collectors.js';

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
      return new Response(JSON.stringify({ success: false, message: 'unauthorized token' }), { status: 401 });
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
