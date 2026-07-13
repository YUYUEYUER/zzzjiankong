import { config } from './config.js';
import { attachCredentialCheckpoint, getCredentialCheckpoint } from './credential-checkpoint.js';
import {
  detectTurnstileChallenge,
  consumeOneShotTurnstileToken,
  getTurnstileSolverStatus,
  isTurnstileFailure,
  obtainTurnstileToken,
  turnstileTokenState,
} from './turnstile.js';
import { currentUpstreamProxyContext, withUpstreamProxyContext } from './proxy-pool.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('站点地址仅支持 HTTP 或 HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

export function cloudflareAccessHeaders(secret = {}) {
  const clientId = String(secret.cfAccessClientId || '').trim();
  const clientSecret = String(secret.cfAccessClientSecret || '').trim();
  if (!clientId || !clientSecret) return {};
  return {
    'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
  };
}

export function readPath(source, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => value?.[key], source);
}

/** Detect Cloudflare / Turnstile challenges from errors or API bodies */
export function isCloudflareChallenge(errorOrBody, reason = '') {
  if (['TURNSTILE_REQUIRED', 'CF_CHALLENGE_PAGE', 'TURNSTILE_INTERACTION_REQUIRED'].includes(errorOrBody?.code)) {
    return true;
  }
  if (errorOrBody && typeof errorOrBody === 'object' && !(errorOrBody instanceof Error)) {
    if (isTurnstileFailure(errorOrBody, reason)) return true;
  }
  const message = String(errorOrBody?.message || errorOrBody || reason || '');
  return /turnstile|captcha|人机|cloudflare|cf.?challenge|challenge.?platform|just a moment|cf-browser-verification|挑战页|自动过盾|TURNSTILE/i.test(message);
}

