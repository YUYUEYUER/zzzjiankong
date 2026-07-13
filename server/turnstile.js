/**
 * Cloudflare Turnstile helpers for Sub2API password login.
 * - Detects turnstile-related login failures
 * - Discovers sitekey from upstream HTML/JS
 * - Completes the authorized browser login flow and verifies the result
 *   or optional CapSolver / 2Captcha
 */

import crypto from 'node:crypto';

const SITEKEY_PATTERNS = [
  /data-sitekey=["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /sitekey["']?\s*[:=]\s*["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /TURNSTILE[_-]?SITE[_-]?KEY["']?\s*[:=]\s*["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /VITE_TURNSTILE[_A-Z0-9]*["']?\s*[:=]\s*["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /turnstile[_-]?site[_-]?key["']?\s*[:=]\s*["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /["']siteKey["']\s*:\s*["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /cf-turnstile[^>]{0,200}sitekey=["'](0x[0-9A-Za-z_-]{20,})["']/i,
  /(0x4[0-9A-Za-z_-]{20,})/,
];

const siteKeyCache = new Map();
const originSolveQueues = new Map();
const browserSolveWaiters = [];
const oneShotTokenUses = new Map();
let activeBrowserSolves = 0;
const browserSolveMetrics = { completed: 0, failed: 0, totalDurationMs: 0 };
const SITE_KEY_CACHE_TTL_MS = 60 * 60 * 1000;

export const TURNSTILE_TOKEN_TTL_MS = 300000;
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** Reject manual token replay without retaining the raw token in memory. */
export function consumeOneShotTurnstileToken(token, current = Date.now()) {
  for (const [fingerprint, expiresAt] of oneShotTokenUses) {
    if (expiresAt <= current) oneShotTokenUses.delete(fingerprint);
  }
  const value = String(token || '');
  if (value.length < 20 || value.length > TURNSTILE_TOKEN_MAX_LENGTH) return false;
  const fingerprint = crypto.createHash('sha256').update(value).digest('hex');
  if (oneShotTokenUses.has(fingerprint)) return false;
  oneShotTokenUses.set(fingerprint, current + TURNSTILE_TOKEN_TTL_MS);
  return true;
}

export function isTurnstileFailure(body = {}, reason = '') {
  const text = [
    body?.reason,
    body?.error,
    body?.message,
    body?.code,
    reason,
  ]
    .filter(Boolean)
    .map(String)
    .join(' ');

  if (body?.reason === 'TURNSTILE_VERIFICATION_FAILED') return true;
  if (body?.code === 'TURNSTILE_VERIFICATION_FAILED') return true;
  return /turnstile|captcha|人机|cloudflare|cf.?challenge|challenge.?required/i.test(text);
}

function responseHeader(response, name) {
  try {
    return String(response?.headers?.get?.(name) || '');
  } catch {
    return '';
  }
}

/** Classify Cloudflare/Turnstile responses without relying on a single vendor payload shape. */
export function detectTurnstileChallenge({ response, body = {}, text = '', reason = '' } = {}) {
  const status = Number(response?.status || 0);
  const mitigated = responseHeader(response, 'cf-mitigated').toLowerCase();
  const contentType = responseHeader(response, 'content-type').toLowerCase();
  const server = responseHeader(response, 'server').toLowerCase();

  if (mitigated === 'challenge') {
    return { detected: true, source: 'cf-mitigated', status, contentType };
  }
  const explicitTurnstileFailure = [body?.reason, body?.code, reason]
    .filter(Boolean)
    .some((value) => /^(?:TURNSTILE_VERIFICATION_FAILED|TURNSTILE_REQUIRED|CF_CHALLENGE_PAGE)$/i.test(String(value)));
  const failedEnvelope = status >= 400
    || body?.success === false
    || Boolean(body?.reason)
    || Boolean(body?.error)
    || (Object.hasOwn(body || {}, 'code') && ![0, 200, true, '0', '200'].includes(body.code));
  if (explicitTurnstileFailure || (failedEnvelope && isTurnstileFailure(body, reason))) {
    return { detected: true, source: 'json', status, contentType };
  }

  const sample = String(text || '').slice(0, 200000);
  const hasChallengeMarkup = /cf-turnstile|challenges\.cloudflare\.com|cf-browser-verification|challenge-platform|cdn-cgi\/challenge|just a moment|turnstile/i.test(sample);
  const looksLikeChallengePage = contentType.includes('text/html')
    || [403, 429, 503].includes(status)
    || server.includes('cloudflare');
  if (hasChallengeMarkup && looksLikeChallengePage) {
    return { detected: true, source: 'html', status, contentType };
  }
  return { detected: false, source: 'none', status, contentType };
}

