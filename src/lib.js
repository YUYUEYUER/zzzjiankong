export function money(value, digits = 2) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value || 0));
}

export function compactNumber(value) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(Number(value || 0));
}

export function relativeTime(value) {
  if (!value) return '尚未同步';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function duration(openedAt, resolvedAt) {
  const start = new Date(openedAt).getTime();
  const end = resolvedAt ? new Date(resolvedAt).getTime() : Date.now();
  const minutes = Math.max(0, Math.floor((end - start) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} 小时${rest ? ` ${rest} 分` : ''}`;
}

export const statusLabels = {
  healthy: '正常',
  warning: '低余额',
  critical: '严重',
  offline: '离线',
  pending: '待同步',
  error: '异常',
  empty: '未配置',
};

export function platformLabel(type) {
  if (type === 'newapi') return 'New API';
  if (type === 'sub2api') return 'Sub2API';
  return '自定义';
}

export function hostname(value) {
  if (!value) return '尚未配置站点';
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}
