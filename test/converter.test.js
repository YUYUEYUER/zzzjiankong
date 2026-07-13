import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula } from '../server/converter.js';
import { mergeSecrets, readPath } from '../server/collectors.js';

test('converts New API quota to CNY', () => {
  assert.equal(evaluateFormula('x / 500000 * 7.2', 1500000), 21.6);
});
test('supports arithmetic and parentheses only', () => {
  assert.equal(evaluateFormula('(x - 5) * 7.2', 10), 36);
  assert.throws(() => evaluateFormula('sqrt(x)', 9), /仅支持/);
  assert.throws(() => evaluateFormula('x / 0', 9), /转换结果无效/);
});

test('reads nested balance fields', () => {
  assert.equal(readPath({ data: { quota: 500000 } }, 'data.quota'), 500000);
});

test('mergeSecrets keeps existing tokens and drops one-shot turnstile', () => {
  const merged = mergeSecrets(
    { accessToken: 'old-at', refreshToken: 'old-rt', password: 'secret', turnstileToken: 'stale' },
    { accessToken: 'new-at', turnstileToken: '' },
  );
  assert.equal(merged.accessToken, 'new-at');
  assert.equal(merged.refreshToken, 'old-rt');
  assert.equal(merged.password, 'secret');
  assert.equal(merged.turnstileToken, undefined);
});
