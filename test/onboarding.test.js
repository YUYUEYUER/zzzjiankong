import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSetupSignature, getOnboardingState, isAccountSynced } from '../src/onboarding.js';

function account(overrides = {}) {
  return {
    id: 'account-main',
    upstreamId: 'upstream-main',
    type: 'newapi',
    baseUrl: 'https://upstream.example.com',
    formula: 'x / 500000 * 7.2',
    rawUnit: 'quota',
    thresholdLow: 20,
    thresholdRecover: 50,
    pollIntervalMinutes: 5,
    demo: false,
    enabled: true,
    status: 'healthy',
    lastSyncAt: '2026-10-22T01:00:00.000Z',
    lastError: '',
    rawBalance: 5000000,
    convertedCny: 72,
    notifications: { resend: true, feishu: true, telegram: true },
    ...overrides,
  };
}

function dashboard(accounts = [account()], overrides = {}) {
  return {
    upstreams: [{ id: 'upstream-main', name: '主上游' }],
    accounts,
    settings: { resendEnabled: true, resendConfigured: true },
    ...overrides,
  };
}

test('a fresh installation starts at upstream creation', () => {
  const state = getOnboardingState();

  assert.deepEqual(state.realUpstreams, []);
  assert.deepEqual(state.realAccounts, []);
  assert.equal(state.account, null);
  assert.equal(state.upstream, null);
  assert.deepEqual(state.channels, []);
  assert.equal(state.completedCount, 0);
  assert.equal(state.currentStepId, 'upstream');
  assert.equal(state.complete, false);
});

test('demo accounts and demo-only upstreams never complete onboarding', () => {
  const demo = account({ id: 'account-demo', upstreamId: 'upstream-demo', demo: true });
  const state = getOnboardingState(dashboard([demo], {
    upstreams: [
      { id: 'upstream-demo', demoAccountCount: 1, realAccountCount: 0 },
      { id: 'upstream-empty-demo', demo: true },
      { id: 'upstream-aggregate-demo', demoAccountCount: 2, realAccountCount: 0 },
    ],
  }), { accountId: demo.id, confirmedSignature: accountSetupSignature(demo) });

  assert.deepEqual(state.realUpstreams, []);
  assert.deepEqual(state.realAccounts, []);
  assert.equal(state.completedCount, 0);
  assert.equal(isAccountSynced(demo), false);
});

test('an empty real upstream remains available beside demonstration data', () => {
  const state = getOnboardingState(dashboard([
    account({ upstreamId: 'upstream-demo', demo: true }),
  ], {
    upstreams: [
      { id: 'upstream-demo', demoAccountCount: 1 },
      { id: 'upstream-empty', accountCount: 0, demoAccountCount: 0 },
    ],
  }));

  assert.deepEqual(state.realUpstreams.map((item) => item.id), ['upstream-empty']);
  assert.equal(state.upstream.id, 'upstream-empty');
  assert.equal(state.completedCount, 1);
  assert.equal(state.currentStepId, 'account');
});

test('an upstream containing real and demo accounts retains only real account progress', () => {
  const real = account();
  const state = getOnboardingState(dashboard([
    account({ id: 'account-demo', demo: true }), real,
  ], { upstreams: [{ id: real.upstreamId, realAccountCount: 1, demoAccountCount: 1 }] }));

  assert.deepEqual(state.realAccounts, [real]);
  assert.equal(state.realUpstreams.length, 1);
  assert.equal(state.account.id, real.id);
});

test('deleted accounts cannot be selected or treated as a completed connection', () => {
  const deleted = account({ deletedAt: '2026-10-22T02:00:00.000Z' });
  const state = getOnboardingState(dashboard([
    deleted,
    account({ id: 'account-status-deleted', status: 'deleted' }),
  ]), { accountId: deleted.id, confirmedSignature: accountSetupSignature(deleted) });

  assert.deepEqual(state.realAccounts, []);
  assert.equal(state.account, null);
  assert.equal(state.currentStepId, 'account');
  assert.equal(isAccountSynced(deleted), false);
});

test('a failed poll timestamp does not count as a successful balance read', () => {
  for (const overrides of [
    { status: 'error', lastError: '连接超时' },
    { status: 'error', lastError: '' },
    { status: 'healthy', lastError: '读取失败' },
    { status: 'pending' },
    { lastSyncAt: null },
  ]) {
    const failed = account(overrides);
    assert.equal(isAccountSynced(failed), false);
    const state = getOnboardingState(dashboard([failed]), { confirmedSignature: accountSetupSignature(failed) });
    assert.equal(state.steps.find((step) => step.id === 'balance').complete, false);
    assert.equal(state.currentStepId, 'balance');
  }
});

test('zero balances and low-balance warning states are valid successful reads', () => {
  for (const status of ['healthy', 'warning', 'critical']) {
    const empty = account({ rawBalance: 0, convertedCny: 0, status });
    assert.equal(isAccountSynced(empty), true);
    const state = getOnboardingState(dashboard([empty]), { confirmedSignature: accountSetupSignature(empty) });
    assert.equal(state.complete, true);
    assert.equal(state.completedCount, 4);
    assert.equal(state.currentStepId, 'complete');
  }
});

test('missing or non-finite raw and converted balances cannot be confirmed', () => {
  for (const field of ['rawBalance', 'convertedCny']) {
    for (const value of [undefined, null, '', '0', NaN, Infinity, -Infinity]) {
      assert.equal(isAccountSynced(account({ [field]: value })), false, `${field}=${String(value)}`);
    }
  }
});

