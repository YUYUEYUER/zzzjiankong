/** 余额消耗速率估算：对窗口内快照做最小二乘回归，得到日均消耗（CNY/天）。 */

const DAY_MS = 86_400_000;

/**
 * @param {Array<{convertedCny:number, capturedAt:string}>} snapshots 任意顺序的账号快照
 * @param {{windowDays?:number, minPoints?:number, minSpanMs?:number, now?:number}} options
 * @returns {number} 日均消耗 CNY；返回 0 表示余额持平/上升或数据不足以判断
 */
export function computeDailyBurnRate(snapshots, { windowDays = 14, minPoints = 3, minSpanMs = DAY_MS, now = Date.now() } = {}) {
  const cutoff = now - windowDays * DAY_MS;
  const points = (Array.isArray(snapshots) ? snapshots : [])
    .map((item) => ({ t: new Date(item.capturedAt).getTime(), y: Number(item.convertedCny) }))
    .filter((item) => Number.isFinite(item.t) && Number.isFinite(item.y) && item.t >= cutoff && item.t <= now)
    .sort((a, b) => a.t - b.t);
  if (points.length < minPoints) return 0;
  const span = points[points.length - 1].t - points[0].t;
  if (span < minSpanMs) return 0;

  const meanT = points.reduce((sum, item) => sum + item.t, 0) / points.length;
  const meanY = points.reduce((sum, item) => sum + item.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const item of points) {
    numerator += (item.t - meanT) * (item.y - meanY);
    denominator += (item.t - meanT) ** 2;
  }
  if (!denominator) return 0;
  // slope: CNY/ms，余额下降时为负 → 取负号为消耗速率
  const slopePerDay = (numerator / denominator) * DAY_MS;
  return Math.max(0, -slopePerDay);
}

/**
 * @param {number} convertedCny 当前折算余额
 * @param {number} thresholdLow 告警阈值
 * @param {number} dailyBurnRate 日均消耗（CNY/天）
 * @returns {number|null} 预计多少天后余额跌破阈值；无法预测（无消耗）时为 null
 */
export function depletionEtaDays(convertedCny, thresholdLow, dailyBurnRate) {
  const headroom = Number(convertedCny) - Number(thresholdLow || 0);
  const burn = Number(dailyBurnRate);
  if (!Number.isFinite(headroom) || !Number.isFinite(burn) || burn <= 0) return null;
  return Math.max(0, Math.round((headroom / burn) * 10) / 10);
}
