import test from 'node:test';
import assert from 'node:assert/strict';
import { notify } from '../server/notifications.js';

const account = {
  name: '生产账号',
  upstreamName: 'NewCLI',
  thresholdLow: 50,
  notifications: { resend: true, feishu: true, telegram: true },
};
const incident = { id: 'incident-12345678', currentBalance: 21.6 };
const settings = {
  resendEnabled: true,
  resendFrom: '告警中心 <alerts@example.com>',
  resendTo: 'owner@example.com',
  feishuEnabled: true,
  telegramEnabled: true,
  telegramChatId: '-1001234567890',
};
const secrets = {
  resendApiKey: 're_test',
  feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
  telegramBotToken: '123456789:AAExampleToken_abcdefghijklmnopqrs',
};

test('Resend and Feishu keep independent provider acknowledgements', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('resend.com')) {
      assert.equal(options.redirect, 'error');
      const payload = JSON.parse(options.body);
      assert.match(payload.subject, /NewCLI \/ 生产账号/);
      return new Response(JSON.stringify({ id: 'email-123' }), { status: 200 });
    }
    assert.equal(options.redirect, 'error');
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

test('Telegram delivers HTML-escaped text and reports message id', async () => {
  const originalFetch = global.fetch;
  let seen;
  global.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    seen = { url: String(url), payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), { status: 200 });
  };
  try {
    const results = await notify('opened', account, incident, settings, secrets, { channels: ['telegram'] });
    assert.equal(results.telegram.status, 'sent');
    assert.equal(results.telegram.externalId, '456');
    assert.equal(seen.url, 'https://api.telegram.org/bot123456789:AAExampleToken_abcdefghijklmnopqrs/sendMessage');
    assert.equal(seen.payload.chat_id, '-1001234567890');
    assert.equal(seen.payload.parse_mode, 'HTML');
    assert.match(seen.payload.text, /NewCLI \/ 生产账号/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Telegram provider errors surface description and stay retryable on rate limits', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }),
    { status: 429 },
  );
  try {
    const results = await notify('opened', account, incident, settings, secrets, { channels: ['telegram'] });
    assert.equal(results.telegram.status, 'failed');
    assert.equal(results.telegram.code, 'provider_rejected');
    assert.equal(results.telegram.retryable, true);
    assert.equal(results.telegram.retryAfterMs, 7000);
    assert.match(results.telegram.message, /Too Many Requests/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Telegram rejects malformed token and chat id before any network call', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('should not run'); };
  try {
    const badToken = await notify('opened', account, incident, settings,
      { telegramBotToken: 'bad/../token' }, { channels: ['telegram'], force: true });
    assert.equal(badToken.telegram.status, 'failed');
    assert.equal(badToken.telegram.code, 'invalid_config');
    const badChat = await notify('opened', account, incident,
      { ...settings, telegramChatId: 'not a chat' }, secrets, { channels: ['telegram'], force: true });
    assert.equal(badChat.telegram.code, 'invalid_config');
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Telegram missing secrets report missing_config without calling providers', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('should not run'); };
  try {
    const results = await notify('opened', account, incident,
      { ...settings, telegramChatId: '' }, { telegramBotToken: '' }, { channels: ['telegram'] });
    assert.equal(results.telegram.status, 'missing_config');
    assert.match(results.telegram.message, /Bot Token/);
    assert.match(results.telegram.message, /Chat ID/);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
