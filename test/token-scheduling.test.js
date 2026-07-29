import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  collectBalance,
  cloudflareAccessHeaders,
  effectiveTokenTiming,
  newApiLoginUrl,
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
  assert.deepEqual(scheduledTokenIndexes(3, 'round_robin'), [0, 1, 2]);
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
  assert.equal(
    newApiLoginUrl('https://newapi.example.com/tenant', 'verified token'),
    'https://newapi.example.com/tenant/api/user/login?turnstile=verified+token',
  );
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

test('New API password login submits Turnstile using the official query parameter', async () => {
  const originalFetch = global.fetch;
  const token = 'official-newapi-turnstile-token-123456789';
  let loginCalls = 0;
  global.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname === '/tenant/api/user/login') {
      loginCalls += 1;
      assert.equal(target.searchParams.get('turnstile'), token);
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'owner@example.com');
      assert.equal(body.password, 'valid-password');
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=verified; Path=/tenant; HttpOnly',
        },
      });
    }
    assert.equal(target.pathname, '/tenant/api/user/self');
    assert.equal(options.headers.Cookie, 'session=verified');
    return new Response(JSON.stringify({ success: true, data: { quota: 500000 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await collectBalance({
      type: 'newapi',
      authMode: 'password',
      baseUrl: 'https://newapi.example.com/tenant',
      username: 'owner@example.com',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
    }, { password: 'valid-password', turnstileToken: token });
    assert.equal(result.rawBalance, 500000);
    assert.equal(loginCalls, 1);
    assert.equal(result.updatedSecret.turnstileToken, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API checks public status before password login when native Turnstile is enabled', async () => {
  const originalFetch = global.fetch;
  const originalSolver = config.turnstileSolver;
  config.turnstileSolver = 'none';
  const calls = [];
  global.fetch = async (url) => {
    calls.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({
      success: true,
      data: {
        turnstile_check: true,
        turnstile_site_key: '0x4AAAAAAAStatusEndpointKey001',
      },
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
      }, { password: 'valid-password' }),
      /Turnstile/,
    );
    assert.deepEqual(calls, ['/api/status']);
  } finally {
    global.fetch = originalFetch;
    config.turnstileSolver = originalSolver;
  }
});

test('New API passes the status sitekey directly to the configured solver', async () => {
  const originalFetch = global.fetch;
  const originalSolver = config.turnstileSolver;
  const originalSolverKey = config.turnstileSolverApiKey;
  const siteKey = '0x4AAAAAAAStatusEndpointKey001';
  const solvedToken = 'capsolver-turnstile-token-1234567890';
  let statusCalls = 0;
  let createCalls = 0;
  config.turnstileSolver = 'capsolver';
  config.turnstileSolverApiKey = 'test-solver-key';

  global.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.origin === 'https://newapi.example.com' && target.pathname === '/api/status') {
      statusCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        data: { turnstile_check: true, turnstile_site_key: siteKey },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.href === 'https://api.capsolver.com/createTask') {
      createCalls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.task.websiteKey, siteKey);
      assert.equal(body.task.websiteURL, 'https://newapi.example.com');
      return new Response(JSON.stringify({ errorId: 0, taskId: 'task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (target.href === 'https://api.capsolver.com/getTaskResult') {
      return new Response(JSON.stringify({
        errorId: 0,
        status: 'ready',
        solution: { token: solvedToken },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.origin === 'https://newapi.example.com' && target.pathname === '/api/user/login') {
      assert.equal(target.searchParams.get('turnstile'), solvedToken);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=solver-verified; Path=/; HttpOnly',
        },
      });
    }
    if (target.origin === 'https://newapi.example.com' && target.pathname === '/api/user/self') {
      assert.equal(options.headers.Cookie, 'session=solver-verified');
      return new Response(JSON.stringify({ success: true, data: { quota: 500000 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected URL: ${target.origin}${target.pathname}`);
  };

  try {
    const result = await collectBalance({
      type: 'newapi',
      authMode: 'password',
      baseUrl: 'https://newapi.example.com',
      username: 'owner@example.com',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
    }, { password: 'valid-password' });
    assert.equal(result.rawBalance, 500000);
    assert.equal(statusCalls, 1);
    assert.equal(createCalls, 1);
  } finally {
    global.fetch = originalFetch;
    config.turnstileSolver = originalSolver;
    config.turnstileSolverApiKey = originalSolverKey;
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

test('New API reads a multiplier exposed directly by a compatible token usage endpoint', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://newapi.example.com/api/usage/token');
    assert.equal(options.headers.Authorization, 'Bearer sk-rated');
    return new Response(JSON.stringify({
      code: true,
      data: {
        total_available: 300000,
        unlimited_quota: false,
        group: 'vip',
        group_ratio: 0.65,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await collectBalance({
      type: 'newapi', authMode: 'api_token', baseUrl: 'https://newapi.example.com',
    }, { apiToken: 'sk-rated' });
    assert.equal(result.rawBalance, 300000);
    assert.equal(result.metadata.rateMultiplier, 0.65);
    assert.equal(result.metadata.rateMultiplierStatus, 'available');
    assert.equal(result.metadata.rateMultiplierSource, 'newapi_usage_token');
    assert.equal(result.metadata.tokenGroup, 'vip');
  } finally {
    global.fetch = originalFetch;
  }
});

test('New API resolves an official API key group multiplier with the user access token', async () => {
  const originalFetch = global.fetch;
  const auxiliaryCalls = [];
  global.fetch = async (url, options) => {
    const target = String(url);
    if (target.endsWith('/api/usage/token')) {
      assert.equal(options.headers.Authorization, 'Bearer sk-abcd1234wxyz');
      return new Response(JSON.stringify({
        code: true,
        data: { name: 'monitor-key', total_available: 450000, unlimited_quota: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    auxiliaryCalls.push(target);
    assert.equal(options.headers.Authorization, 'personal-access-token');
    assert.equal(options.headers['New-Api-User'], '42');
    if (target.includes('/api/token/')) {
      return new Response(JSON.stringify({
        success: true,
        data: {
          items: [{ name: 'monitor-key', key: 'abcd**********wxyz', group: 'vip' }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.endsWith('/api/user/self/groups')) {
      return new Response(JSON.stringify({
        success: true,
        data: { vip: { desc: 'VIP', ratio: 0.72 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected URL ${target}`);
  };

  try {
    const result = await collectBalance({
      type: 'newapi',
      authMode: 'api_token',
      baseUrl: 'https://newapi.example.com',
      userId: '42',
    }, {
      apiToken: 'sk-abcd1234wxyz',
      accessToken: 'personal-access-token',
    });
    assert.equal(result.rawBalance, 450000);
    assert.equal(result.metadata.rateMultiplier, 0.72);
    assert.equal(result.metadata.rateMultiplierStatus, 'available');
    assert.equal(result.metadata.rateMultiplierSource, 'newapi_user_groups');
    assert.equal(result.metadata.tokenGroup, 'vip');
    assert.equal(auxiliaryCalls.length, 2);
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
    assert.equal(result.updatedSecret.apiToken, 'sk-raw-token');
    assert.deepEqual(result.updatedSecret.apiTokens, ['sk-raw-token']);

    calls.length = 0;
    await collectBalance({
      type: 'newapi', authMode: 'api_token', baseUrl: 'https://newapi.example.com',
    }, result.updatedSecret);
    assert.deepEqual(calls, ['Bearer sk-raw-token']);
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

test('Sub2API API Key reads its finite quota from the official usage endpoint', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) === 'https://sub2.example.com/v1/sub2api/billing') {
      assert.equal(options.headers.Authorization, 'Bearer sk-monitor');
      return new Response(JSON.stringify({
        object: 'sub2api.key_billing',
        schema_version: 1,
        billing_scope: 'token',
        group_rate_multiplier: 0.8,
        resolved_rate_multiplier: 0.75,
        peak_rate_enabled: true,
        peak_rate_multiplier: 1.2,
        applied_peak_multiplier: 1.2,
        effective_rate_multiplier: 0.9,
        timezone: 'Asia/Shanghai',
        observed_at: '2026-07-29T00:00:00Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(String(url), 'https://sub2.example.com/v1/usage');
    assert.equal(options.headers.Authorization, 'Bearer sk-monitor');
    return new Response(JSON.stringify({
      mode: 'quota_limited',
      isValid: true,
      status: 'active',
      remaining: 8.75,
      unit: 'USD',
      quota: { limit: 20, used: 11.25, remaining: 8.75, unit: 'USD' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await collectBalance({
      type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com', tokenStrategy: 'sticky',
    }, { apiToken: 'sk-monitor' });
    assert.equal(result.rawBalance, 8.75);
    assert.equal(result.metadata.authSource, 'api_key');
    assert.equal(result.metadata.credentialScope, 'api_key');
    assert.equal(result.metadata.balanceScope, 'api_key');
    assert.equal(result.metadata.unit, 'USD');
    assert.equal(result.metadata.apiTokenSlot, 1);
    assert.equal(result.metadata.quota.limit, 20);
    assert.equal(result.metadata.rateMultiplier, 0.9);
    assert.equal(result.metadata.groupRateMultiplier, 0.8);
    assert.equal(result.metadata.resolvedRateMultiplier, 0.75);
    assert.equal(result.metadata.appliedPeakMultiplier, 1.2);
    assert.equal(result.metadata.rateMultiplierStatus, 'available');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key honors a customized usage path and balance field', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/v1/sub2api/billing')) {
      return new Response(JSON.stringify({ error: 'not supported' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(String(url), 'https://sub2.example.com/custom/usage');
    assert.equal(options.headers.Authorization, 'Bearer sk-custom');
    return new Response(JSON.stringify({
      mode: 'quota_limited',
      isValid: true,
      data: { remaining: 6.5 },
      unit: 'USD',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await collectBalance({
      type: 'sub2api',
      authMode: 'api_token',
      baseUrl: 'https://sub2.example.com',
      profilePath: '/custom/usage',
      balancePath: 'data.remaining',
    }, { apiToken: 'sk-custom' });
    assert.equal(result.rawBalance, 6.5);
    assert.equal(result.metadata.profilePath, '/custom/usage');
    assert.equal(result.metadata.balancePath, 'data.remaining');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API round-robin starts at the first token and advances after success', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/v1/sub2api/billing')) {
      return new Response(JSON.stringify({ error: 'not supported' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    calls.push(options.headers.Authorization);
    const remaining = options.headers.Authorization === 'Bearer sk-first' ? 11 : 22;
    return new Response(JSON.stringify({
      mode: 'quota_limited', isValid: true, status: 'active', remaining, unit: 'USD',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const account = {
      type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com', tokenStrategy: 'round_robin',
    };
    const first = await collectBalance(account, { apiTokens: ['sk-first', 'sk-second'] });
    assert.equal(first.rawBalance, 11);
    assert.equal(first.updatedSecret.apiTokenCursor, 0);
    assert.deepEqual(calls, ['Bearer sk-first']);

    calls.length = 0;
    const second = await collectBalance(account, first.updatedSecret);
    assert.equal(second.rawBalance, 22);
    assert.equal(second.updatedSecret.apiTokenCursor, 1);
    assert.deepEqual(calls, ['Bearer sk-second']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key adds the sk prefix after auth failure and identifies wallet scope', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/v1/sub2api/billing')) {
      return new Response(JSON.stringify({ error: 'not supported' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization === 'Bearer monitor') {
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      mode: 'unrestricted', isValid: true, planName: '钱包余额', remaining: 19.5, unit: 'USD', balance: 19.5,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await collectBalance({
      type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com',
    }, { apiToken: 'monitor' });
    assert.deepEqual(calls, ['Bearer monitor', 'Bearer sk-monitor']);
    assert.equal(result.rawBalance, 19.5);
    assert.equal(result.metadata.balanceScope, 'wallet');
    assert.equal(result.metadata.tokenPrefixMode, 'sk_compat');
    assert.equal(result.updatedSecret.apiToken, 'sk-monitor');
    assert.deepEqual(result.updatedSecret.apiTokens, ['sk-monitor']);

    calls.length = 0;
    await collectBalance({
      type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com',
    }, result.updatedSecret);
    assert.deepEqual(calls, ['Bearer sk-monitor']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key pool fails over only on auth failure and remembers subscription slot', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/v1/sub2api/billing')) {
      return new Response(JSON.stringify({ error: 'not supported' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization === 'Bearer sk-expired') {
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
        status: 401, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      mode: 'unrestricted',
      isValid: true,
      planName: 'Claude Team',
      remaining: 42,
      unit: 'USD',
      subscription: { daily_usage_usd: 8, daily_limit_usd: 50 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await collectBalance({
      type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com', tokenStrategy: 'sticky',
    }, { apiTokens: ['sk-expired', 'sk-subscription'], apiTokenCursor: 0 });
    assert.deepEqual(calls, ['Bearer sk-expired', 'Bearer sk-subscription']);
    assert.equal(result.rawBalance, 42);
    assert.equal(result.metadata.balanceScope, 'subscription');
    assert.equal(result.metadata.apiTokenSlot, 2);
    assert.equal(result.metadata.tokenFailovers, 1);
    assert.equal(result.metadata.planName, 'Claude Team');
    assert.equal(result.updatedSecret.apiTokenCursor, 1);
    assert.equal(result.updatedSecret.apiToken, 'sk-subscription');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key pool fails over when usage marks a key invalid', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/v1/sub2api/billing')) {
      return new Response(JSON.stringify({ error: 'not supported' }), {
        status: 404, headers: { 'content-type': 'application/json' },
      });
    }
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization === 'Bearer sk-disabled') {
      return new Response(JSON.stringify({
        mode: 'quota_limited', isValid: false, status: 'inactive', remaining: 5, unit: 'USD',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      mode: 'quota_limited', isValid: true, status: 'active', remaining: 15, unit: 'USD',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await collectBalance({
      type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com',
    }, { apiTokens: ['sk-disabled', 'sk-active'] });
    assert.deepEqual(calls, ['Bearer sk-disabled', 'Bearer sk-active']);
    assert.equal(result.rawBalance, 15);
    assert.equal(result.metadata.apiTokenSlot, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key skips unmonitorable slots when a finite token remains', async () => {
  const originalFetch = global.fetch;
  try {
    for (const responseBody of [
      { mode: 'unrestricted', isValid: true, remaining: -1, unit: 'USD', subscription: {} },
      { mode: 'quota_limited', isValid: true, unit: 'USD' },
    ]) {
      let calls = 0;
      global.fetch = async (url) => {
        if (String(url).endsWith('/v1/sub2api/billing')) {
          return new Response(JSON.stringify({ error: 'not supported' }), {
            status: 404, headers: { 'content-type': 'application/json' },
          });
        }
        calls += 1;
        return new Response(JSON.stringify(calls === 1 ? responseBody : {
          mode: 'quota_limited', isValid: true, status: 'active', remaining: 7.5, unit: 'USD',
        }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      };
      const result = await collectBalance({
        type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com',
      }, { apiTokens: ['sk-first', 'sk-second'] });
      assert.equal(result.rawBalance, 7.5);
      assert.equal(result.metadata.apiTokenSlot, 2);
      assert.equal(result.metadata.tokenFailovers, 1);
      assert.equal(calls, 2);
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key rejects a pool when every slot is unmonitorable', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      mode: 'quota_limited', isValid: true, unit: 'USD',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    await assert.rejects(
      collectBalance({
        type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com',
      }, { apiTokens: ['sk-first', 'sk-second'] }),
      /池没有可监控的有限余额/,
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API API Key does not fan Cloudflare or server failures across its pool', async () => {
  const originalFetch = global.fetch;
  const originalSolver = config.turnstileSolver;
  config.turnstileSolver = 'none';
  try {
    for (const upstreamResponse of [
      new Response('<html><title>Just a moment...</title></html>', {
        status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
      }),
      new Response(JSON.stringify({ error: 'token accounting temporarily unavailable' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      }),
    ]) {
      let calls = 0;
      global.fetch = async () => {
        calls += 1;
        return upstreamResponse.clone();
      };
      await assert.rejects(
        collectBalance({
          type: 'sub2api', authMode: 'api_token', baseUrl: 'https://sub2.example.com',
        }, { apiTokens: ['sk-first', 'sk-second'] }),
      );
      assert.equal(calls, 1);
    }
  } finally {
    global.fetch = originalFetch;
    config.turnstileSolver = originalSolver;
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

test('New API access token reuses a persisted Cloudflare clearance session', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    assert.equal(new URL(String(url)).pathname, '/api/user/self');
    assert.equal(options.headers.Authorization, 'valid-access-token');
    assert.equal(options.headers['New-Api-User'], '12');
    assert.equal(options.headers.Cookie, 'cf_clearance=persisted');
    assert.equal(options.headers['User-Agent'], 'Persisted Browser UA');
    return new Response(JSON.stringify({ success: true, data: { quota: 750000 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await collectBalance({
      type: 'newapi',
      baseUrl: 'https://newapi.example.com',
      userId: '12',
      profilePath: '/api/user/self',
      balancePath: 'data.quota',
    }, {
      accessToken: 'valid-access-token',
      cfClearanceCookie: 'cf_clearance=persisted',
      cfClearanceUserAgent: 'Persisted Browser UA',
      cfClearanceCapturedAt: new Date().toISOString(),
    });
    assert.equal(result.rawBalance, 750000);
    assert.equal(result.metadata.authSource, 'access_token');
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
  global.fetch = async (url) => {
    calls += 1;
    if (new URL(String(url)).pathname === '/api/status') {
      return new Response(JSON.stringify({
        success: true,
        data: { turnstile_check: false },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
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
    assert.equal(calls, 2);
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
  const originalSolver = config.turnstileSolver;
  config.turnstileSolver = 'none';
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
    config.turnstileSolver = originalSolver;
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
