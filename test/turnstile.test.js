import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSiteKeyFromText,
  getTurnstileSolverStatus,
  isTurnstileFailure,
} from '../server/turnstile.js';
import { isCloudflareChallenge } from '../server/collectors.js';
import { browserSelectors } from '../server/turnstile-browser.js';

test('detects TURNSTILE_VERIFICATION_FAILED reason', () => {
  assert.equal(isTurnstileFailure({ reason: 'TURNSTILE_VERIFICATION_FAILED' }), true);
  assert.equal(isTurnstileFailure({ message: 'invalid password' }), false);
  assert.equal(isTurnstileFailure({}, 'Cloudflare captcha required'), true);
  assert.equal(isTurnstileFailure({ error: '人机验证失败' }), true);
});

test('extracts turnstile sitekey from HTML and JS snippets', () => {
  const html = '<div class="cf-turnstile" data-sitekey="0x4AAAAAAAbCdEfGhIjKlMnOp"></div>';
  assert.equal(extractSiteKeyFromText(html), '0x4AAAAAAAbCdEfGhIjKlMnOp');

  const js = 'const cfg={siteKey:"0x4AAAAAAAxYz1234567890abcd",mode:"managed"}';
  assert.equal(extractSiteKeyFromText(js), '0x4AAAAAAAxYz1234567890abcd');

  const envStyle = 'VITE_TURNSTILE_SITE_KEY="0x4AAAAAAAEnvStyleKey000001"';
  assert.equal(extractSiteKeyFromText(envStyle), '0x4AAAAAAAEnvStyleKey000001');

  assert.equal(extractSiteKeyFromText('no key here'), '');
});

test('solver status: browser enabled without api key', () => {
  assert.deepEqual(getTurnstileSolverStatus({ turnstileSolver: 'none', turnstileSolverApiKey: '' }), {
    enabled: false,
    provider: 'none',
    mode: 'off',
  });
  assert.equal(getTurnstileSolverStatus({ turnstileSolver: 'browser', turnstileHeadless: true }).enabled, true);
  assert.equal(getTurnstileSolverStatus({ turnstileSolver: 'browser' }).provider, 'browser');
  assert.equal(getTurnstileSolverStatus({ turnstileSolver: 'browser' }).mode, 'dom_human');
  assert.deepEqual(getTurnstileSolverStatus({ turnstileSolver: 'capsolver', turnstileSolverApiKey: '' }), {
    enabled: false,
    provider: 'none',
    mode: 'off',
  });
  assert.deepEqual(getTurnstileSolverStatus({ turnstileSolver: 'capsolver', turnstileSolverApiKey: 'sk-test' }), {
    enabled: true,
    provider: 'capsolver',
    mode: 'api',
  });
});

test('browser selector packs cover turnstile and login fields', () => {
  assert.ok(browserSelectors.TURNSTILE_HOST_SELECTORS.some((s) => s.includes('cf-turnstile')));
  assert.ok(browserSelectors.TOKEN_INPUT_SELECTORS.some((s) => s.includes('cf-turnstile-response')));
  assert.ok(browserSelectors.EMAIL_SELECTORS.some((s) => s.includes('email')));
  assert.ok(browserSelectors.PASSWORD_SELECTORS.some((s) => s.includes('password')));
  assert.ok(browserSelectors.SUBMIT_SELECTORS.length >= 3);
});

test('isCloudflareChallenge covers pages and turnstile bodies', () => {
  assert.equal(isCloudflareChallenge(new Error('上游返回了 Cloudflare 挑战页而非 JSON (403)')), true);
  assert.equal(isCloudflareChallenge({ reason: 'TURNSTILE_VERIFICATION_FAILED' }), true);
  assert.equal(isCloudflareChallenge(new Error('余额字段无效')), false);
});