test('disabled accounts do not count as running even when a previous read succeeded', () => {
  const disabled = account({ enabled: false });
  const state = getOnboardingState(dashboard([disabled]), { confirmedSignature: accountSetupSignature(disabled) });

  assert.equal(isAccountSynced(disabled), false);
  assert.equal(isAccountSynced(account({ enabled: undefined })), true);
  assert.equal(state.currentStepId, 'balance');
  assert.equal(state.complete, false);
});

test('notification readiness requires saved global configuration and explicit account opt-in', () => {
  const selected = account({ notifications: { resend: true, feishu: false, telegram: true } });
  const state = getOnboardingState(dashboard([selected], {
    settings: {
      resendEnabled: true, resendConfigured: false,
      feishuEnabled: true, feishuConfigured: true,
      telegramEnabled: false, telegramConfigured: true,
    },
    audit: [{ type: 'notification.test', details: { resend: { status: 'sent' } } }],
  }), { confirmedSignature: accountSetupSignature(selected) });

  assert.deepEqual(state.channels, []);
  assert.equal(state.completedCount, 3);
  assert.equal(state.currentStepId, 'notifications');
  assert.equal(state.complete, false);
  assert.deepEqual(getOnboardingState(dashboard([account({ notifications: {} })])).channels, []);
});

test('only usable saved notification channels are returned', () => {
  const state = getOnboardingState(dashboard([account({ notifications: { resend: false, feishu: true, telegram: true } })], {
    settings: {
      resendEnabled: true, resendConfigured: true,
      feishuEnabled: true, feishuConfigured: true,
      telegramEnabled: true, telegramConfigured: true,
    },
  }));

  assert.deepEqual(state.channels, ['feishu', 'telegram']);
  assert.equal(state.steps.find((step) => step.id === 'notifications').complete, true);
  assert.equal(state.currentStepId, 'balance');
});

test('balance configuration needs explicit confirmation and significant edits invalidate it', () => {
  const original = account();
  const signature = accountSetupSignature(original);
  assert.equal(getOnboardingState(dashboard([original])).currentStepId, 'balance');
  assert.equal(getOnboardingState(dashboard([original]), { confirmedSignature: signature }).complete, true);

  for (const [field, value] of Object.entries({
    id: 'account-other',
    type: 'sub2api',
    baseUrl: 'https://other.example.com',
    formula: 'x * 7.2',
    rawUnit: 'USD',
    thresholdLow: 25,
    thresholdRecover: 60,
    pollIntervalMinutes: 10,
  })) {
    const changed = { ...original, [field]: value };
    assert.notEqual(accountSetupSignature(changed), signature, field);
    assert.equal(getOnboardingState(dashboard([changed]), { confirmedSignature: signature }).currentStepId, 'balance', field);
  }
});

test('new readings and credential changes do not invalidate a confirmed balance configuration', () => {
  const original = account();
  const updated = {
    ...original,
    rawBalance: 10000000,
    convertedCny: 144,
    lastSyncAt: '2026-10-22T03:00:00.000Z',
    updatedAt: '2026-10-22T03:00:00.000Z',
    name: '重命名账号',
    credentials: { accessToken: 'not-a-real-token' },
    hasCredentials: true,
  };

  assert.equal(accountSetupSignature(updated), accountSetupSignature(original));
  assert.equal(accountSetupSignature(updated).includes('not-a-real-token'), false);
  assert.equal(accountSetupSignature(null), '');
  assert.equal(getOnboardingState(dashboard([updated]), { confirmedSignature: accountSetupSignature(original) }).complete, true);
});

test('default selection prefers a synchronized enabled real account and follows its upstream', () => {
  const pending = account({ id: 'account-pending', upstreamId: 'upstream-pending', status: 'pending', lastSyncAt: null });
  const disabled = account({ id: 'account-disabled', upstreamId: 'upstream-disabled', enabled: false });
  const synced = account({ id: 'account-synced', upstreamId: 'upstream-synced' });
  const state = getOnboardingState(dashboard([pending, disabled, synced], {
    upstreams: [
      { id: pending.upstreamId }, { id: disabled.upstreamId }, { id: synced.upstreamId },
    ],
  }), { accountId: 'missing-account', upstreamId: pending.upstreamId });

  assert.equal(state.account.id, synced.id);
  assert.equal(state.upstream.id, synced.upstreamId);
});

test('explicit account selection controls readiness without borrowing another account progress', () => {
  const first = account();
  const selected = account({ id: 'account-other', upstreamId: 'upstream-other', notifications: { resend: false } });
  const data = dashboard([first, selected], { upstreams: [{ id: first.upstreamId }, { id: selected.upstreamId }] });
  const state = getOnboardingState(data, { accountId: selected.id, upstreamId: first.upstreamId, confirmedSignature: accountSetupSignature(first) });

  assert.equal(state.account.id, selected.id);
  assert.equal(state.upstream.id, selected.upstreamId);
  assert.deepEqual(state.channels, []);
  assert.equal(state.completedCount, 2);
  assert.equal(state.currentStepId, 'balance');
  assert.equal(getOnboardingState(data, { accountId: selected.id, confirmedSignature: accountSetupSignature(selected) }).currentStepId, 'notifications');
});

test('unfinished installations retain the selected empty upstream and fall back to their first account', () => {
  const upstreams = [{ id: 'upstream-first' }, { id: 'upstream-second' }];
  const empty = getOnboardingState(dashboard([], { upstreams }), { upstreamId: 'upstream-second' });
  assert.equal(empty.upstream.id, 'upstream-second');
  assert.equal(empty.currentStepId, 'account');

  const pending = account({ id: 'account-pending', upstreamId: 'upstream-first', status: 'pending' });
  const incomplete = getOnboardingState(dashboard([pending, account({ id: 'account-failed', status: 'error' })], { upstreams }));
  assert.equal(incomplete.account.id, pending.id);
  assert.equal(incomplete.upstream.id, pending.upstreamId);
});