export function turnstileTokenState(result = {}, current = Date.now()) {
  const token = String(result.token || '');
  if (token.length < 20 || token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    return { usable: false, reason: 'missing_or_malformed' };
  }
  if (result.tokenConsumed === true) return { usable: false, reason: 'already_consumed' };

  const obtainedAt = new Date(result.tokenObtainedAt || 0).getTime();
  if (!Number.isFinite(obtainedAt) || obtainedAt <= 0) {
    return { usable: false, reason: 'missing_obtained_at' };
  }
  if (current - obtainedAt >= TURNSTILE_TOKEN_TTL_MS) {
    return { usable: false, reason: 'expired' };
  }
  return {
    usable: true,
    reason: 'ready',
    ageMs: Math.max(0, current - obtainedAt),
    expiresAt: new Date(obtainedAt + TURNSTILE_TOKEN_TTL_MS).toISOString(),
  };
}

/** Turnstile tokens are single-use; serialize solves per upstream origin instead of sharing results. */
export async function withTurnstileOriginLock(rootUrl, task) {
  const key = new URL(String(rootUrl)).origin;
  const previous = originSolveQueues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  originSolveQueues.set(key, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (originSolveQueues.get(key) === tail) originSolveQueues.delete(key);
  }
}

/** Bound Chromium processes across different origins to protect server memory. */
export async function withTurnstileBrowserSlot(task, maxConcurrency = 2, queueLimit = 20) {
  const limit = Math.min(4, Math.max(1, Number(maxConcurrency) || 2));
  const maxQueue = Math.min(200, Math.max(1, Number(queueLimit) || 20));
  if (activeBrowserSolves >= limit && browserSolveWaiters.length >= maxQueue) {
    const error = new Error('Turnstile 浏览器队列已满，请稍后重试');
    error.code = 'TURNSTILE_SOLVER_BUSY';
    throw error;
  }
  await new Promise((resolve) => {
    browserSolveWaiters.push({ limit, resolve });
    while (browserSolveWaiters.length && activeBrowserSolves < browserSolveWaiters[0].limit) {
      activeBrowserSolves += 1;
      browserSolveWaiters.shift().resolve();
    }
  });
  const startedAt = Date.now();
  try {
    const result = await task();
    browserSolveMetrics.completed += 1;
    return result;
  } catch (error) {
    browserSolveMetrics.failed += 1;
    throw error;
  } finally {
    browserSolveMetrics.totalDurationMs += Date.now() - startedAt;
    activeBrowserSolves -= 1;
    while (browserSolveWaiters.length && activeBrowserSolves < browserSolveWaiters[0].limit) {
      activeBrowserSolves += 1;
      browserSolveWaiters.shift().resolve();
    }
  }
}

export function extractSiteKeyFromText(text = '') {
  if (!text) return '';
  for (const pattern of SITEKEY_PATTERNS) {
    const match = String(text).match(pattern);
    if (match?.[1] && /^0x[0-9A-Za-z_-]{20,}$/.test(match[1])) {
      return match[1];
    }
  }
  return '';
}

function extractScriptSrcs(html, baseUrl) {
  const srcs = [];
  const re = /<script[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) && srcs.length < 12) {
    try {
      srcs.push(new URL(match[1], baseUrl).toString());
    } catch {
      // ignore invalid URLs
    }
  }
  return srcs;
}

async function fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'FrostedConsole/1.0 (+turnstile-sitekey-discovery)',
      },
      redirect: 'follow',
    });
    if (!response.ok) return '';
    return await response.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discover Turnstile sitekey from an upstream site.
 * Checks HTML pages first, then a few linked scripts.
 */
