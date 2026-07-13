/**
 * Browser-based Turnstile handling:
 * - Discover related DOM / iframe / hidden inputs
 * - Perform the login page's normal browser interactions
 * - Capture turnstile token and (when possible) full login AT/RT
 */

import { extractSiteKeyFromText, TURNSTILE_TOKEN_TTL_MS } from './turnstile.js';

const LOGIN_PATHS = ['/login', '/auth/login', '/signin', '/sign-in', '/user/login', '/'];

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="邮箱" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="账号" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password" i]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="密码" i]',
  'input[placeholder*="password" i]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("登录")',
  'button:has-text("登 录")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  '[data-testid*="login" i]',
  'form button',
];

const TURNSTILE_HOST_SELECTORS = [
  '.cf-turnstile',
  '[data-sitekey]',
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  '#cf-turnstile',
  '[id*="turnstile" i]',
  '[class*="turnstile" i]',
];

const TOKEN_INPUT_SELECTORS = [
  'input[name="cf-turnstile-response"]',
  'textarea[name="cf-turnstile-response"]',
  'input[name="turnstile_token"]',
  'input[name="turnstileToken"]',
  'input[id*="cf-turnstile-response" i]',
  '[name="cf-turnstile-response"]',
];

const FORM_LOGIN_ENDPOINTS = new Set(['/login', '/auth/login', '/signin', '/sign-in', '/user/login']);

export function resolveUpstreamUrl(rootUrl, path = '') {
  const root = new URL(rootUrl);
  const value = String(path || '');
  const target = /^https?:\/\//i.test(value)
    ? new URL(value)
    : new URL(`${root.toString().replace(/\/$/, '')}/${value.replace(/^\/+/, '')}`);
  if (target.origin !== root.origin) throw new Error('上游路径不得跨域');
  return target;
}

export function isUpstreamLoginEndpoint(candidateUrl, rootUrl, platform = '') {
  try {
    const candidate = new URL(candidateUrl);
    const root = new URL(rootUrl);
    if (candidate.origin !== root.origin) return false;
    const rootPath = root.pathname === '/' ? '' : root.pathname.replace(/\/+$/, '');
    if (rootPath && candidate.pathname !== rootPath && !candidate.pathname.startsWith(`${rootPath}/`)) return false;
    const relativePath = rootPath ? candidate.pathname.slice(rootPath.length) || '/' : candidate.pathname;
    const path = relativePath.length > 1 ? relativePath.replace(/\/+$/, '') : relativePath;
    if (FORM_LOGIN_ENDPOINTS.has(path)) return true;
    if (platform === 'newapi') return path === '/api/user/login';
    if (platform === 'sub2api') return path === '/api/v1/auth/login';
    return path === '/api/user/login' || path === '/api/v1/auth/login';
  } catch {
    return false;
  }
}

export function extractSubmittedTurnstileToken(postData = '', contentType = '') {
  const body = String(postData || '');
  if (!body) return '';
  const names = ['turnstile_token', 'turnstileToken', 'cf-turnstile-response', 'cf_turnstile_response'];
  let candidate = '';

  if (/application\/json/i.test(contentType)) {
    try {
      const parsed = JSON.parse(body);
      candidate = names.map((name) => parsed?.[name]).find(Boolean) || '';
    } catch {
      // Fall through to conservative pattern matching.
    }
  }
  if (!candidate && /application\/x-www-form-urlencoded/i.test(contentType)) {
    const params = new URLSearchParams(body);
    candidate = names.map((name) => params.get(name)).find(Boolean) || '';
  }
  if (!candidate && /multipart\/form-data/i.test(contentType)) {
    const match = body.match(
      /name=["']?(?:turnstile_token|turnstileToken|cf-turnstile-response|cf_turnstile_response)["']?\r?\n(?:[^\r\n]*\r?\n)*\r?\n([^\r\n]+)/i,
    );
    candidate = match?.[1] || '';
  }
  if (!candidate) {
    const match = body.match(
      /["']?(?:turnstile_token|turnstileToken|cf-turnstile-response|cf_turnstile_response)["']?\s*(?::|=)\s*["']?([^"'&\s;]+)/i,
    );
    candidate = match?.[1] || '';
  }

  try {
    candidate = decodeURIComponent(String(candidate || '').replace(/\+/g, ' '));
  } catch {
    candidate = String(candidate || '');
  }
  return candidate.length >= 20 && candidate.length <= 2048 ? candidate : '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      '浏览器过盾需要安装 Playwright：在 app 目录执行 '
      + '`npm install playwright` 与 `npx playwright install chromium`',
    );
  }
}

async function humanPause(min = 120, max = 420) {
  await sleep(jitter(min, max));
}

async function humanMove(page, x, y) {
  const steps = jitter(8, 18);
  await page.mouse.move(x, y, { steps });
}

async function humanClickLocator(page, locator) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    await locator.click({ timeout: 4000 }).catch(() => {});
    return;
  }
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  await humanMove(page, x, y);
  await humanPause(80, 220);
  await page.mouse.down();
  await humanPause(40, 120);
  await page.mouse.up();
}

