/**
 * Cloudflare Turnstile helpers for Sub2API password login.
 * - Detects turnstile-related login failures
 * - Discovers sitekey from upstream HTML/JS
 * - Solves via browser automation (DOM + human-like interaction)
 *   or optional CapSolver / 2Captcha
 */

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
    return siteKeyCache.get(root);
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
      siteKeyCache.set(root, fromHtml);
      return fromHtml;
    }

    const scripts = extractScriptSrcs(html, url)
      .filter((src) => /\.(js|mjs)(\?|$)/i.test(src) || /assets|static|chunk|index/i.test(src))
      .slice(0, 8);

    for (const scriptUrl of scripts) {
      const js = await fetchText(scriptUrl, options.timeoutMs);
      const fromJs = extractSiteKeyFromText(js);
      if (fromJs) {
        siteKeyCache.set(root, fromJs);
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
  siteKey,
  provider,
  apiKey,
  timeoutMs,
  email = '',
  password = '',
  headless = true,
}) {
  const websiteURL = String(rootUrl || '').replace(/\/$/, '');
  const normalized = String(provider || 'none').toLowerCase();

  if (normalized === 'browser') {
    const { browserSolveTurnstile } = await import('./turnstile-browser.js');
    const result = await browserSolveTurnstile({
      rootUrl: websiteURL,
      email,
      password,
      siteKey: String(siteKey || '').trim(),
      timeoutMs: timeoutMs || 120000,
      headless,
      attemptLogin: Boolean(email && password),
    });
    if (result.siteKey) siteKeyCache.set(websiteURL, result.siteKey);
    return {
      token: result.token,
      siteKey: result.siteKey || siteKey || '',
      accessToken: result.accessToken || '',
      refreshToken: result.refreshToken || '',
      cookies: result.cookies || '',
      method: result.method,
      dom: result.dom,
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
  return { token, siteKey: websiteKey, method: normalized };
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
    };
  }
  const enabled = Boolean(config?.turnstileSolverApiKey);
  return {
    enabled,
    provider: enabled ? provider : 'none',
    mode: enabled ? 'api' : 'off',
  };
}
