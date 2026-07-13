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
  return {
    title: `低余额：${subject}`,
    summary: `${subject} 当前人民币余额 ${formatMoney(incident.currentBalance)}，低于告警阈值 ${formatMoney(account.thresholdLow)}。请手动充值。`,
    color: 'red',
  };
}

class ChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ChannelError('invalid_response', '服务返回了无法识别的响应');
  }
}

function configResult(channel, account, settings, secrets, force) {
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
  return null;
}

async function sendResend(settings, secrets, copy) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secrets.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: settings.resendFrom,
      to: settings.resendTo.split(',').map((item) => item.trim()).filter(Boolean),
      subject: `[霜镜] ${copy.title}`,
      html: `<div style="font-family:system-ui;padding:24px"><h2>${escapeHtml(copy.title)}</h2><p>${escapeHtml(copy.summary)}</p><p style="color:#64748b">霜镜上游余额监控</p></div>`,
    }),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ChannelError('provider_rejected', `Resend 拒绝请求 (${response.status})：${concise(body.message, '未提供原因')}`);
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

  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: { template: copy.color, title: { tag: 'plain_text', content: copy.title } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: copy.summary } }],
      },
    }),
  });
  const body = await responseBody(response);
  if (!response.ok) {
    throw new ChannelError('provider_rejected', `飞书拒绝请求 (${response.status})：${concise(body.msg || body.StatusMessage, '未提供原因')}`);
  }
  const providerCode = body.code ?? body.StatusCode;
  if (Number(providerCode) !== 0) {
    throw new ChannelError('provider_rejected', `飞书返回失败：${concise(body.msg || body.StatusMessage, `错误码 ${providerCode ?? '未知'}`)}`);
  }
  return { message: '飞书机器人已确认' };
}

const senders = { resend: sendResend, feishu: sendFeishu };

async function runChannel(channel, account, settings, secrets, copy, force) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const blocked = configResult(channel, account, settings, secrets, force);
  if (blocked) return { ...blocked, attemptedAt: null, completedAt: startedAt, durationMs: 0 };
  try {
    const provider = await senders[channel](settings, secrets, copy);
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
      attemptedAt: startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }
}

export async function notify(kind, account, incident, settings, secrets, options = {}) {
  const copy = notificationCopy(kind, account, incident);
  const channels = options.channels || ['resend', 'feishu'];
  const entries = await Promise.all(channels.map(async (channel) => [
    channel,
    await runChannel(channel, account, settings, secrets, copy, Boolean(options.force)),
  ]));
  return Object.fromEntries(entries);
}

export function notificationStatus(result) {
  return typeof result === 'string' ? result.replace(/^error:.*/, 'failed') : result?.status || 'pending';
}
