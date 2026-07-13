/**
 * Browser-based Turnstile handling:
 * - Discover related DOM / iframe / hidden inputs
 * - Simulate human-like mouse, scroll, typing and checkbox clicks
 * - Capture turnstile token and (when possible) full login AT/RT
 */

import { extractSiteKeyFromText } from './turnstile.js';

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
  await page.addInitScript(() => {
    window.__frostedTurnstile = {
      token: '',
      siteKey: '',
      events: [],
    };

    const remember = (token, source) => {
      if (!token || typeof token !== 'string') return;
      if (token.length < 20) return;
      window.__frostedTurnstile.token = token;
      window.__frostedTurnstile.events.push({ source, at: Date.now(), len: token.length });
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
  });
}

async function readTokenFromPage(page) {
  return page.evaluate((tokenSelectors) => {
    const store = window.__frostedTurnstile;
    if (store?.token) return store.token;

    for (const selector of tokenSelectors) {
      const el = document.querySelector(selector);
      if (el?.value && el.value.length > 20) return el.value;
    }

    if (window.turnstile?.getResponse) {
      try {
        const token = window.turnstile.getResponse();
        if (token && String(token).length > 20) return String(token);
      } catch {
        // ignore
      }
    }

    const widgets = document.querySelectorAll('[name="cf-turnstile-response"], [data-response]');
    for (const el of widgets) {
      const value = el.value || el.getAttribute('data-response');
      if (value && value.length > 20) return value;
    }
    return '';
  }, TOKEN_INPUT_SELECTORS);
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
    return { nodes, tokenInputs, hasTurnstileApi: Boolean(window.turnstile) };
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
      'body',
    ];
    for (const selector of candidates) {
      const locator = frame.locator(selector).first();
      if (!(await locator.count().catch(() => 0))) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible && selector !== 'body') continue;
      await humanClickLocator(page, locator).catch(async () => {
        await locator.click({ timeout: 2000, force: true }).catch(() => {});
      });
      await humanPause(250, 600);
      break;
    }
  }
}