async function fetchWithSameOriginRedirects(url, options = {}, maxRedirects = 5) {
  const initialOrigin = new URL(url).origin;
  let currentUrl = String(url);
  let currentOptions = { ...options, redirect: 'manual' };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(currentUrl, currentOptions);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount === maxRedirects) throw new Error('上游重定向次数过多');

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== initialOrigin) {
      await response.body?.cancel().catch(() => {});
      const error = new Error('上游尝试跨域重定向，已阻止凭据发送到其他站点');
      error.code = 'UPSTREAM_CROSS_ORIGIN_REDIRECT';
      throw error;
    }

    const method = String(currentOptions.method || 'GET').toUpperCase();
    const switchToGet = response.status === 303
      || ([301, 302].includes(response.status) && method === 'POST');
    if (switchToGet && method !== 'HEAD') {
      const headers = { ...(currentOptions.headers || {}) };
      for (const key of Object.keys(headers)) {
        if (['content-type', 'content-length'].includes(key.toLowerCase())) delete headers[key];
      }
      currentOptions = { ...currentOptions, method: 'GET', body: undefined, headers };
    }
    await response.body?.cancel().catch(() => {});
    currentUrl = nextUrl.toString();
  }
  throw new Error('上游重定向次数过多');
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const proxy = currentUpstreamProxyContext();
    const response = await fetchWithSameOriginRedirects(url, {
      ...options,
      ...(proxy?.dispatcher && !options.dispatcher ? { dispatcher: proxy.dispatcher } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = {};
    let parsed = true;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      parsed = false;
      body = {};
    }

    const challenge = detectTurnstileChallenge({ response, body, text });
    if (challenge.detected) {
      const err = new Error(`上游触发 Cloudflare/Turnstile 验证 (${response.status || 'unknown'})`);
      err.code = 'TURNSTILE_REQUIRED';
      err.challenge = challenge;
      throw err;
    }
    if (!parsed) throw new Error(`上游返回了非 JSON 数据 (${response.status})`);
    return { response, body };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接上游超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertSuccess(response, body) {
  const codeFailed = Object.hasOwn(body || {}, 'code')
    && ![0, 200, true, '0', '200'].includes(body.code);
  if (!response.ok || body?.success === false || body?.error || body?.reason || codeFailed) {
    const message = body?.message || body?.reason || body?.error || `上游请求失败 (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.upstreamCode = body?.code;
    if (isTurnstileFailure(body, message)) {
      err.code = 'TURNSTILE_REQUIRED';
      err.challenge = detectTurnstileChallenge({ response, body, reason: message });
    } else if ([401, 403].includes(response.status) || [401, 403, '401', '403'].includes(body?.code)) {
      err.code = 'UPSTREAM_AUTH_FAILED';
    } else {
      err.code = 'UPSTREAM_REQUEST_FAILED';
    }
    throw err;
  }
}

function numericBalance(body, balancePath) {
  const raw = readPath(body, balancePath);
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') {
    throw new Error(`余额字段 ${balancePath} 不是有效数字`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`余额字段 ${balancePath} 不是有效数字`);
  return value;
}

function isAuthFailure(error) {
  if (error?.code === 'UPSTREAM_AUTH_FAILED' || [401, 403].includes(error?.status)) return true;
  const message = String(error?.message || error || '');
  return /401|403|unauthorized|token|令牌|please sign in|登录|过期|expired|invalid|鉴权|认证|forbidden/i.test(message);
}

export function normalizeTokenPool(secret = {}) {
  const tokens = [
    ...(Array.isArray(secret.accessTokens) ? secret.accessTokens : []),
    secret.accessToken,
  ]
    .map((token) => String(token || '').trim())
    .filter(Boolean);
  return [...new Set(tokens)].slice(0, 20);
}

export function normalizeApiTokenPool(secret = {}) {
  const tokens = [
    ...(Array.isArray(secret.apiTokens) ? secret.apiTokens : []),
    secret.apiToken,
  ]
    .map((token) => String(token || '').trim())
    .filter(Boolean);
  return [...new Set(tokens)].slice(0, 20);
}

function apiTokenAuthorizationCandidates(token) {
  const value = String(token || '').trim();
  if (!value) return [];
  return value.startsWith('sk-') ? [value] : [value, `sk-${value}`];
}

export function scheduledTokenIndexes(size, strategy = 'sticky', cursor = 0) {
  if (!Number.isInteger(size) || size <= 0) return [];
  const normalizedCursor = Number.isInteger(Number(cursor))
    ? Math.min(size - 1, Math.max(0, Number(cursor)))
    : 0;
  const start = strategy === 'round_robin' ? (normalizedCursor + 1) % size : normalizedCursor;
  return Array.from({ length: size }, (_, offset) => (start + offset) % size);
}

export function tokenTiming(token, skewMs = 5 * 60000, current = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { expiresAt: null, expired: false, expiringSoon: false };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const expiresAtMs = Number(payload.exp) * 1000;
    if (!Number.isFinite(expiresAtMs)) return { expiresAt: null, expired: false, expiringSoon: false };
    return {
      expiresAt: new Date(expiresAtMs).toISOString(),
      expired: expiresAtMs <= current,
      expiringSoon: expiresAtMs <= current + skewMs,
    };
  } catch {
    return { expiresAt: null, expired: false, expiringSoon: false };
  }
}

/** Use a JWT exp claim when available, otherwise fall back to the stored expiry. */
export function effectiveTokenTiming(token, storedExpiresAt = '', skewMs = 5 * 60000, current = Date.now()) {
  const jwtTiming = tokenTiming(token, skewMs, current);
  if (jwtTiming.expiresAt) return { ...jwtTiming, source: 'jwt' };

  const storedExpiresAtMs = new Date(storedExpiresAt || 0).getTime();
  if (!Number.isFinite(storedExpiresAtMs) || storedExpiresAtMs <= 0) {
    return { expiresAt: null, expired: false, expiringSoon: false, source: 'unknown' };
  }
  return {
    expiresAt: new Date(storedExpiresAtMs).toISOString(),
    expired: storedExpiresAtMs <= current,
    expiringSoon: storedExpiresAtMs <= current + skewMs,
    source: 'stored',
  };
}

function extractTokens(payload = {}) {
  const candidates = [payload, payload?.data, payload?.tokens, payload?.data?.tokens, payload?.result]
    .filter((item) => item && typeof item === 'object');
  const accessToken = candidates.map((item) => item.access_token || item.accessToken || '').find(Boolean) || '';
  const refreshToken = candidates.map((item) => item.refresh_token || item.refreshToken || '').find(Boolean) || '';
  const expiresIn = Number(candidates.map((item) => item.expires_in || item.expiresIn || 0).find(Boolean) || 0);
  const refreshExpiresIn = Number(candidates.map((item) => item.refresh_expires_in || item.refreshExpiresIn || 0).find(Boolean) || 0);
  return {
    accessToken: accessToken ? String(accessToken) : '',
    refreshToken: refreshToken ? String(refreshToken) : '',
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0,
    refreshExpiresIn: Number.isFinite(refreshExpiresIn) ? refreshExpiresIn : 0,
  };
}

export function turnstileRequestFields(token = '') {
  const value = String(token || '').trim();
  if (!value) return {};
  return {
    turnstile_token: value,
    cf_turnstile_response: value,
    'cf-turnstile-response': value,
  };
}

export function newApiLoginUrl(root, token = '') {
  const url = new URL(`${String(root || '').replace(/\/$/, '')}/api/user/login`);
  const value = String(token || '').trim();
  if (value) url.searchParams.set('turnstile', value);
  return url.toString();
}

function assertFreshTurnstileToken(solved) {
  const state = turnstileTokenState(solved);
  if (state.usable) return state;
  const reasons = {
    already_consumed: '浏览器已经提交过该 Turnstile token，不能再次通过 API 重放',
    expired: 'Turnstile token 已超过 5 分钟有效期',
    missing_obtained_at: 'Turnstile token 缺少签发时间，无法安全提交',
    missing_or_malformed: '未取得可用的 Turnstile token',
  };
  const error = new Error(reasons[state.reason] || 'Turnstile token 当前不可用');
  error.code = `TURNSTILE_TOKEN_${String(state.reason || 'UNUSABLE').toUpperCase()}`;
  throw error;
}

function turnstileManualHint() {
  const solver = getTurnstileSolverStatus(config);
  if (solver.enabled && solver.provider === 'browser') {
    return (
      '浏览器自动过盾已启用但仍失败。可设置 TURNSTILE_HEADLESS=false 观察页面，'
      + '确认已执行 `npx playwright install chromium`；'
      + 'New API 可回退到已保存的 Access Token；Sub2API 可粘贴 AT/RT。'
    );
  }
  if (solver.enabled) {
    return (
      '自动过盾已启用但仍失败。请检查打码 API Key / Site Key；'
      + 'New API 可回退 Access Token，Sub2API 可粘贴 AT/RT。'
    );
  }
  return (
    '站点启用了 Cloudflare 防护。'
    + '请配置 TURNSTILE_SOLVER=browser（默认）或 capsolver/2captcha；'
    + 'New API 建议同时保存 Access Token 作为回退；Sub2API 可粘贴 AT/RT。'
  );
}

/**
 * When CF/Turnstile is hit: try browser (or API solver) first.
 * Returns turnstile token, optional AT/RT, optional session cookies.
 */
async function solveCloudflareChallenge({
  root,
  account,
  secret,
  verificationAccessToken = '',
  detectedSiteKey = '',
}) {
  const solver = getTurnstileSolverStatus(config);
  if (!solver.enabled) {
    throw new Error(turnstileManualHint());
  }

  const verificationPaths = account.type === 'newapi'
    ? [account.profilePath || '/api/user/self']
    : [
        account.profilePath,
        '/api/v1/users/me',
        '/api/v1/auth/me',
        '/api/v1/user/profile',
        '/api/v1/user/self',
      ].filter(Boolean);
  const verificationHeaders = account.type === 'newapi' && account.userId
    ? { 'New-Api-User': String(account.userId) }
    : {};
  if (verificationAccessToken) {
    verificationHeaders.Authorization = account.type === 'sub2api'
      ? `Bearer ${verificationAccessToken}`
      : verificationAccessToken;
  }
  const accessHeaders = cloudflareAccessHeaders(secret);

  const solved = await obtainTurnstileToken({
    rootUrl: root,
    platform: account.type,
    siteKey: detectedSiteKey || account.turnstileSiteKey || '',
    provider: config.turnstileSolver,
    apiKey: config.turnstileSolverApiKey,
    timeoutMs: config.turnstileSolveTimeoutMs,
    email: account.username || '',
    password: secret.password || '',
    headless: config.turnstileHeadless,
    verificationPaths,
    verificationHeaders: { ...verificationHeaders, ...accessHeaders },
    verificationBalancePath: account.balancePath || (account.type === 'newapi' ? 'data.quota' : 'data.balance'),
    upstreamHeaders: accessHeaders,
    disableSandbox: config.turnstileDisableBrowserSandbox,
    maxBrowserConcurrency: config.turnstileBrowserConcurrency,
    browserQueueLimit: config.turnstileBrowserQueueLimit,
    verifyOnly: Boolean(verificationAccessToken),
  });

  return {
    token: solved.token || '',
    accessToken: solved.accessToken || '',
    refreshToken: solved.refreshToken || '',
    cookies: solved.cookies || '',
    userAgent: solved.userAgent || '',
    profile: solved.profile || null,
    verificationFailed: solved.verificationFailed === true,
    tokensPendingVerification: solved.tokensPendingVerification === true,
    method: solved.method || config.turnstileSolver,
    tokenObtainedAt: solved.tokenObtainedAt || '',
    tokenExpiresAt: solved.tokenExpiresAt || '',
    tokenConsumed: solved.tokenConsumed === true,
    challengeState: solved.challengeState || null,
    pageUrl: solved.pageUrl || root,
  };
}

async function fetchNewApiProfile(root, account, headers, source) {
  let lastError;
  for (const delay of [0, 300, 900]) {
    if (delay) await wait(delay);
    try {
      const result = await requestJson(`${root}${account.profilePath || '/api/user/self'}`, { headers });
      assertSuccess(result.response, result.body);
      return {
        rawBalance: numericBalance(result.body, account.balancePath || 'data.quota'),
        metadata: {
          authSource: source,
          status: readPath(result.body, 'data.status'),
          usedQuota: readPath(result.body, 'data.used_quota'),
          requestCount: readPath(result.body, 'data.request_count'),
        },
      };
    } catch (error) {
      lastError = error;
      // CF page: stop retrying delays, let caller run browser / fallback
      if (error.code === 'CF_CHALLENGE_PAGE' || isCloudflareChallenge(error) || isAuthFailure(error)) break;
    }
  }
  throw lastError;
}

async function fetchNewApiTurnstileStatus(root, secret) {
  try {
    const result = await requestJson(`${root}/api/status`, {
      headers: {
        Accept: 'application/json',
        ...cloudflareAccessHeaders(secret),
      },
    });
    assertSuccess(result.response, result.body);
    const enabled = readPath(result.body, 'data.turnstile_check')
      ?? readPath(result.body, 'turnstile_check');
    return {
      enabled: [true, 1, 'true', '1'].includes(enabled),
      siteKey: String(
        readPath(result.body, 'data.turnstile_site_key')
        || readPath(result.body, 'turnstile_site_key')
        || '',
      ),
    };
  } catch (error) {
    if (isCloudflareChallenge(error)) throw error;
    return { enabled: false, siteKey: '' };
  }
}

async function loginNewApiPassword(root, account, secret, turnstileToken = '') {
  const body = {
    username: account.username,
    password: secret.password,
    ...turnstileRequestFields(turnstileToken),
  };

  const login = await requestJson(newApiLoginUrl(root, turnstileToken), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...cloudflareAccessHeaders(secret),
    },
    body: JSON.stringify(body),
  });

  const reason = login.body?.reason || login.body?.error || login.body?.message || '';
  if (isTurnstileFailure(login.body, reason)) {
    const err = new Error(reason || 'TURNSTILE_VERIFICATION_FAILED');
    err.code = 'TURNSTILE_REQUIRED';
    err.body = login.body;
    throw err;
  }

  assertSuccess(login.response, login.body);
  const cookies = login.response.headers.getSetCookie?.() || [];

  return {
    cookieHeader: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    body: login.body,
    tokens: extractTokens(login.body),
  };
}

async function collectNewApiTokenUsage(root, account, secret = {}) {
  const tokenPool = normalizeApiTokenPool(secret);
  if (!tokenPool.length) throw new Error('请填写 New API 左侧“API 密钥”页面创建的调用密钥');
  const errors = [];
  const indexes = scheduledTokenIndexes(tokenPool.length, account.tokenStrategy, secret.apiTokenCursor);
  for (const index of indexes) {
    let slotError;
    for (const authorizationToken of apiTokenAuthorizationCandidates(tokenPool[index])) {
      try {
        const result = await requestJson(`${root}/api/usage/token`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${authorizationToken}`,
            ...cloudflareAccessHeaders(secret),
          },
        });
        assertSuccess(result.response, result.body);
        if (readPath(result.body, 'data.unlimited_quota') === true) {
          const error = new Error('该令牌为无限额度，接口不提供可监控的有限余额；请创建有限额度令牌');
          error.code = 'UNLIMITED_QUOTA';
          throw error;
        }
        const rawBalance = numericBalance(result.body, 'data.total_available');
        const nextSecret = {
          ...secret,
          apiToken: tokenPool[index],
          apiTokens: tokenPool,
          apiTokenCursor: index,
        };
        const poolChanged = Array.isArray(secret.apiTokens)
          && JSON.stringify(secret.apiTokens.map((token) => String(token || '').trim()).filter(Boolean)) !== JSON.stringify(tokenPool);
        const changed = poolChanged || secret.apiToken !== tokenPool[index] || Number(secret.apiTokenCursor || 0) !== index;
        return {
          rawBalance,
          metadata: {
            authSource: 'api_key',
            balanceScope: 'api_key',
            tokenName: readPath(result.body, 'data.name'),
            totalGranted: readPath(result.body, 'data.total_granted'),
            totalUsed: readPath(result.body, 'data.total_used'),
            unlimitedQuota: false,
            expiresAt: readPath(result.body, 'data.expires_at'),
            apiTokenPoolSize: tokenPool.length,
            apiTokenSlot: index + 1,
            tokenStrategy: account.tokenStrategy || 'sticky',
            tokenFailovers: errors.length,
            tokenPrefixMode: authorizationToken === tokenPool[index] ? 'as_entered' : 'sk_compat',
          },
          ...(changed ? { updatedSecret: nextSecret } : {}),
        };
      } catch (error) {
        if (isCloudflareChallenge(error)) throw error;
        slotError = error;
        if (error.code === 'UNLIMITED_QUOTA') break;
        if (!isAuthFailure(error)) throw error;
        const enteredWithoutPrefix = authorizationToken === tokenPool[index] && !tokenPool[index].startsWith('sk-');
        if (!enteredWithoutPrefix || !isAuthFailure(error)) break;
      }
    }
    errors.push(`槽位 ${index + 1}：${slotError?.message || '鉴权失败'}`);
  }
  const error = new Error(`API 密钥全部不可用（${errors.join('；')}）`);
  error.code = 'UPSTREAM_AUTH_FAILED';
  error.status = 401;
  throw error;
}