export async function discoverTurnstileSiteKey(rootUrl, options = {}) {
  const root = String(rootUrl || '').replace(/\/$/, '');
  if (!root) throw new Error('缺少站点地址，无法发现 Turnstile sitekey');

  if (!options.skipCache && siteKeyCache.has(root)) {
    const cached = siteKeyCache.get(root);
    if (cached?.expiresAt > Date.now()) return cached.siteKey;
    siteKeyCache.delete(root);
  }

  const candidates = [
    root,
    `${root}/`,
    `${root}/login`,
    `${root}/auth/login`,
    `${root}/signin`,
    `${root}/index.html`,
  ];

  for (const url of candidates) {
    const html = await fetchText(url, options.timeoutMs);
    if (!html) continue;

    const fromHtml = extractSiteKeyFromText(html);
    if (fromHtml) {
      siteKeyCache.set(root, { siteKey: fromHtml, expiresAt: Date.now() + SITE_KEY_CACHE_TTL_MS });
      return fromHtml;
    }

    const scripts = extractScriptSrcs(html, url)
      .filter((src) => {
        try {
          return new URL(src).origin === new URL(root).origin;
        } catch {
          return false;
        }
      })
      .filter((src) => /\.(js|mjs)(\?|$)/i.test(src) || /assets|static|chunk|index/i.test(src))
      .slice(0, 8);

    for (const scriptUrl of scripts) {
      const js = await fetchText(scriptUrl, options.timeoutMs);
      const fromJs = extractSiteKeyFromText(js);
      if (fromJs) {
        siteKeyCache.set(root, { siteKey: fromJs, expiresAt: Date.now() + SITE_KEY_CACHE_TTL_MS });
        return fromJs;
      }
    }
  }

  throw new Error(
    '未能自动发现 Turnstile sitekey。请在账号高级设置中手动填写 sitekey，'
    + '或在上游登录页 HTML 中查找 data-sitekey / 0x4... 值。',
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, payload, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`打码服务返回非 JSON (${response.status})`);
    }
    return { response, body };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('打码服务请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function solveWithCapSolver({ apiKey, websiteURL, websiteKey, timeoutMs = 120000 }) {
  const create = await postJson('https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL,
      websiteKey,
    },
  });

  if (create.body?.errorId && create.body.errorId !== 0) {
    throw new Error(`CapSolver 创建任务失败：${create.body.errorDescription || create.body.errorCode || 'unknown'}`);
  }

  const taskId = create.body?.taskId;
  if (!taskId) throw new Error('CapSolver 未返回 taskId');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2500);
    const poll = await postJson('https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId,
    });
    if (poll.body?.errorId && poll.body.errorId !== 0) {
      throw new Error(`CapSolver 解算失败：${poll.body.errorDescription || poll.body.errorCode || 'unknown'}`);
    }
    if (poll.body?.status === 'ready') {
      const token = poll.body?.solution?.token || poll.body?.solution?.gRecaptchaResponse;
      if (!token) throw new Error('CapSolver 返回成功但未包含 token');
      return String(token);
    }
  }
  throw new Error('CapSolver 解算超时');
}

async function solveWith2Captcha({ apiKey, websiteURL, websiteKey, timeoutMs = 120000 }) {
  const create = await postJson('https://api.2captcha.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'TurnstileTaskProxyless',
      websiteURL,
      websiteKey,
    },
  });

  if (create.body?.errorId && create.body.errorId !== 0) {
    throw new Error(`2Captcha 创建任务失败：${create.body.errorDescription || create.body.errorCode || 'unknown'}`);
  }

  const taskId = create.body?.taskId;
  if (!taskId) throw new Error('2Captcha 未返回 taskId');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const poll = await postJson('https://api.2captcha.com/getTaskResult', {
      clientKey: apiKey,
      taskId,
    });
    if (poll.body?.errorId && poll.body.errorId !== 0) {
      throw new Error(`2Captcha 解算失败：${poll.body.errorDescription || poll.body.errorCode || 'unknown'}`);
    }
    if (poll.body?.status === 'ready') {
      const token = poll.body?.solution?.token || poll.body?.solution?.gRecaptchaResponse;
      if (!token) throw new Error('2Captcha 返回成功但未包含 token');
      return String(token);
    }
  }
  throw new Error('2Captcha 解算超时');
}

/**
 * Solve Turnstile using the configured provider.
 * Browser mode returns a rich result via obtainTurnstileToken instead.
 */
export async function solveTurnstileToken({
  provider,
  apiKey,
  websiteURL,
  websiteKey,
  timeoutMs = 120000,
}) {
  if (!provider || provider === 'none') {
    throw new Error('未配置 Turnstile 自动解算（TURNSTILE_SOLVER）');
  }
  if (!websiteURL) throw new Error('缺少 websiteURL');

  const normalized = String(provider).toLowerCase();
  if (normalized === 'browser') {
    throw new Error('browser 模式请使用 obtainTurnstileToken（支持 DOM 识别与模拟操作）');
  }
  if (!apiKey) throw new Error(`Turnstile 解算器 ${provider} 缺少 API Key`);
  if (!websiteKey) throw new Error('缺少 Turnstile sitekey');

  if (normalized === 'capsolver') {
    return solveWithCapSolver({ apiKey, websiteURL, websiteKey, timeoutMs });
  }
  if (normalized === '2captcha' || normalized === 'twocaptcha') {
    return solveWith2Captcha({ apiKey, websiteURL, websiteKey, timeoutMs });
  }
  throw new Error(`不支持的 Turnstile 解算器：${provider}（可选 browser / capsolver / 2captcha）`);
}