async function humanType(locator, text) {
  await locator.click({ timeout: 5000 }).catch(() => {});
  await humanPause(80, 200);
  await locator.fill('').catch(() => {});
  for (const ch of String(text)) {
    await locator.type(ch, { delay: jitter(35, 110) });
  }
}

async function firstVisible(page, selectors, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        const visible = await locator.isVisible().catch(() => false);
        if (visible) return locator;
      }
    }
    await sleep(150);
  }
  return null;
}

async function installTurnstileHooks(page) {
  await page.addInitScript(({ tokenTtlMs }) => {
    window.__frostedTurnstile = {
      token: '',
      tokenObtainedAt: 0,
      tokenConsumed: false,
      expired: false,
      tokenStates: [],
      interactive: false,
      errors: [],
      siteKey: '',
      events: [],
    };

    const syncCurrent = (entry) => {
      const state = window.__frostedTurnstile;
      if (!entry) return;
      if (Date.now() - entry.obtainedAt >= tokenTtlMs) entry.expired = true;
      state.token = entry.token;
      state.tokenObtainedAt = entry.obtainedAt;
      state.tokenConsumed = entry.consumed === true;
      state.expired = entry.expired === true;
    };

    const remember = (token, source) => {
      if (!token || typeof token !== 'string') return;
      if (token.length < 20) return;
      const state = window.__frostedTurnstile;
      let entry = state.tokenStates.find((item) => item.token === token);
      if (!entry) {
        entry = { token, obtainedAt: Date.now(), consumed: false, expired: false };
        state.tokenStates.push(entry);
      }
      syncCurrent(entry);
      state.events.push({
        source,
        at: Date.now(),
        len: token.length,
        accepted: !entry.consumed && !entry.expired,
      });
      state.events = state.events.slice(-30);
      return !entry.consumed && !entry.expired;
    };

    const markToken = (token, field, source) => {
      if (!token || typeof token !== 'string') return;
      const state = window.__frostedTurnstile;
      let entry = state.tokenStates.find((item) => item.token === token);
      if (!entry) {
        entry = { token, obtainedAt: Date.now(), consumed: false, expired: false };
        state.tokenStates.push(entry);
      }
      if (field === 'consumed') entry.consumed = true;
      if (field === 'expired') entry.expired = true;
      if (state.token === token) syncCurrent(entry);
      state.events.push({ source, at: Date.now(), len: token.length, accepted: false });
      state.events = state.events.slice(-30);
    };

    window.__frostedRememberTurnstile = remember;
    window.__frostedMarkTurnstile = markToken;

    const wrapCallback = (options, key, callback) => (...args) => {
      if (key === 'expired-callback') {
        markToken(window.__frostedTurnstile.token, 'expired', 'turnstile.expired');
      }
      if (key === 'before-interactive-callback') window.__frostedTurnstile.interactive = true;
      if (key === 'after-interactive-callback') window.__frostedTurnstile.interactive = false;
      if (key === 'error-callback' || key === 'timeout-callback') {
        window.__frostedTurnstile.errors.push({ type: key, at: Date.now(), code: String(args[0] || '') });
      }
      if (typeof callback === 'function') return callback(...args);
      return undefined;
    };

    const patchTurnstile = () => {
      const api = window.turnstile;
      if (!api || api.__frostedPatched) return;
      const originalRender = api.render?.bind(api);
      const originalGetResponse = api.getResponse?.bind(api);
      if (originalRender) {
        api.render = (container, options = {}) => {
          if (options?.sitekey) window.__frostedTurnstile.siteKey = options.sitekey;
          const userCb = options.callback;
          const next = {
            ...options,
            callback: (token) => {
              remember(token, 'turnstile.callback');
              if (typeof userCb === 'function') userCb(token);
            },
            'error-callback': wrapCallback(options, 'error-callback', options['error-callback']),
            'expired-callback': wrapCallback(options, 'expired-callback', options['expired-callback']),
            'timeout-callback': wrapCallback(options, 'timeout-callback', options['timeout-callback']),
            'before-interactive-callback': wrapCallback(options, 'before-interactive-callback', options['before-interactive-callback']),
            'after-interactive-callback': wrapCallback(options, 'after-interactive-callback', options['after-interactive-callback']),
          };
          return originalRender(container, next);
        };
      }
      if (originalGetResponse) {
        api.getResponse = (...args) => {
          const token = originalGetResponse(...args);
          remember(token, 'turnstile.getResponse');
          return token;
        };
      }
      api.__frostedPatched = true;
    };

    Object.defineProperty(window, 'turnstile', {
      configurable: true,
      get() {
        return this.__turnstileApi;
      },
      set(value) {
        this.__turnstileApi = value;
        try {
          patchTurnstile();
        } catch {
          // ignore
        }
      },
    });

    const observer = new MutationObserver(() => {
      try {
        patchTurnstile();
      } catch {
        // ignore
      }
      const inputs = document.querySelectorAll(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="turnstile_token"]',
      );
      inputs.forEach((el) => {
        if (el.value) remember(el.value, 'dom.input');
      });
    });
    const start = () => {
      try {
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        patchTurnstile();
      } catch {
        // ignore
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }, { tokenTtlMs: TURNSTILE_TOKEN_TTL_MS });
}

async function readTokenFromPage(page) {
  return page.evaluate(({ tokenSelectors, tokenTtlMs }) => {
    const store = window.__frostedTurnstile;
    const accept = (value, source) => {
      const token = String(value || '');
      if (token.length < 20) return '';
      window.__frostedRememberTurnstile?.(token, source);
      const entry = store?.tokenStates?.find((item) => item.token === token);
      if (!entry) return '';
      if (Date.now() - entry.obtainedAt >= tokenTtlMs) {
        window.__frostedMarkTurnstile?.(token, 'expired', 'token.ttl');
      }
      return entry.consumed || entry.expired ? '' : token;
    };

    const stored = accept(store?.token, 'state.read');
    if (stored) return stored;

    for (const selector of tokenSelectors) {
      const el = document.querySelector(selector);
      const token = accept(el?.value, 'dom.read');
      if (token) return token;
    }

    if (window.turnstile?.getResponse) {
      try {
        const token = window.turnstile.getResponse();
        const accepted = accept(token, 'turnstile.read');
        if (accepted) return accepted;
      } catch {
        // ignore
      }
    }

    const widgets = document.querySelectorAll('[name="cf-turnstile-response"], [data-response]');
    for (const el of widgets) {
      const value = el.value || el.getAttribute('data-response');
      const token = accept(value, 'widget.read');
      if (token) return token;
    }
    return '';
  }, { tokenSelectors: TOKEN_INPUT_SELECTORS, tokenTtlMs: TURNSTILE_TOKEN_TTL_MS });
}

async function readChallengeState(page) {
  return page.evaluate(() => {
    const state = window.__frostedTurnstile || {};
    return {
      tokenLength: String(state.token || '').length,
      tokenObtainedAt: Number(state.tokenObtainedAt || 0),
      tokenConsumed: state.tokenConsumed === true,
      expired: state.expired === true,
      interactive: state.interactive === true,
      errors: Array.isArray(state.errors) ? state.errors.slice(-5) : [],
      events: Array.isArray(state.events) ? state.events.slice(-10) : [],
    };
  }).catch(() => ({
    tokenLength: 0,
    tokenObtainedAt: 0,
    tokenConsumed: false,
    expired: false,
    interactive: false,
    errors: [],
    events: [],
  }));
}

async function readSiteKeyFromPage(page) {
  return page.evaluate(() => {
    if (window.__frostedTurnstile?.siteKey) return window.__frostedTurnstile.siteKey;
    const host = document.querySelector('.cf-turnstile, [data-sitekey]');
    const key = host?.getAttribute('data-sitekey') || '';
    if (key) return key;
    const html = document.documentElement?.innerHTML || '';
    const match = html.match(/0x4[0-9A-Za-z_-]{20,}/);
    return match?.[0] || '';
  });
}

async function discoverTurnstileDom(page) {
  return page.evaluate((hostSelectors) => {
    const nodes = [];
    for (const selector of hostSelectors) {
      document.querySelectorAll(selector).forEach((el, index) => {
        const rect = el.getBoundingClientRect();
        nodes.push({
          selector,
          index,
          tag: el.tagName.toLowerCase(),
          siteKey: el.getAttribute?.('data-sitekey') || '',
          src: el.getAttribute?.('src') || '',
          visible: rect.width > 0 && rect.height > 0,
          box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      });
    }
    const tokenInputs = Array.from(
      document.querySelectorAll(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name="turnstile_token"]',
      ),
    ).map((el) => ({
      name: el.getAttribute('name'),
      hasValue: Boolean(el.value),
      valueLength: el.value ? el.value.length : 0,
    }));
    const state = window.__frostedTurnstile || {};
    return {
      nodes,
      tokenInputs,
      hasTurnstileApi: Boolean(window.turnstile),
      challengeState: {
        interactive: state.interactive === true,
        expired: state.expired === true,
        tokenConsumed: state.tokenConsumed === true,
        errors: Array.isArray(state.errors) ? state.errors.slice(-5) : [],
      },
    };
  }, TURNSTILE_HOST_SELECTORS);
}

async function interactWithTurnstile(page) {
  // Gentle page activity that managed challenges often expect
  await page.mouse.move(jitter(40, 120), jitter(40, 120), { steps: 6 });
  await humanPause(100, 250);
  await page.mouse.wheel(0, jitter(80, 220));
  await humanPause(150, 350);

  const host = await firstVisible(page, TURNSTILE_HOST_SELECTORS, 4000);
  if (host) {
    await host.scrollIntoViewIfNeeded().catch(() => {});
    await humanPause(120, 280);
    await humanClickLocator(page, host);
    await humanPause(200, 500);
  }

  // Click checkbox / challenge inside Cloudflare iframes
  for (const frame of page.frames()) {
    const url = frame.url() || '';
    if (!/challenges\.cloudflare\.com|turnstile|cdn-cgi\/challenge-platform/i.test(url)) continue;

    const candidates = [
      'input[type="checkbox"]',
      'label',
      '#challenge-stage',
      '.ctp-checkbox-label',
      '[role="checkbox"]',
    ];
    for (const selector of candidates) {
      const locator = frame.locator(selector).first();
      if (!(await locator.count().catch(() => 0))) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await humanClickLocator(page, locator).catch(() => {});
      await humanPause(250, 600);
      break;
    }
  }
}

async function waitForTurnstileToken(page, timeoutMs, excludedToken = '') {
  const deadline = Date.now() + timeoutMs;
  let lastDom = null;
  while (Date.now() < deadline) {
    const token = await readTokenFromPage(page);
    if (token && token !== excludedToken) return token;

    lastDom = await discoverTurnstileDom(page);
    // re-nudge periodically
    if ((deadline - Date.now()) % 8000 < 450) {
      await interactWithTurnstile(page);
    }
    await sleep(400);
  }

  const detail = lastDom
    ? `检测到节点 ${lastDom.nodes.length} 个，token 输入框 ${lastDom.tokenInputs.length} 个`
    : '未发现 Turnstile 节点';
  const state = await readChallengeState(page);
  const interactionHint = state.interactive
    ? '；当前为交互式挑战，服务器无头模式可能需要改用 TURNSTILE_HEADLESS=false 完成人工接管'
    : '';
  const error = new Error(`等待 Turnstile token 超时（${detail}${interactionHint}）`);
  error.code = state.interactive ? 'TURNSTILE_INTERACTION_REQUIRED' : 'TURNSTILE_TOKEN_TIMEOUT';
  error.challengeState = state;
  throw error;
}

async function fillLoginForm(page, email, password) {
  const emailInput = await firstVisible(page, EMAIL_SELECTORS, 6000);
  const passwordInput = await firstVisible(page, PASSWORD_SELECTORS, 6000);
  if (!emailInput || !passwordInput) {
    return false;
  }
  await emailInput.scrollIntoViewIfNeeded().catch(() => {});
  await humanType(emailInput, email);
  await humanPause(150, 320);
  await passwordInput.scrollIntoViewIfNeeded().catch(() => {});
  await humanType(passwordInput, password);
  await humanPause(180, 360);
  return true;
}

async function clickSubmit(page) {
  const submit = await firstVisible(page, SUBMIT_SELECTORS, 4000);
  if (!submit) return false;
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await humanPause(120, 260);
  await humanClickLocator(page, submit);
  return true;
}

export function extractLoginTokensFromPayload(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  // Generic `data.token` is intentionally excluded: it is often a 2FA/session challenge token.
  const accessToken = data.access_token || data.accessToken || '';
  const refreshToken = data.refresh_token || data.refreshToken || '';
  return {
    accessToken: accessToken ? String(accessToken) : '',
    refreshToken: refreshToken ? String(refreshToken) : '',
  };
}

export function isSuccessfulLoginPayload(status, payload = {}, tokens = extractLoginTokensFromPayload(payload)) {
  if (Number(status) < 200 || Number(status) >= 300) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.success === false || payload.error || payload.reason) return false;
  if (Object.hasOwn(payload, 'code') && ![0, 200, true, '0', '200'].includes(payload.code)) return false;
  if (tokens.accessToken) return true;
  return payload.success === true || [0, 200, true, '0', '200'].includes(payload.code);
}

function readPayloadPath(source, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => value?.[key], source);
}