/**
 * New API:
 * - Preferred path by authMode / available credentials
 * - On CF shield: browser DOM + human-like solve first
 * - On browser failure: fall back to profile user access token + User ID
 */
async function collectNewApi(account, secret = {}) {
  const root = baseUrl(account.baseUrl);
  if (account.authMode === 'api_token') return collectNewApiTokenUsage(root, account, secret);
  const tokenPool = normalizeTokenPool(secret);
  const hasToken = Boolean(tokenPool.length && account.userId);
  const hasPassword = Boolean(account.username && secret.password);
  const sessionCapturedAt = new Date(secret.sessionCapturedAt || 0).getTime();
  const savedSessionUsable = Boolean(secret.sessionCookie) && (
    !Number.isFinite(sessionCapturedAt)
    || sessionCapturedAt <= 0
    || Date.now() - sessionCapturedAt < config.upstreamBrowserSessionTtlMs
  );
  let updatedSecret;
  let pendingCredentialSecret;
  let detectedTurnstileSiteKey = '';
  const errors = [];
  const accessHeaders = cloudflareAccessHeaders(secret);

  const failure = (message) => {
    const error = message instanceof Error ? message : new Error(String(message));
    return pendingCredentialSecret
      ? attachCredentialCheckpoint(error, pendingCredentialSecret)
      : error;
  };

  const rememberCredentials = ({
    accessToken = '',
    refreshToken = '',
    cookieHeader = '',
    userAgent = '',
  } = {}) => {
    if (!accessToken && !refreshToken && !cookieHeader) return undefined;
    const next = { ...(updatedSecret || pendingCredentialSecret || secret) };
    if (accessToken) {
      next.accessToken = accessToken;
      next.accessTokens = [
        accessToken,
        ...tokenPool.filter((token) => token !== accessToken),
      ].slice(0, 20);
      next.tokenCursor = 0;
    }
    if (refreshToken) next.refreshToken = refreshToken;
    if (cookieHeader) {
      next.sessionCookie = cookieHeader;
      next.sessionUserAgent = userAgent || next.sessionUserAgent || '';
      next.sessionCapturedAt = new Date().toISOString();
    }
    delete next.turnstileToken;
    updatedSecret = next;
    if (accessToken || refreshToken) pendingCredentialSecret = next;
    return next;
  };

  const rememberSession = (cookieHeader, userAgent = '') => rememberCredentials({ cookieHeader, userAgent });

  const rememberCloudflareClearance = (cookieHeader, userAgent = '') => {
    if (!cookieHeader) return undefined;
    const next = {
      ...(updatedSecret || pendingCredentialSecret || secret),
      cfClearanceCookie: cookieHeader,
      cfClearanceUserAgent: userAgent || '',
      cfClearanceCapturedAt: new Date().toISOString(),
    };
    delete next.turnstileToken;
    updatedSecret = next;
    pendingCredentialSecret = next;
    return next;
  };

  const cloudflareClearanceHeaders = () => {
    const current = updatedSecret || pendingCredentialSecret || secret;
    if (!current.cfClearanceCookie) return {};
    const capturedAt = new Date(current.cfClearanceCapturedAt || 0).getTime();
    if (Number.isFinite(capturedAt)
      && capturedAt > 0
      && Date.now() - capturedAt >= config.upstreamBrowserSessionTtlMs) {
      return {};
    }
    return {
      Cookie: current.cfClearanceCookie,
      ...(current.cfClearanceUserAgent ? { 'User-Agent': current.cfClearanceUserAgent } : {}),
    };
  };

  const viaToken = async (source = 'access_token') => {
    if (!hasToken) throw new Error('未配置用户访问令牌与 User ID');
    const tokenErrors = [];
    const indexes = scheduledTokenIndexes(tokenPool.length, account.tokenStrategy, secret.tokenCursor);
    for (const index of indexes) {
      const headers = {
        ...accessHeaders,
        ...cloudflareClearanceHeaders(),
        Accept: 'application/json',
        Authorization: tokenPool[index],
        'New-Api-User': String(account.userId),
      };
      try {
        const result = await fetchNewApiProfile(root, account, headers, source);
        const nextSecret = {
          ...(updatedSecret || pendingCredentialSecret || secret),
          accessToken: tokenPool[index],
          accessTokens: tokenPool,
          tokenCursor: index,
        };
        const poolChanged = Array.isArray(secret.accessTokens)
          && JSON.stringify(secret.accessTokens) !== JSON.stringify(tokenPool);
        const cursorUpdate = poolChanged || secret.accessToken !== tokenPool[index] || Number(secret.tokenCursor || 0) !== index
          ? nextSecret
          : undefined;
        updatedSecret = cursorUpdate || pendingCredentialSecret || updatedSecret;
        return {
          ...result,
          metadata: {
            ...result.metadata,
            tokenPoolSize: tokenPool.length,
            tokenSlot: index + 1,
            tokenStrategy: account.tokenStrategy || 'sticky',
            tokenFailovers: tokenErrors.length,
          },
          ...(updatedSecret ? { updatedSecret } : {}),
        };
      } catch (error) {
        if (isCloudflareChallenge(error)) throw error;
        if (!isAuthFailure(error)) throw error;
        tokenErrors.push(`槽位 ${index + 1}：${error.message}`);
      }
    }
    const error = new Error(`令牌池全部不可用（${tokenErrors.join('；')}）`);
    error.code = 'UPSTREAM_AUTH_FAILED';
    error.status = 401;
    throw error;
  };

  const viaCookie = async (cookieHeader, source = 'password_session', userAgent = '') => {
    if (!cookieHeader) throw new Error('登录未返回会话 Cookie');
    const headers = {
      ...accessHeaders,
      Accept: 'application/json',
      Cookie: cookieHeader,
      ...(userAgent ? { 'User-Agent': userAgent } : {}),
    };
    return fetchNewApiProfile(root, account, headers, source);
  };

  const viaSavedSession = async () => viaCookie(
    secret.sessionCookie,
    'saved_browser_session',
    secret.sessionUserAgent || '',
  );

  const viaPasswordApi = async (turnstileToken = '') => {
    if (!hasPassword) throw new Error('未配置用户名与密码');
    if (!turnstileToken) {
      const nativeTurnstile = await fetchNewApiTurnstileStatus(root, secret);
      if (nativeTurnstile.enabled) {
        detectedTurnstileSiteKey = nativeTurnstile.siteKey;
        const error = new Error('New API 已启用原生 Turnstile，需先完成验证再登录');
        error.code = 'TURNSTILE_REQUIRED';
        error.siteKey = nativeTurnstile.siteKey;
        throw error;
      }
    }
    const login = await loginNewApiPassword(root, account, secret, turnstileToken);
    if (login.tokens.accessToken) {
      const next = rememberCredentials({
        accessToken: login.tokens.accessToken,
        refreshToken: login.tokens.refreshToken,
        cookieHeader: login.cookieHeader,
      });
      const headers = {
        ...accessHeaders,
        Accept: 'application/json',
        Authorization: login.tokens.accessToken,
        ...(account.userId ? { 'New-Api-User': String(account.userId) } : {}),
      };
      try {
        const tokenResult = await fetchNewApiProfile(root, account, headers, 'password_access_token');
        return { ...tokenResult, updatedSecret: next };
      } catch (error) {
        if (!login.cookieHeader) throw failure(error);
      }
      try {
        const result = await viaCookie(
          login.cookieHeader,
          turnstileToken ? 'password_with_turnstile' : 'password_session',
        );
        return { ...result, updatedSecret: next };
      } catch (error) {
        throw failure(error);
      }
    }
    try {
      const result = await viaCookie(
        login.cookieHeader,
        turnstileToken ? 'password_with_turnstile' : 'password_session',
      );
      const next = rememberSession(login.cookieHeader);
      return next ? { ...result, updatedSecret: next } : result;
    } catch (error) {
      throw failure(error);
    }
  };

  /**
   * CF 出现时：先浏览器过盾；成功则用会话/token；失败再抛出让上层回退令牌
   */
  const viaBrowserOnCf = async (verificationAccessToken = '') => {
    const solved = await solveCloudflareChallenge({
      root,
      account,
      secret,
      verificationAccessToken,
      detectedSiteKey: detectedTurnstileSiteKey,
    });

    if (verificationAccessToken && solved.verificationFailed) {
      rememberCloudflareClearance(solved.cookies, solved.userAgent);
      const error = new Error('Cloudflare 已放行，但当前访问令牌未通过资料接口鉴权');
      error.code = 'UPSTREAM_AUTH_FAILED';
      throw error;
    }

    // Strongest browser result: the profile endpoint succeeded in the same context
    // that completed the challenge and login.
    if (solved.profile?.body) {
      const result = {
        rawBalance: numericBalance(solved.profile.body, account.balancePath || 'data.quota'),
        metadata: {
          authSource: solved.method === 'browser_verified_access_profile'
            ? 'access_token_with_cloudflare_browser'
            : 'password_with_turnstile_browser',
          profilePath: solved.profile.path || account.profilePath || '/api/user/self',
          status: readPath(solved.profile.body, 'data.status'),
          usedQuota: readPath(solved.profile.body, 'data.used_quota'),
          requestCount: readPath(solved.profile.body, 'data.request_count'),
          browserVerified: true,
          challengeMethod: solved.method,
        },
      };
      const next = solved.method === 'browser_verified_access_profile'
        ? rememberCloudflareClearance(solved.cookies, solved.userAgent)
        : rememberCredentials({
            accessToken: solved.accessToken,
            refreshToken: solved.refreshToken,
            cookieHeader: solved.cookies,
            userAgent: solved.userAgent,
          });
      return next ? { ...result, updatedSecret: next } : result;
    }

    // Browser completed login with session cookies (typical New API)
    if (solved.cookies) {
      try {
        const result = await viaCookie(
          solved.cookies,
          'password_with_turnstile_browser',
          solved.userAgent,
        );
        const next = rememberCredentials({
          accessToken: solved.accessToken,
          refreshToken: solved.refreshToken,
          cookieHeader: solved.cookies,
          userAgent: solved.userAgent,
        });
        return next ? { ...result, updatedSecret: next } : result;
      } catch (error) {
        errors.push(`浏览器会话拉取资料失败：${error.message}`);
      }
    }

    // Browser returned API access token
    if (solved.accessToken) {
      const next = rememberCredentials({
        accessToken: solved.accessToken,
        refreshToken: solved.refreshToken,
        cookieHeader: solved.cookies,
        userAgent: solved.userAgent,
      });
      const headers = {
        ...accessHeaders,
        Accept: 'application/json',
        Authorization: solved.accessToken,
        ...(account.userId ? { 'New-Api-User': String(account.userId) } : {}),
      };
      try {
        const result = await fetchNewApiProfile(root, account, headers, 'password_with_turnstile_browser');
        return { ...result, updatedSecret };
      } catch (error) {
        errors.push(`浏览器拿到的 Token 无效：${error.message}`);
      }
    }

    // Got turnstile token only → retry password login API
    if (solved.token && hasPassword) {
      try {
        assertFreshTurnstileToken(solved);
        // Mark before the request so no error path can accidentally replay it.
        solved.tokenConsumed = true;
        const result = await viaPasswordApi(solved.token);
        return result;
      } catch (error) {
        errors.push(`Turnstile token 重试登录失败：${error.message}`);
      }
    }

    throw failure(
      `浏览器过盾未能完成 New API 登录。${errors.join('；') || turnstileManualHint()}`,
    );
  };

  const preferPassword = account.authMode === 'password' || (hasPassword && !hasToken);

  // --- Password-first path ---
  if (preferPassword && hasPassword) {
    if (savedSessionUsable) {
      try {
        return await viaSavedSession();
      } catch (error) {
        errors.push(`已保存会话：${error.message}`);
      }
    }
    try {
      return await viaPasswordApi(secret.turnstileToken || '');
    } catch (error) {
      errors.push(`密码登录：${error.message}`);

      // CF / Turnstile → browser first
      if (isCloudflareChallenge(error) || error.code === 'TURNSTILE' || error.code === 'CF_CHALLENGE_PAGE') {
        try {
          const result = await viaBrowserOnCf();
          return updatedSecret ? { ...result, updatedSecret } : result;
        } catch (browserError) {
          errors.push(`浏览器过盾：${browserError.message}`);
          // Fall back to 令牌
          if (hasToken) {
            try {
              return await viaToken('access_token_fallback');
            } catch (tokenError) {
              errors.push(`令牌回退：${tokenError.message}`);
            }
          }
          throw failure(`New API 遇 CF 盾：浏览器过盾失败后令牌回退也失败。${errors.join(' → ')}`);
        }
      }

      // Non-CF password failure → still try token fallback
      if (hasToken) {
        try {
          return await viaToken('access_token_fallback');
        } catch (tokenError) {
          errors.push(`令牌回退：${tokenError.message}`);
        }
      }
      throw failure(errors.join(' → '));
    }
  }

  // --- Token-first path (default New API) ---
  if (hasToken) {
    try {
      return await viaToken('access_token');
    } catch (error) {
      errors.push(`令牌访问：${error.message}`);

      // CF on API → browser (if password), then token already failed
      if (isCloudflareChallenge(error) || error.code === 'CF_CHALLENGE_PAGE') {
        const firstIndex = scheduledTokenIndexes(
          tokenPool.length,
          account.tokenStrategy,
          secret.tokenCursor,
        )[0];
        try {
          const result = await viaBrowserOnCf(tokenPool[firstIndex]);
          return updatedSecret ? { ...result, updatedSecret } : result;
        } catch (browserError) {
          errors.push(`浏览器令牌过盾：${browserError.message}`);
        }
        if (Object.keys(cloudflareClearanceHeaders()).length) {
          try {
            return await viaToken('access_token_after_cloudflare');
          } catch (tokenError) {
            errors.push(`clearance 后令牌池：${tokenError.message}`);
          }
        }
        if (hasPassword) {
          try {
            const result = await viaBrowserOnCf();
            return updatedSecret ? { ...result, updatedSecret } : result;
          } catch (browserError) {
            errors.push(`浏览器密码过盾：${browserError.message}`);
          }
        }
        throw failure(
          `New API 令牌请求遇到 Cloudflare 防护。${errors.join(' → ')}。${turnstileManualHint()}`,
        );
      }

      // Auth failure with password available → password / CF browser chain
      if (hasPassword && (isAuthFailure(error) || account.authMode === 'password')) {
        if (savedSessionUsable) {
          try {
            return await viaSavedSession();
          } catch (sessionError) {
            errors.push(`已保存会话：${sessionError.message}`);
          }
        }
        try {
          return await viaPasswordApi(secret.turnstileToken || '');
        } catch (pwdError) {
          errors.push(`密码登录：${pwdError.message}`);
          if (isCloudflareChallenge(pwdError) || pwdError.code === 'TURNSTILE' || pwdError.code === 'CF_CHALLENGE_PAGE') {
            try {
              const result = await viaBrowserOnCf();
              return updatedSecret ? { ...result, updatedSecret } : result;
            } catch (browserError) {
              errors.push(`浏览器过盾：${browserError.message}`);
              // Final fallback: token already failed; rethrow combined
            }
          }
        }
      }

      throw failure(errors.join(' → '));
    }
  }

  if (hasPassword) {
    // No token at all
    if (savedSessionUsable) {
      try {
        return await viaSavedSession();
      } catch (error) {
        errors.push(`已保存会话：${error.message}`);
      }
    }
    try {
      return await viaPasswordApi(secret.turnstileToken || '');
    } catch (error) {
      if (isCloudflareChallenge(error) || error.code === 'TURNSTILE' || error.code === 'CF_CHALLENGE_PAGE') {
        return viaBrowserOnCf();
      }
      throw error;
    }
  }

  throw new Error('New API 需要“个人资料 → 安全 → 访问令牌”与 User ID，或可登录的用户名密码');
}

