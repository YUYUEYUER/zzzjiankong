import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyBurnRate, depletionEtaDays } from '../server/burn-rate.js';
import { credentialExpiryMs } from '../server/collectors.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 30, 12);

function series(start, perDay, days) {
  // index 越大越旧：perDay>0 表示余额随时间每天下降 perDay（最新值最低）
  return Array.from({ length: days }, (_, index) => ({
    id: `s-${index}`,
    accountId: 'a1',
    rawBalance: start + index * perDay,
    convertedCny: start + index * perDay,
    capturedAt: new Date(NOW - index * DAY).toISOString(),
  }));
}

test('burn rate recovers a linear daily consumption trend', () => {
  // 5 个点、每天下降 2 元 → 速率约 2 CNY/天
  const rate = computeDailyBurnRate(series(100, 2, 5), { now: NOW });
  assert.ok(Math.abs(rate - 2) < 0.01, `expected ≈2, got ${rate}`);
});

test('burn rate is zero when balance is flat or rising', () => {
  assert.equal(computeDailyBurnRate(series(100, 0, 5), { now: NOW }), 0);
  assert.equal(computeDailyBurnRate(series(100, -3, 5), { now: NOW }), 0); // 余额每天上涨 3
});

test('burn rate requires enough points and time span', () => {
  assert.equal(computeDailyBurnRate(series(100, 2, 2), { now: NOW }), 0);
  // 三个点挤在一小时内 → span 不足一天
  const tight = [0, 1, 2].map((hours) => ({
    accountId: 'a1', convertedCny: 100 - hours, capturedAt: new Date(NOW - hours * 3600000).toISOString(),
  }));
  assert.equal(computeDailyBurnRate(tight, { now: NOW }), 0);
});

test('burn rate ignores malformed rows and snapshots outside the window', () => {
  const rows = [
    ...series(50, 1, 4),
    { accountId: 'a1', convertedCny: 'bad', capturedAt: new Date(NOW).toISOString() },
    { accountId: 'a1', convertedCny: 10, capturedAt: 'not-a-date' },
    { accountId: 'a1', convertedCny: 999, capturedAt: new Date(NOW - 30 * DAY).toISOString() },
  ];
  const rate = computeDailyBurnRate(rows, { now: NOW });
  assert.ok(Math.abs(rate - 1) < 0.01, `expected ≈1, got ${rate}`);
});

test('depletion ETA divides headroom by burn rate', () => {
  assert.equal(depletionEtaDays(100, 20, 4), 20);
  assert.equal(depletionEtaDays(10, 20, 4), 0); // 已低于阈值
  assert.equal(depletionEtaDays(100, 20, 0), null);
  assert.equal(depletionEtaDays(100, 20, null), null);
  assert.equal(depletionEtaDays(Number.NaN, 20, 4), null);
});

test('credential expiry normalization handles ISO, unix seconds and sentinel values', () => {
  // ISO 字符串与毫秒时间戳
  assert.equal(credentialExpiryMs('2027-01-01T00:00:00.000Z'), Date.UTC(2027, 0, 1));
  assert.equal(credentialExpiryMs(Date.UTC(2027, 0, 1)), Date.UTC(2027, 0, 1));
  // unix 秒级时间戳自动升毫秒
  assert.equal(credentialExpiryMs(1798761600), Date.UTC(2027, 0, 1));
  // 数字字符串同样按秒/毫秒识别
  assert.equal(credentialExpiryMs('1798761600'), Date.UTC(2027, 0, 1));
  assert.equal(credentialExpiryMs('1798761600000'), Date.UTC(2027, 0, 1));
  // New API 风格"永不过期"哨兵与非法值一律按无到期信息处理
  assert.ok(Number.isNaN(credentialExpiryMs(-1)));
  assert.ok(Number.isNaN(credentialExpiryMs(0)));
  assert.ok(Number.isNaN(credentialExpiryMs('-1')));
  assert.ok(Number.isNaN(credentialExpiryMs('never')));
  assert.ok(Number.isNaN(credentialExpiryMs('not-a-date')));
  assert.ok(Number.isNaN(credentialExpiryMs(null)));
  assert.ok(Number.isNaN(credentialExpiryMs(undefined)));
  assert.ok(Number.isNaN(credentialExpiryMs('')));
});