export function isVerifiedProfilePayload(platform, payload, balancePath) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.success === false || payload.error || payload.reason) return false;
  if (Object.hasOwn(payload, 'code') && ![0, 200, true, '0', '200'].includes(payload.code)) return false;
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : payload;
  if (!Object.keys(data).length) return false;
  const defaultPath = platform === 'newapi' ? 'data.quota' : 'data.balance';
  const rawBalance = readPayloadPath(payload, balancePath || defaultPath);
  if (rawBalance === null || rawBalance === undefined || rawBalance === '' || typeof rawBalance === 'boolean') {
    return false;
  }
  const balance = Number(rawBalance);
  return Number.isFinite(balance);
}

async function verifySessionInBrowser(
  page,
  rootUrl,
  paths = [],
  headers = {},
  timeoutMs = 12000,
  platform = '',
  balancePath = '',
) {
  const candidates = [...new Set(paths.filter(Boolean))];
  const deadline = Date.now() + timeoutMs;
  for (const path of candidates) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let targetUrl;
    try {
      targetUrl = resolveUpstreamUrl(rootUrl, path);
    } catch {
      continue;
    }
    const result = await page.evaluate(async ({ url, path: candidate, headers: requestHeaders, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'application/json', ...requestHeaders },
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') || '';
        const text = await response.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = null;
        }
        return {
          ok: response.ok && body !== null,
          status: response.status,
          contentType,
          body,
          path: candidate,
          challenged: response.headers.get('cf-mitigated') === 'challenge',
        };
      } catch (error) {
        return { ok: false, status: 0, body: null, path: candidate, error: error?.name || 'fetch_failed' };
      } finally {
        clearTimeout(timer);
      }
    }, {
      url: targetUrl.toString(),
      path: targetUrl.pathname,
      headers,
      timeout: remainingMs,
    }).catch(() => null);

    if (result?.ok && !result.challenged && isVerifiedProfilePayload(platform, result.body, balancePath)) {
      return result;
    }
  }
  return null;
}

