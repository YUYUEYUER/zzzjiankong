import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySub2ApiSession,
  buildQuickAccountPayload,
  parseSub2ApiSession,
} from '../src/quick-account.js';

const baseForm = {
  upstreamId: 'upstream-sub2',
  upstreamName: '86',
  name: '主账号',
  type: 'sub2api',
  baseUrl: 'https://old.example.com/',
  userId: '',
  token: 'sk-existing',
  sub2AuthMode: 'api_token',
  browserLogin: null,
  importedSession: null,
};

function sessionJson(credentials) {
  return JSON.stringify({
    schema_version: 1,
    type: 'sub2api_session_tokens',
    platform: 'sub2api',
    origin: 'https://api.example.com',
    credentials,
    observed_from: { source: 'localStorage: refresh_token', endpoint: null },
  });
}

test('Sub2API session import normalizes origin and switches the quick payload to AT/RT auth', () => {
  const session = parseSub2ApiSession(sessionJson({
    access_token: ' access-token ',
    refresh_token: ' refresh-token ',
  }));
  const form = applySub2ApiSession(baseForm, session, 'session.json');
  const payload = buildQuickAccountPayload(form);

  assert.equal(form.baseUrl, 'https://api.example.com');
  assert.equal(form.token, '');
  assert.equal(form.importedSession.fileName, 'session.json');
  assert.equal(payload.authMode, 'access_token');
  assert.equal(payload.profilePath, '/api/v1/auth/me');
  assert.equal(payload.balancePath, 'data.balance');
  assert.equal(payload.formula, 'x');
  assert.deepEqual(payload.credentials, {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
});

test('Sub2API session import accepts a Refresh Token without an Access Token', () => {
  const session = parseSub2ApiSession(sessionJson({ access_token: null, refresh_token: 'refresh-only' }));
  const payload = buildQuickAccountPayload(applySub2ApiSession(baseForm, session, 'refresh.json'));

  assert.equal(payload.authMode, 'access_token');
  assert.deepEqual(payload.credentials, { refreshToken: 'refresh-only' });
});

test('Sub2API quick form keeps the existing API-key payload when no session file is imported', () => {
  const payload = buildQuickAccountPayload(baseForm);

  assert.equal(payload.authMode, 'api_token');
  assert.equal(payload.upstreamId, 'upstream-sub2');
  assert.equal(payload.profilePath, '/v1/usage');
  assert.equal(payload.balancePath, 'remaining');
  assert.equal(payload.formula, 'x * 7.2');
  assert.equal(payload.thresholdLow, 3);
  assert.equal(payload.thresholdRecover, 5);
  assert.deepEqual(payload.credentials, {
    apiToken: 'sk-existing',
    apiTokens: ['sk-existing'],
  });
});

test('Sub2API built-in browser login uses the captured credential handle without exposing tokens', () => {
  const payload = buildQuickAccountPayload({
    ...baseForm,
    sub2AuthMode: 'browser',
    browserLogin: { id: '11111111-1111-4111-8111-111111111111', status: 'captured' },
  });

  assert.equal(payload.authMode, 'access_token');
  assert.equal(payload.browserLoginId, '11111111-1111-4111-8111-111111111111');
  assert.equal(payload.profilePath, '/api/v1/auth/me');
  assert.equal(payload.balancePath, 'data.balance');
  assert.equal(payload.credentials, undefined);
});

test('Sub2API session import rejects the wrong schema, platform, origin, and missing tokens', () => {
  assert.throws(
    () => parseSub2ApiSession(sessionJson({})),
    /Access Token 或 Refresh Token/,
  );
  assert.throws(
    () => parseSub2ApiSession(sessionJson({ refresh_token: 'rt' }).replace('sub2api', 'newapi')),
    /Sub2API 登录态文件/,
  );
  assert.throws(
    () => parseSub2ApiSession(sessionJson({ refresh_token: 'rt' }).replace('"platform":"sub2api"', '"platform":"newapi"')),
    /文件平台必须是 Sub2API/,
  );
  assert.throws(
    () => parseSub2ApiSession(sessionJson({ refresh_token: 'rt' }).replace('https://api.example.com', 'javascript:alert(1)')),
    /HTTP\(S\)/,
  );
});

test('Sub2API session import rejects oversized opaque credentials', () => {
  assert.throws(
    () => parseSub2ApiSession(sessionJson({ access_token: 'a'.repeat(4097) })),
    /Access Token 或 Refresh Token/,
  );
});

test('Sub2API session import rejects oversized files before parsing JSON', () => {
  assert.throws(
    () => parseSub2ApiSession(`${' '.repeat(256 * 1024)}{}`),
    /不能超过 256 KiB/,
  );
});
