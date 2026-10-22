import { redactCredentialText } from './collectors.js';
import { readLimitedBody } from './network-policy.js';

function formatMoney(value) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function concise(value, fallback) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.slice(0, 240) || fallback;
}

function notificationCopy(kind, account, incident) {
  const subject = account.upstreamName
    ? `${account.upstreamName} / ${account.name}`
    : account.name;
  if (kind === 'recovered') {
    return {
      title: `余额已恢复：${subject}`,
      summary: `${subject} 当前人民币余额 ${formatMoney(incident.currentBalance)}，已连续通过恢复检测，事件 ${incident.id?.slice(0, 8) || ''} 自动结单。`,
      color: 'green',
    };
  }
  if (kind === 'reminder') {
    return {
      title: `低余额仍未恢复：${subject}`,
      summary: `${subject} 当前人民币余额 ${formatMoney(incident.currentBalance)}，事件仍未恢复。请检查充值进度，告警阈值为 ${formatMoney(account.thresholdLow)}。`,
      color: 'orange',
    };
  }
  if (kind === 'credential_expiry') {
    const expiryText = incident.credentialExpiresAt ? new Date(incident.credentialExpiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '近期';
    const expired = incident.credentialExpired;
    return {
      title: `凭据${expired ? '已过期' : '即将到期'}：${subject}`,
      summary: `${subject} 的访问令牌${expired ? '已于' : '将于'} ${expiryText} ${expired ? '过期' : '到期'}。余额采集可能随时失败，请尽快在账号设置中更新凭据。`,
      color: expired ? 'red' : 'orange',
    };
  }
  if (kind === 'prediction') {
    const eta = Number.isFinite(Number(incident.depletionEtaDays)) ? `${incident.depletionEtaDays} 天` : '数天';
    const burn = formatMoney(incident.dailyBurnRate || 0);
    return {
      title: `余额预计耗尽：${subject}`,
      summary: `${subject} 当前人民币余额 ${formatMoney(incident.currentBalance)}，按近期消耗速率约 ${burn}/天，预计 ${eta} 内跌破告警阈值 ${formatMoney(account.thresholdLow)}。建议提前充值。`,
      color: 'orange',
    };
  }
  return {
    title: `低余额：${subject}`,
    summary: `${subject} 当前人民币余额 ${formatMoney(incident.currentBalance)}，低于告警阈值 ${formatMoney(account.thresholdLow)}。请手动充值。`,
    color: 'red',
  };
}

class ChannelError extends Error {
  constructor(code, message, { retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

async function responseBody(response) {
  const text = await readLimitedBody(response, 64 * 1024);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ChannelError('invalid_response', '服务返回了无法识别的响应');
  }
}

function configResult(channel, account, settings, secrets, force) {
  if (!force && account.demo) {
    return { status: 'disabled', message: '演示账号不发送真实通知' };
  }
  if (!force && !settings[`${channel}Enabled`]) {
    return { status: 'disabled', message: '全局未启用' };
  }
  if (!force && account.notifications?.[channel] === false) {
    return { status: 'account_disabled', message: '该账号未启用此渠道' };
  }
  if (channel === 'resend') {
    const missing = [
      !secrets.resendApiKey && 'API Key',
      !settings.resendFrom && '发件人',
      !settings.resendTo && '收件人',
    ].filter(Boolean);
    if (missing.length) return { status: 'missing_config', message: `缺少${missing.join('、')}` };
  }
  if (channel === 'feishu' && !secrets.feishuWebhook) {
    return { status: 'missing_config', message: '缺少 Webhook 地址' };
  }
  if (channel === 'wecom' && !secrets.wecomWebhook) {
    return { status: 'missing_config', message: '缺少 Webhook 地址' };
  }
  if (channel === 'telegram') {
    const missing = [
      !secrets.telegramBotToken && 'Bot Token',
      !settings.telegramChatId && 'Chat ID',
    ].filter(Boolean);
    if (missing.length) return { status: 'missing_config', message: `缺少${missing.join('、')}` };
  }
  return null;
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function sendResend(settings, secrets, copy, options = {}) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${secrets.resendApiKey}`,
      'Content-Type': 'application/json',
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: settings.resendFrom,
      to: settings.resendTo.split(',').map((item) => item.trim()).filter(Boolean),
      subject: `[霜镜] ${copy.title}`,
      html: `<div style="font-family:system-ui;padding:24px"><h2>${escapeHtml(copy.title)}</h2><p>${escapeHtml(copy.summary)}</p><p style="color:#64748b">霜镜上游余额监控</p></div>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ChannelError('provider_rejected', `Resend 拒绝请求 (${response.status})：${concise(body.message, '未提供原因')}`, {
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: retryAfterMs(response),
    });
  }
  if (!body.id) throw new ChannelError('invalid_response', 'Resend 未返回邮件编号');
  return { externalId: String(body.id), message: 'Resend 已受理' };
}

async function sendFeishu(settings, secrets, copy) {
  let webhook;
  try {
    webhook = new URL(secrets.feishuWebhook);
  } catch {
    throw new ChannelError('invalid_config', 'Webhook 地址格式无效');
  }
  if (webhook.protocol !== 'https:') throw new ChannelError('invalid_config', 'Webhook 必须使用 HTTPS');
  if (webhook.username || webhook.password) throw new ChannelError('invalid_config', 'Webhook 地址不能包含用户名或密码');

  const response = await fetch(webhook, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: { template: copy.color, title: { tag: 'plain_text', content: copy.title } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: copy.summary } }],
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ChannelError('provider_rejected', `飞书拒绝请求 (${response.status})：${concise(body.msg || body.StatusMessage, '未提供原因')}`, {
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: retryAfterMs(response),
    });
  }
  const providerCode = body.code ?? body.StatusCode;
  if (Number(providerCode) !== 0) {
    throw new ChannelError('provider_rejected', `飞书返回失败：${concise(body.msg || body.StatusMessage, `错误码 ${providerCode ?? '未知'}`)}`);
  }
  return { message: '飞书机器人已确认' };
}