async function browserSessionSnapshot(context, page, rootUrl, profilePaths = []) {
  const origin = new URL(rootUrl).origin;
  const cookieUrls = [rootUrl, ...profilePaths].flatMap((path) => {
    try {
      const url = resolveUpstreamUrl(rootUrl, path);
      return url.origin === origin ? [url.toString()] : [];
    } catch {
      return [];
    }
  });
  const cookies = await context.cookies([...new Set(cookieUrls)]).catch(() => []);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  return { cookieHeader, userAgent, hasSessionCookie: cookies.length > 0 };
}

async function tokenLifecycleMetadata(page, token, consumed = false, fallbackObtainedAt = Date.now()) {
  const state = await readChallengeState(page);
  const obtainedAtMs = state.tokenObtainedAt || fallbackObtainedAt;
  return {
    tokenObtainedAt: new Date(obtainedAtMs).toISOString(),
    tokenExpiresAt: new Date(obtainedAtMs + TURNSTILE_TOKEN_TTL_MS).toISOString(),
    tokenConsumed: consumed || state.tokenConsumed === true || !token,
    challengeState: state,
  };
}

async function isCloudflareInterstitialResponse(page, response) {
  if (!response) return false;
  const headers = response.headers();
  if (String(headers['cf-mitigated'] || '').toLowerCase() === 'challenge') return true;
  if (![403, 429, 503].includes(response.status())) return false;
  const marker = `${await page.title().catch(() => '')}\n${await page.content().catch(() => '')}`;
  return /just a moment|challenge-platform|cf-browser-verification|challenges\.cloudflare\.com|cloudflare.*challenge/i.test(marker);
}