/**
 * High-level helper: obtain a turnstile token (and optionally AT/RT via browser login).
 */
export async function obtainTurnstileToken({
  rootUrl,
  platform = '',
  siteKey,
  provider,
  apiKey,
  timeoutMs,
  email = '',
  password = '',
  headless = true,
  verificationPaths = [],
  verificationHeaders = {},
  verificationBalancePath = '',
  upstreamHeaders = {},
  disableSandbox = false,
  maxBrowserConcurrency = 2,
  browserQueueLimit = 20,
}) {
  const websiteURL = String(rootUrl || '').replace(/\/$/, '');
  const normalized = String(provider || 'none').toLowerCase();

  return withTurnstileOriginLock(websiteURL, async () => {
    if (normalized === 'browser') {
      const result = await withTurnstileBrowserSlot(async () => {
        const { browserSolveTurnstile } = await import('./turnstile-browser.js');
        return browserSolveTurnstile({
          rootUrl: websiteURL,
          platform,
          email,
          password,
          siteKey: String(siteKey || '').trim(),
          timeoutMs: timeoutMs || 120000,
          headless,
          attemptLogin: Boolean(email && password),
          verificationPaths,
          verificationHeaders,
          verificationBalancePath,
          upstreamHeaders,
          disableSandbox,
        });
      }, maxBrowserConcurrency, browserQueueLimit);
      if (result.siteKey) {
        siteKeyCache.set(websiteURL, { siteKey: result.siteKey, expiresAt: Date.now() + SITE_KEY_CACHE_TTL_MS });
      }
      const tokenObtainedAt = result.tokenObtainedAt || new Date().toISOString();
      return {
        token: result.token,
        tokenObtainedAt,
        tokenExpiresAt: result.tokenExpiresAt || new Date(new Date(tokenObtainedAt).getTime() + TURNSTILE_TOKEN_TTL_MS).toISOString(),
        tokenConsumed: result.tokenConsumed === true,
        siteKey: result.siteKey || siteKey || '',
        accessToken: result.accessToken || '',
        refreshToken: result.refreshToken || '',
        cookies: result.cookies || '',
        userAgent: result.userAgent || '',
        profile: result.profile || null,
        tokensPendingVerification: result.tokensPendingVerification === true,
        method: result.method,
        dom: result.dom,
        pageUrl: result.pageUrl || websiteURL,
        challengeState: result.challengeState || null,
      };
    }

    let websiteKey = String(siteKey || '').trim();
    if (!websiteKey) {
      websiteKey = await discoverTurnstileSiteKey(websiteURL);
    }
    const token = await solveTurnstileToken({
      provider,
      apiKey,
      websiteURL,
      websiteKey,
      timeoutMs,
    });
    const tokenObtainedAt = new Date().toISOString();
    return {
      token,
      tokenObtainedAt,
      tokenExpiresAt: new Date(Date.now() + TURNSTILE_TOKEN_TTL_MS).toISOString(),
      tokenConsumed: false,
      siteKey: websiteKey,
      method: normalized,
      pageUrl: websiteURL,
    };
  });
}

export function clearSiteKeyCache() {
  siteKeyCache.clear();
}

export function getTurnstileSolverStatus(config) {
  const provider = String(config?.turnstileSolver || 'none').toLowerCase();
  if (provider === 'none') {
    return { enabled: false, provider: 'none', mode: 'off' };
  }
  if (provider === 'browser') {
    return {
      enabled: true,
      provider: 'browser',
      mode: 'dom_human',
      headless: config?.turnstileHeadless !== false,
      workers: Number(config?.turnstileBrowserConcurrency || 2),
      active: activeBrowserSolves,
      queued: browserSolveWaiters.length,
      completed: browserSolveMetrics.completed,
      failed: browserSolveMetrics.failed,
      averageDurationMs: browserSolveMetrics.completed + browserSolveMetrics.failed
        ? Math.round(browserSolveMetrics.totalDurationMs / (browserSolveMetrics.completed + browserSolveMetrics.failed))
        : 0,
    };
  }
  const enabled = Boolean(config?.turnstileSolverApiKey);
  return {
    enabled,
    provider: enabled ? provider : 'none',
    mode: enabled ? 'api' : 'off',
  };
}
