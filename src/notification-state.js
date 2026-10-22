export const CHANNEL_NAMES = { resend: 'Resend', feishu: '飞书', telegram: 'Telegram', wecom: '企业微信' };

export function notificationResult(incident, kind, channel) {
  const current = incident?.notifications?.[kind]?.results?.[channel];
  if (current) return current;
  if (kind === 'opened' && incident?.channelResults?.[channel]) {
    return { status: incident.channelResults[channel], message: '历史发送记录' };
  }
  return null;
}

export function notificationStatus(result) {
  if (!result) return 'pending';
  if (typeof result === 'string') return result.startsWith('error:') ? 'failed' : result;
  return result.status || 'pending';
}

export function notificationText(result, channel) {
  const status = notificationStatus(result);
  if (status === 'sent') return result?.message || `${CHANNEL_NAMES[channel] || channel} 已确认`;
  if (status === 'failed') return result?.message || '发送失败';
  if (status === 'missing_config') return result?.message || '配置不完整';
  if (status === 'account_disabled') return '该账号未启用';
  if (status === 'disabled') return '全局未启用';
  return '尚未发送';
}

export function notificationTone(result) {
  const status = notificationStatus(result);
  if (status === 'sent') return 'success';
  if (status === 'failed' || status === 'missing_config') return 'error';
  return 'muted';
}