async function loginFormVisible(page, timeoutMs = 500) {
  const email = await firstVisible(page, EMAIL_SELECTORS, timeoutMs);
  if (!email) return false;
  return Boolean(await firstVisible(page, PASSWORD_SELECTORS, timeoutMs));
}

async function waitForInterstitialClear(page, targetUrl, deadline) {
  let lastInteractionAt = 0;
  let lastClearanceValue = '';

  while (Date.now() < deadline) {
    if (await loginFormVisible(page, Math.min(500, Math.max(150, deadline - Date.now())))) {
      return 'form';
    }

    const cookies = await page.context().cookies(targetUrl).catch(() => []);
    const clearanceValue = cookies.find((cookie) => cookie.name === 'cf_clearance')?.value || '';
    if (clearanceValue && clearanceValue !== lastClearanceValue) {
      lastClearanceValue = clearanceValue;
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(10000, Math.max(500, deadline - Date.now())),
      }).catch(() => null);
      if (response && !(await isCloudflareInterstitialResponse(page, response))) {
        if (await loginFormVisible(page, Math.min(700, Math.max(150, deadline - Date.now())))) {
          return 'form';
        }
        return 'cleared';
      }
      continue;
    }

    if (Date.now() - lastInteractionAt >= 2500) {
      lastInteractionAt = Date.now();
      await interactWithTurnstile(page).catch(() => {});
    }

    await page.waitForLoadState('domcontentloaded', {
      timeout: Math.min(800, Math.max(100, deadline - Date.now())),
    }).catch(() => {});
    await sleep(350);
  }
  return 'timeout';
}