async function refreshSub2Api(root, refreshToken, secret = {}) {
  const result = await requestJson(`${root}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...cloudflareAccessHeaders(secret),
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  assertSuccess(result.response, result.body);
  const tokens = extractTokens(result.body);
  if (!tokens.accessToken) throw new Error('Refresh Token 续期成功，但上游未返回 Access Token');
  return tokens;
}

async function postSub2Login(root, account, secret, turnstileToken) {
  const body = {
    email: account.username,
    password: secret.password,
    ...turnstileRequestFields(turnstileToken),
  };

  return requestJson(`${root}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...cloudflareAccessHeaders(secret),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Password login with CF handling:
 * 1) direct login
 * 2) on CF → browser/solver first
 * 3) caller may fall back to AT/RT
 */
async function loginSub2Api(root, account, secret) {
  if (!account.username || !secret.password) {
    throw new Error('Sub2API 密码登录需要邮箱和密码');
  }

  let usedTurnstile = Boolean(secret.turnstileToken);
  let login = null;
  let challengeError = null;
  try {
    login = await postSub2Login(root, account, secret, secret.turnstileToken || '');
  } catch (error) {
    if (!isCloudflareChallenge(error)) throw error;
    challengeError = error;
  }
  let reason = login?.body?.reason || login?.body?.error || login?.body?.message || challengeError?.message || '';

  if (challengeError || isTurnstileFailure(login?.body, reason) || login?.body?.code === 'CF_CHALLENGE_PAGE') {
    try {
      const solved = await solveCloudflareChallenge({ root, account, secret });
      usedTurnstile = true;

      if (solved.accessToken) {
        return {
          accessToken: solved.accessToken,
          refreshToken: solved.refreshToken || '',
          _authSource: 'password_with_turnstile_browser',
          _profile: solved.profile || null,
        };
      }

      if (solved.profile?.body) {
        throw new Error('浏览器会话已验证，但 Sub2API 未返回可持久化的 Access Token / Refresh Token');
      }

      assertFreshTurnstileToken(solved);
      solved.tokenConsumed = true;
      login = await postSub2Login(root, account, secret, solved.token);
      reason = login.body?.reason || login.body?.error || login.body?.message || '';
      if (isTurnstileFailure(login.body, reason)) {
        const err = new Error(`Turnstile 自动解算后上游仍拒绝：${reason || 'TURNSTILE_VERIFICATION_FAILED'}`);
        err.code = 'TURNSTILE_RETRY_FAILED';
        throw err;
      }
    } catch (error) {
      if (error.code === 'TURNSTILE_RETRY_FAILED') throw error;
      const err = new Error(`Turnstile 自动处理失败：${error.message}`);
      err.code = 'TURNSTILE_SOLVE_FAILED';
      err.cause = error;
      throw err;
    }
  }

  assertSuccess(login.response, login.body);
  const tokens = extractTokens(login.body);
  if (!tokens.accessToken) {
    throw new Error('登录成功，但上游未返回 Access Token，请改用手动粘贴 AT/RT');
  }
  tokens._authSource = usedTurnstile
    ? (String(config.turnstileSolver).toLowerCase() === 'browser' ? 'password_with_turnstile_browser' : 'password_with_turnstile')
    : 'password';
  return tokens;
}