/** Telegram Bot Token 只能是 `数字ID:密钥段`；校验字符集防止 URL 路径注入。 */
const TELEGRAM_TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
/** chat_id 支持数字（含群组负数）与 @频道名。 */
const TELEGRAM_CHAT_ID_PATTERN = /^(@[A-Za-z0-9_]{5,64}|-?\d{5,20})$/;

async function sendTelegram(settings, secrets, copy) {
  const token = String(secrets.telegramBotToken || '').trim();
  if (!TELEGRAM_TOKEN_PATTERN.test(token)) {
    throw new ChannelError('invalid_config', 'Bot Token 格式无效（应为 123456:ABC-... 形式）');
  }
  const chatId = String(settings.telegramChatId || '').trim();
  if (!TELEGRAM_CHAT_ID_PATTERN.test(chatId)) {
    throw new ChannelError('invalid_config', 'Chat ID 格式无效（数字、负数群组 ID 或 @频道名）');
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `<b>${escapeHtml(copy.title)}</b>\n${escapeHtml(copy.summary)}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await responseBody(response);
  if (!response.ok || body.ok !== true) {
    const retryAfterSeconds = Number(body.parameters?.retry_after);
    throw new ChannelError('provider_rejected', redactCredentialText(
      `Telegram 拒绝请求 (${body.error_code ?? response.status})：${concise(body.description, '未提供原因')}`,
      [token],
    ), {
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: retryAfterMs(response) || (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0),
    });
  }
  return { externalId: String(body.result?.message_id ?? ''), message: 'Telegram 已送达' };
}

/** 企业微信机器人 webhook 必须指向官方域名；地址内含 key，收紧域名可防止手滑把凭据发往他站。 */
const WECOM_WEBHOOK_HOST = 'qyapi.weixin.qq.com';

async function sendWecom(settings, secrets, copy) {
  let webhook;
  try {
    webhook = new URL(secrets.wecomWebhook);
  } catch {
    throw new ChannelError('invalid_config', 'Webhook 地址格式无效');
  }
  if (webhook.protocol !== 'https:' || webhook.hostname !== WECOM_WEBHOOK_HOST) {
    throw new ChannelError('invalid_config', `Webhook 必须是 https://${WECOM_WEBHOOK_HOST}/cgi-bin/webhook/send?key=... 地址`);
  }
  if (webhook.username || webhook.password) throw new ChannelError('invalid_config', 'Webhook 地址不能包含用户名或密码');
  const response = await fetch(webhook, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { content: `**${copy.title}**\n> ${copy.summary}` },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await responseBody(response);
  if (!response.ok || Number(body.errcode) !== 0) {
    throw new ChannelError('provider_rejected', redactCredentialText(
      `企业微信拒绝请求 (${body.errcode ?? response.status})：${concise(body.errmsg, '未提供原因')}`,
      [webhook.href],
    ), {
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: retryAfterMs(response),
    });
  }
  return { message: '企业微信机器人已确认' };
}

const senders = { resend: sendResend, feishu: sendFeishu, telegram: sendTelegram, wecom: sendWecom };

async function runChannel(channel, account, settings, secrets, copy, force, options) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const blocked = configResult(channel, account, settings, secrets, force);
  if (blocked) return { ...blocked, attemptedAt: null, completedAt: startedAt, durationMs: 0 };
  try {
    const provider = await senders[channel](settings, secrets, copy, options);
    return {
      status: 'sent',
      attemptedAt: startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...provider,
    };
  } catch (error) {
    return {
      status: 'failed',
      code: error.code || 'request_failed',
      message: concise(error.message, '发送失败'),
      retryable: error.retryable ?? ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name),
      retryAfterMs: Number(error.retryAfterMs || 0),
      attemptedAt: startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }
}

export async function notify(kind, account, incident, settings, secrets, options = {}) {
  const copy = notificationCopy(kind, account, incident);
  const channels = options.channels || ['resend', 'feishu', 'telegram', 'wecom'];
  const entries = await Promise.all(channels.map(async (channel) => [
    channel,
    await runChannel(channel, account, settings, secrets, copy, Boolean(options.force), {
      idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:${channel}` : '',
    }),
  ]));
  return Object.fromEntries(entries);
}

export function notificationStatus(result) {
  return typeof result === 'string' ? result.replace(/^error:.*/, 'failed') : result?.status || 'pending';
}