async function openLoginPage(page, rootUrl, timeoutMs = 45000) {
  const root = String(rootUrl || '').replace(/\/$/, '');
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (const path of LOGIN_PATHS) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const url = path === '/' ? `${root}/` : `${root}${path}`;
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(15000, remainingMs),
      });
      if (await isCloudflareInterstitialResponse(page, response)) {
        const challengeState = await waitForInterstitialClear(page, url, deadline);
        if (challengeState === 'form') return url;
        continue;
      }
      if (response && response.status() >= 400) continue;
      await humanPause(400, 900);
      // SPA may need network idle-ish settle
      await page.waitForLoadState('networkidle', {
        timeout: Math.min(5000, Math.max(250, deadline - Date.now())),
      }).catch(() => {});
      const hasForm = await firstVisible(
        page,
        [...EMAIL_SELECTORS, ...PASSWORD_SELECTORS],
        Math.min(1800, Math.max(250, deadline - Date.now())),
      );
      const hasWidget = await firstVisible(
        page,
        TURNSTILE_HOST_SELECTORS,
        Math.min(900, Math.max(250, deadline - Date.now())),
      );
      if (hasForm || hasWidget || path === '/') {
        return url;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return `${root}/login`;
}

/**
 * Solve Turnstile in a real browser and optionally complete password login.
 * @returns {Promise<{ token: string, siteKey: string, accessToken?: string, refreshToken?: string, method: string, dom?: object }>}
 */