async function waitForTurnstileToken(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastDom = null;
  while (Date.now() < deadline) {
    const token = await readTokenFromPage(page);
    if (token) return token;

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
  throw new Error(`等待 Turnstile token 超时（${detail}）`);
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

function extractTokensFromPayload(payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const accessToken = data.access_token || data.accessToken || data.token || '';
  const refreshToken = data.refresh_token || data.refreshToken || '';
  return {
    accessToken: accessToken ? String(accessToken) : '',
    refreshToken: refreshToken ? String(refreshToken) : '',
  };
}

async function openLoginPage(page, rootUrl) {
  const root = String(rootUrl || '').replace(/\/$/, '');
  let lastError;
  for (const path of LOGIN_PATHS) {
    const url = path === '/' ? `${root}/` : `${root}${path}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanPause(400, 900);
      // SPA may need network idle-ish settle
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      const hasForm = await firstVisible(page, [...EMAIL_SELECTORS, ...PASSWORD_SELECTORS], 2500);
      const hasWidget = await firstVisible(page, TURNSTILE_HOST_SELECTORS, 1500);
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
  email = '',
  password = '',
  siteKey = '',
  timeoutMs = 120000,
  headless = true,
  attemptLogin = true,
}) {
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    timezoneId: 'Asia/Shanghai',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  await installTurnstileHooks(page);

  let capturedLoginTokens = null;
  let interceptedToken = '';

  page.on('response', async (response) => {
    try {
      const url = response.url();
      // Sub2API + New API login endpoints
      if (!/auth\/login|\/api\/user\/login|\/api\/v1\/auth|\/login/i.test(url)) return;
      if (!['POST', 'PUT'].includes(response.request().method())) return;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('json')) return;
      const body = await response.json().catch(() => null);
      if (!body) return;
      const tokens = extractTokensFromPayload(body);
      if (tokens.accessToken) capturedLoginTokens = tokens;
      // New API often only returns success + session cookie
      if (body?.success === true || body?.data) {
        capturedLoginTokens = capturedLoginTokens || { accessToken: '', refreshToken: '' };
        capturedLoginTokens._loginOk = true;
      }
    } catch {
      // ignore parse errors
    }
  });

  page.on('request', (request) => {
    try {
      if (request.method() !== 'POST') return;
      const post = request.postData() || '';
      if (!post) return;
      const match = post.match(/"(?:turnstile_token|cf-turnstile-response|turnstileToken)"\s*:\s*"([^"]+)"/i)
        || post.match(/(?:turnstile_token|cf-turnstile-response)=([^&]+)/i);
      if (match?.[1] && match[1].length > 20) {
        interceptedToken = decodeURIComponent(match[1]);
      }
    } catch {
      // ignore
    }
  });

  try {
    const opened = await openLoginPage(page, rootUrl);
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
        const earlyToken = await Promise.race([
          waitForTurnstileToken(page, Math.min(20000, timeoutMs)).catch(() => ''),
          sleep(Math.min(8000, timeoutMs)).then(() => ''),
        ]);
        if (earlyToken) interceptedToken = earlyToken;

        await clickSubmit(page);
        await humanPause(500, 1000);

        const loginDeadline = Date.now() + Math.min(45000, timeoutMs);
        while (Date.now() < loginDeadline) {
          const cookies = await context.cookies().catch(() => []);
          const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
          const sessionish = cookies.some((c) => /session|token|auth|jwt|sid|user/i.test(c.name));

          if (capturedLoginTokens?.accessToken) {
            return {
              token: interceptedToken || (await readTokenFromPage(page)) || 'browser-login',
              siteKey: resolvedSiteKey,
              accessToken: capturedLoginTokens.accessToken,
              refreshToken: capturedLoginTokens.refreshToken || '',
              cookies: cookieHeader,
              method: 'browser_full_login',
              dom: domBefore,
              pageUrl: opened,
            };
          }

          // New API: login success often only sets session cookies
          if (capturedLoginTokens?._loginOk && (sessionish || cookieHeader)) {
            return {
              token: interceptedToken || (await readTokenFromPage(page)) || 'browser-session',
              siteKey: resolvedSiteKey,
              accessToken: '',
              refreshToken: '',
              cookies: cookieHeader,
              method: 'browser_session_login',
              dom: domBefore,
              pageUrl: opened,
            };
          }

          const token = interceptedToken || (await readTokenFromPage(page));
          if (token && token !== 'browser-login') {
            interceptedToken = token;
            // If form submit did not yield tokens, return token for API login
            break;
          }
          await interactWithTurnstile(page);
          await sleep(500);
        }
      }
    }

    // Token-only path: interact until hidden field / callback fires
    await interactWithTurnstile(page);
    const token = interceptedToken || (await waitForTurnstileToken(page, timeoutMs));
    const siteKeyFinal = resolvedSiteKey || (await readSiteKeyFromPage(page)) || siteKey || '';
    const domAfter = await discoverTurnstileDom(page);
    const cookies = await context.cookies().catch(() => []);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    return {
      token,
      siteKey: siteKeyFinal,
      accessToken: capturedLoginTokens?.accessToken || '',
      refreshToken: capturedLoginTokens?.refreshToken || '',
      cookies: cookieHeader,
      method: capturedLoginTokens?.accessToken
        ? 'browser_full_login'
        : capturedLoginTokens?._loginOk
          ? 'browser_session_login'
          : 'browser_token',
      dom: domAfter,
      pageUrl: opened,
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export const browserSelectors = {
  EMAIL_SELECTORS,
  PASSWORD_SELECTORS,
  SUBMIT_SELECTORS,
  TURNSTILE_HOST_SELECTORS,
  TOKEN_INPUT_SELECTORS,
};
