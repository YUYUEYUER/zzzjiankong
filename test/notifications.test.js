import test from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../server/notifications.js';

const account = {
  name: '生产账号',
  upstreamName: 'NewCLI',
  thresholdLow: 50,
  notifications: { resend: true, feishu: true },
};
const incident = { id: 'incident-12345678', currentBalance: 21.6 };
const settings = {
  resendEnabled: true,
  resendFrom: '告警中心 <alerts@example.com>',
  resendTo: 'owner@example.com',
  feishuEnabled: true,
};
const secrets = { resendApiKey: 're_test', feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test' };

test('Resend and Feishu keep independent provider acknowledgements', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('resend.com')) {
      const payload = JSON.parse(options.body);
      assert.match(payload.subject, /NewCLI \/ 生产账号/);
      return new Response(JSON.stringify({ id: 'email-123' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 19024, msg: 'invalid webhook' }), { status: 200 });
  };
  try {
    const results = await notify('opened', account, incident, settings, secrets);
    assert.equal(results.resend.status, 'sent');
    assert.equal(results.resend.externalId, 'email-123');
    assert.equal(results.feishu.status, 'failed');
    assert.equal(results.feishu.code, 'provider_rejected');
    assert.match(results.feishu.message, /invalid webhook/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('missing configuration and account switches do not call providers', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('should not run'); };
  try {
    const results = await notify(
      'opened',
      { ...account, notifications: { resend: false, feishu: true } },
      incident,
      settings,
      { resendApiKey: 're_test', feishuWebhook: '' },
    );
    assert.equal(results.resend.status, 'account_disabled');
    assert.equal(results.feishu.status, 'missing_config');
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('channel test can bypass enable switches but still validates secrets', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 });
  try {
    const results = await notify(
      'opened',
      { ...account, notifications: { resend: false, feishu: false } },
      incident,
      { ...settings, feishuEnabled: false },
      secrets,
      { channels: ['feishu'], force: true },
    );
    assert.equal(results.feishu.status, 'sent');
    assert.equal(results.feishu.message, '飞书机器人已确认');
  } finally {
    global.fetch = originalFetch;
  }
});