async function collectSub2Api(account, secret = {}) {
  const root = baseUrl(account.baseUrl);
  let accessToken = secret.accessToken || '';
  let refreshToken = secret.refreshToken || '';
  let updatedSecret;
  let authSource = accessToken ? 'access_token' : refreshToken ? 'refresh_token' : 'password';
  let refreshReason = '';
  let refreshTokenRotated = false;
  let refreshAttempted = false;
  const errors = [];
  const accessHeaders = cloudflareAccessHeaders(secret);

  const checkpoint = (errorOrMessage) => {
    const error = errorOrMessage instanceof Error
      ? errorOrMessage
      : new Error(String(errorOrMessage || 'Sub2API 鉴权失败'));
    return updatedSecret ? attachCredentialCheckpoint(error, updatedSecret) : error;
  };

  const remember = (tokens, source) => {
    const previousRefreshToken = refreshToken;
    accessToken = tokens.accessToken || accessToken;
    refreshToken = tokens.refreshToken || refreshToken;
    refreshTokenRotated = Boolean(tokens.refreshToken && previousRefreshToken && tokens.refreshToken !== previousRefreshToken);
    authSource = source;
    const accessJwtExpiry = tokenTiming(accessToken).expiresAt;
    const refreshJwtExpiry = tokenTiming(refreshToken, 0).expiresAt;
    const next = {
      ...secret,
      accessToken,
      refreshToken,
      accessTokenExpiresAt: accessJwtExpiry
        || (tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : ''),
      refreshTokenExpiresAt: refreshJwtExpiry
        || (tokens.refreshExpiresIn ? new Date(Date.now() + tokens.refreshExpiresIn * 1000).toISOString() : '')
        || (!tokens.refreshToken || tokens.refreshToken === previousRefreshToken ? secret.refreshTokenExpiresAt || '' : ''),
    };
    delete next.turnstileToken;
    delete next._authSource;
    updatedSecret = next;
  };

  const paths = [...new Set([
    account.profilePath,
    '/api/v1/users/me',
    '/api/v1/auth/me',
    '/api/v1/user/profile',
    '/api/v1/user/self',
  ].filter(Boolean))];

  const profileResult = (body, path) => ({
    rawBalance: numericBalance(body, account.balancePath || 'data.balance'),
    metadata: {
      authSource,
      profilePath: path,
      status: readPath(body, 'data.status'),
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken),
      tokenRenewed: Boolean(updatedSecret),
      accessTokenExpiresAt: effectiveTokenTiming(
        accessToken,
        updatedSecret?.accessTokenExpiresAt || secret.accessTokenExpiresAt,
      ).expiresAt,
      refreshTokenExpiresAt: effectiveTokenTiming(
        refreshToken,
        updatedSecret?.refreshTokenExpiresAt || secret.refreshTokenExpiresAt,
        0,
      ).expiresAt,
      refreshReason,
      refreshTokenRotated,
    },
  });

  async function tryProfiles(token) {
    let lastError;
    for (const path of paths) {
      try {
        const result = await requestJson(`${root}${path}`, {
          headers: {
            ...accessHeaders,
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });
        assertSuccess(result.response, result.body);
        return profileResult(result.body, path);
      } catch (error) {
        lastError = error;
        if (error.code === 'CF_CHALLENGE_PAGE' || isCloudflareChallenge(error) || isAuthFailure(error)) break;
      }
    }
    throw lastError;
  }

  const accessTiming = effectiveTokenTiming(accessToken, secret.accessTokenExpiresAt);
  const refreshTiming = effectiveTokenTiming(refreshToken, secret.refreshTokenExpiresAt, 0);

  // 1) 没有 AT，或 JWT AT 已到期/即将到期时，优先用 RT 主动续期
  if ((!accessToken || accessTiming.expiringSoon) && refreshToken && !refreshTiming.expired) {
    try {
      refreshAttempted = true;
      refreshReason = !accessToken ? 'missing_access_token' : accessTiming.expired ? 'access_token_expired' : 'access_token_expiring';
      remember(await refreshSub2Api(root, refreshToken, secret), 'refresh_token');
    } catch (error) {
      errors.push(`RT 续期：${error.message}`);
      if (!secret.password && !accessToken) {
        // continue to password if any
      }
    }
  }

  if (refreshToken && refreshTiming.expired) {
    errors.push('RT 已过期，跳过无效续期');
  }

  // 2) 有 AT 先拉资料
  if (accessToken) {
    try {
      return { ...(await tryProfiles(accessToken)), updatedSecret };
    } catch (error) {
      errors.push(`AT 访问：${error.message}`);
      // CF on profile → try browser password login first, then RT / password
      if (isCloudflareChallenge(error) || error.code === 'CF_CHALLENGE_PAGE') {
        if (secret.password && account.username) {
          try {
            const solved = await solveCloudflareChallenge({ root, account, secret });
            if (solved.accessToken) {
              remember(
                { accessToken: solved.accessToken, refreshToken: solved.refreshToken || '' },
                'password_with_turnstile_browser',
              );
              if (solved.profile?.body) {
                return { ...profileResult(solved.profile.body, solved.profile.path || account.profilePath), updatedSecret };
              }
              return { ...(await tryProfiles(accessToken)), updatedSecret };
            }
            if (solved.token) {
              assertFreshTurnstileToken(solved);
              solved.tokenConsumed = true;
              const tokens = await loginSub2Api(root, account, { ...secret, turnstileToken: solved.token });
              remember(tokens, tokens._authSource || 'password_with_turnstile');
              if (tokens._profile?.body) {
                return { ...profileResult(tokens._profile.body, tokens._profile.path || account.profilePath), updatedSecret };
              }
              return { ...(await tryProfiles(accessToken)), updatedSecret };
            }
          } catch (browserError) {
            errors.push(`浏览器过盾：${browserError.message}`);
            // fall through to RT / password / throw
          }
        }
      } else if (!isAuthFailure(error)) {
        throw checkpoint(error);
      }
    }
  }

  // 3) AT 失败后用 RT 续期（令牌回退链）
  if (!refreshAttempted && refreshToken && !effectiveTokenTiming(
    refreshToken,
    updatedSecret?.refreshTokenExpiresAt || secret.refreshTokenExpiresAt,
    0,
  ).expired) {
    try {
      refreshAttempted = true;
      remember(await refreshSub2Api(root, refreshToken, secret), 'refresh_token');
      return { ...(await tryProfiles(accessToken)), updatedSecret };
    } catch (error) {
      errors.push(`RT 续期：${error.message}`);
      if (!secret.password) {
        throw checkpoint(new Error(
          `Access/Refresh Token 均已失效：${error.message}。`
          + (errors.length ? `（${errors.join('；')}）` : '')
          + ' 请重新粘贴 AT/RT，或提供密码以在遇 CF 时自动过盾。',
        ));
      }
    }
  }

  // 4) 密码登录：遇 CF 先浏览器过盾；失败则说明已无可用令牌
  if (secret.password && account.username) {
    try {
      const tokens = await loginSub2Api(root, account, secret);
      const source = tokens._authSource || (secret.turnstileToken ? 'password_with_turnstile' : 'password');
      remember(tokens, source);
      if (tokens._profile?.body) {
        return { ...profileResult(tokens._profile.body, tokens._profile.path || account.profilePath), updatedSecret };
      }
      return { ...(await tryProfiles(accessToken)), updatedSecret };
    } catch (error) {
      errors.push(`密码登录：${error.message}`);
      // 若仍有 AT（极少情况），再试一次令牌回退
      if (secret.accessToken && secret.accessToken !== accessToken) {
        try {
          remember({ accessToken: secret.accessToken, refreshToken: secret.refreshToken || '' }, 'access_token_fallback');
          return { ...(await tryProfiles(accessToken)), updatedSecret };
        } catch (tokenError) {
          errors.push(`令牌回退：${tokenError.message}`);
        }
      }
      throw checkpoint(new Error(`${errors.join(' → ')}。${turnstileManualHint()}`));
    }
  }

  if (!accessToken && !refreshToken) {
    throw checkpoint(new Error('Sub2API 需要 Access Token，或 Access+Refresh Token，或可登录的邮箱密码'));
  }
  throw checkpoint(new Error(
    errors.length
      ? `Sub2API 鉴权失败：${errors.join(' → ')}`
      : 'Sub2API 鉴权失败：请更新 Access Token / Refresh Token',
  ));
}