export async function browserSolveTurnstile({
  rootUrl,
  platform = '',
  email = '',
  password = '',
  siteKey = '',
  timeoutMs = 120000,
  headless = true,
  attemptLogin = true,
  verificationPaths = [],
  verificationHeaders = {},
  verificationBalancePath = '',
  upstreamHeaders = {},
  disableSandbox = false,
}) {
  const playwright = await loadPlaywright();
  let browser = null;
  let context = null;
  try {
    browser = await playwright.chromium.launch({
      headless,
      chromiumSandbox: !disableSandbox,
      args: ['--disable-dev-shm-usage'],
    });

    context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });

    const page = await context.newPage();
    await installTurnstileHooks(page);
    if (Object.keys(upstreamHeaders).length) {
      const upstreamOrigin = new URL(rootUrl).origin;
      await page.route('**/*', async (route) => {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(route.request().url()).origin === upstreamOrigin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) return route.continue();
        return route.continue({
          headers: { ...route.request().headers(), ...upstreamHeaders },
        });
      });
    }

  let capturedLoginTokens = null;
  let interceptedToken = '';
  let interceptedTokenObtainedAt = 0;
  let consumedToken = '';
  let lastLoginFailure = null;

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!isUpstreamLoginEndpoint(url, rootUrl, platform)) return;
      if (!['POST', 'PUT'].includes(response.request().method())) return;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;
      const body = await response.json().catch(() => null);
      if (!body) return;
      const tokens = extractLoginTokensFromPayload(body, platform);
      const status = response.status();
      if (tokens.accessToken && isSuccessfulLoginPayload(status, body, tokens)) capturedLoginTokens = tokens;
      if (isSuccessfulLoginPayload(status, body, tokens)) {
        capturedLoginTokens = capturedLoginTokens || { accessToken: '', refreshToken: '' };
        capturedLoginTokens._loginOk = true;
      } else {
        lastLoginFailure = {
          status,
          reason: String(body?.reason || body?.message || body?.error || body?.code || 'login_rejected'),
        };
      }
    } catch {
      // ignore parse errors
    }
  });

  page.on('request', async (request) => {
    try {
      if (!['POST', 'PUT'].includes(request.method())) return;
      if (!isUpstreamLoginEndpoint(request.url(), rootUrl, platform)) return;
      const post = request.postData() || '';
      if (!post) return;
      const token = extractSubmittedTurnstileToken(
        post,
        request.headers()['content-type'] || '',
      );
      if (token) {
        const observedAt = Date.now();
        interceptedToken = token;
        consumedToken = interceptedToken;
        // Set the Node-side consumed marker before the first await; Playwright does
        // not await async event listeners and the main login loop runs concurrently.
        const markConsumed = page.evaluate((submittedToken) => {
          window.__frostedMarkTurnstile?.(submittedToken, 'consumed', 'login.request');
        }, consumedToken).catch(() => {});
        const state = await readChallengeState(page);
        interceptedTokenObtainedAt ||= state.tokenObtainedAt || observedAt;
        await markConsumed;
      }
    } catch {
      // ignore
    }
  });

    const opened = await openLoginPage(page, rootUrl, Math.min(45000, timeoutMs));
    await humanPause(300, 700);

    // Discover sitekey from live DOM / HTML as fallback metadata
    let resolvedSiteKey = siteKey || (await readSiteKeyFromPage(page));
    if (!resolvedSiteKey) {
      const html = await page.content().catch(() => '');
      resolvedSiteKey = extractSiteKeyFromText(html);
    }

    const domBefore = await discoverTurnstileDom(page);

    if (attemptLogin && email && password) {
      const filled = await fillLoginForm(page, email, password);
      if (filled) {
        await interactWithTurnstile(page);
        // Prefer waiting a bit for managed auto-pass before submit
        const earlyToken = await waitForTurnstileToken(page, Math.min(8000, timeoutMs)).catch(() => '');
        if (earlyToken) {
          interceptedToken = earlyToken;
          const state = await readChallengeState(page);
          interceptedTokenObtainedAt = state.tokenObtainedAt || Date.now();
        }

        await clickSubmit(page);
        await humanPause(500, 1000);

        const loginDeadline = Date.now() + Math.min(45000, timeoutMs);
        while (Date.now() < loginDeadline) {
          const session = await browserSessionSnapshot(context, page, rootUrl, verificationPaths);

          if (capturedLoginTokens?.accessToken) {
            const profile = await verifySessionInBrowser(
              page,
              rootUrl,
              verificationPaths,
              {
                ...verificationHeaders,
                Authorization: platform === 'sub2api'
                  ? `Bearer ${capturedLoginTokens.accessToken}`
                  : capturedLoginTokens.accessToken,
              },
              Math.min(12000, timeoutMs),
              platform,
              verificationBalancePath,
            );
            if (profile) {
              const lifecycle = await tokenLifecycleMetadata(page, '', true, interceptedTokenObtainedAt || Date.now());
              return {
                token: '',
                siteKey: resolvedSiteKey,
                accessToken: capturedLoginTokens.accessToken,
                refreshToken: capturedLoginTokens.refreshToken || '',
                cookies: session.cookieHeader,
                userAgent: session.userAgent,
                profile,
                method: 'browser_full_login',
                dom: domBefore,
                pageUrl: opened,
                ...lifecycle,
              };
            }
          }

          // New API commonly establishes only a browser session. Verify it before accepting.
          if (capturedLoginTokens?._loginOk) {
            const profile = await verifySessionInBrowser(
              page,
              rootUrl,
              verificationPaths,
              verificationHeaders,
              Math.min(12000, timeoutMs),
              platform,
              verificationBalancePath,
            );
            if (profile) {
              const lifecycle = await tokenLifecycleMetadata(page, '', true, interceptedTokenObtainedAt || Date.now());
              return {
                token: '',
                siteKey: resolvedSiteKey,
                accessToken: '',
                refreshToken: '',
                cookies: session.cookieHeader,
                userAgent: session.userAgent,
                profile,
                method: 'browser_verified_session',
                dom: domBefore,
                pageUrl: opened,
                ...lifecycle,
              };
            }
          }

          const token = await readTokenFromPage(page);
          if (token && token !== consumedToken) {
            interceptedToken = token;
            const state = await readChallengeState(page);
            interceptedTokenObtainedAt = state.tokenObtainedAt || Date.now();
            break;
          }
          if (lastLoginFailure && !/turnstile|captcha|challenge|验证/i.test(lastLoginFailure.reason)) break;
          await interactWithTurnstile(page);
          await sleep(500);
        }
      }
    }

    // An explicit successful login response may rotate RT before the profile
    // endpoint recovers. Return it as a pending checkpoint, never as balance success.
    if (capturedLoginTokens?.accessToken) {
      const session = await browserSessionSnapshot(context, page, rootUrl, verificationPaths);
      const lifecycle = await tokenLifecycleMetadata(page, '', true, interceptedTokenObtainedAt || Date.now());
      return {
        token: '',
        siteKey: resolvedSiteKey,
        accessToken: capturedLoginTokens.accessToken,
        refreshToken: capturedLoginTokens.refreshToken || '',
        cookies: session.cookieHeader,
        userAgent: session.userAgent,
        profile: null,
        tokensPendingVerification: true,
        method: 'browser_login_tokens_pending_profile',
        dom: domBefore,
        pageUrl: opened,
        ...lifecycle,
      };
    }

    // Token-only path: interact until hidden field / callback fires
    await interactWithTurnstile(page);
    let token = interceptedToken && interceptedToken !== consumedToken ? interceptedToken : '';
    if (!token) token = await waitForTurnstileToken(page, timeoutMs, consumedToken);
    if (token === consumedToken) {
      const error = new Error('浏览器登录已提交并消费 Turnstile token，拒绝将同一 token 交给 API 重放');
      error.code = 'TURNSTILE_TOKEN_CONSUMED';
      throw error;
    }
    const siteKeyFinal = resolvedSiteKey || (await readSiteKeyFromPage(page)) || siteKey || '';
    const domAfter = await discoverTurnstileDom(page);
    const session = await browserSessionSnapshot(context, page, rootUrl, verificationPaths);
    const lifecycle = await tokenLifecycleMetadata(page, token, false, interceptedTokenObtainedAt || Date.now());

    return {
      token,
      siteKey: siteKeyFinal,
      accessToken: capturedLoginTokens?.accessToken || '',
      refreshToken: capturedLoginTokens?.refreshToken || '',
      cookies: session.cookieHeader,
      userAgent: session.userAgent,
      method: capturedLoginTokens?.accessToken
        ? 'browser_full_login'
        : capturedLoginTokens?._loginOk
          ? 'browser_session_login'
          : 'browser_token',
      dom: domAfter,
      pageUrl: opened,
      lastLoginFailure,
      ...lifecycle,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export const browserSelectors = {
  EMAIL_SELECTORS,
  PASSWORD_SELECTORS,
  SUBMIT_SELECTORS,
  TURNSTILE_HOST_SELECTORS,
  TOKEN_INPUT_SELECTORS,
};