async function collectGeneric(account, secret) {
  const root = baseUrl(account.baseUrl);
  const headers = { Accept: 'application/json', ...cloudflareAccessHeaders(secret) };
  if (secret.accessToken) headers.Authorization = account.tokenPrefix === 'none' ? secret.accessToken : `Bearer ${secret.accessToken}`;
  const result = await requestJson(`${root}${account.profilePath || '/api/user/self'}`, { headers });
  assertSuccess(result.response, result.body);
  return { rawBalance: numericBalance(result.body, account.balancePath), metadata: { authSource: 'generic' } };
}

export async function collectBalance(account, secret) {
  return withUpstreamProxyContext(account, async () => {
    const hasOneShotTurnstileToken = Boolean(secret?.turnstileToken);
    try {
      if (hasOneShotTurnstileToken && !consumeOneShotTurnstileToken(secret.turnstileToken)) {
        const error = new Error('一次性 Turnstile token 已使用、已过期或格式无效，请重新完成验证');
        error.code = 'TURNSTILE_TOKEN_REPLAYED';
        throw error;
      }
      let result;
      if (account.type === 'newapi') result = await collectNewApi(account, secret);
      else if (account.type === 'sub2api') result = await collectSub2Api(account, secret);
      else result = await collectGeneric(account, secret);

      if (!hasOneShotTurnstileToken) return result;
      const nextSecret = { ...(result.updatedSecret || secret) };
      delete nextSecret.turnstileToken;
      return { ...result, updatedSecret: nextSecret };
    } catch (error) {
      if (hasOneShotTurnstileToken) {
        const nextSecret = { ...(getCredentialCheckpoint(error) || secret) };
        delete nextSecret.turnstileToken;
        attachCredentialCheckpoint(error, nextSecret);
      }
      throw error;
    }
  });
}

/** 合并凭据：新字段覆盖旧字段，空字符串表示不改动（除明确清空场景外由调用方处理） */
export function mergeSecrets(existing = {}, incoming = {}) {
  const next = { ...existing };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value === undefined || value === null || value === '') continue;
    next[key] = value;
  }
  // 一次性 turnstile 不应长期残留；若本次未传入则清掉旧值
  if (!incoming?.turnstileToken) delete next.turnstileToken;
  return next;
}
