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
import {
  createPinnedDispatcher,
  parseUpstreamUrl,
  readLimitedBody,
  resolveUpstreamUrl,
} from './network-policy.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseUrl(value) {
  const url = parseUpstreamUrl(value, {
    production: config.production,
    allowedHosts: config.upstreamAllowedHosts,
  });
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

function upstreamBrowserSessionHeaders(secret = {}) {
  const cookie = String(secret.sessionCookie || '').trim().replace(/[\r\n]/g, '');
  const userAgent = String(secret.sessionUserAgent || '').trim().replace(/[\r\n]/g, '');
  return {
    ...(cookie ? { Cookie: cookie } : {}),
    ...(userAgent ? { 'User-Agent': userAgent } : {}),
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
    const proxy = currentUpstreamProxyContext();
    let dispatcher = proxy?.dispatcher || currentOptions.dispatcher;
    let ownedDispatcher = null;
    if (config.enforceUpstreamNetworkPolicy) {
      const resolved = await resolveUpstreamUrl(currentUrl, {
        production: config.production,
        allowedHosts: config.upstreamAllowedHosts,
        allowPrivate: false,
      });
      if (!dispatcher) {
        ownedDispatcher = createPinnedDispatcher(resolved);
        dispatcher = ownedDispatcher;
      }
    } else {
      parseUpstreamUrl(currentUrl, {
        production: config.production,
        allowedHosts: config.upstreamAllowedHosts,
      });
    }
    let response;
    try {
      response = await fetch(currentUrl, { ...currentOptions, ...(dispatcher ? { dispatcher } : {}) });
    } catch (error) {
      await ownedDispatcher?.close?.().catch(() => {});
      throw error;
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, release: () => ownedDispatcher?.close?.() };
    }
    const location = response.headers.get('location');
    if (!location) return { response, release: () => ownedDispatcher?.close?.() };
    if (redirectCount === maxRedirects) throw new Error('上游重定向次数过多');

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin !== initialOrigin) {
      await response.body?.cancel().catch(() => {});
      const error = new Error('上游尝试跨域重定向，已阻止凭据发送到其他站点');
      error.code = 'UPSTREAM_CROSS_ORIGIN_REDIRECT';
      await ownedDispatcher?.close?.().catch(() => {});
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
    await ownedDispatcher?.close?.().catch(() => {});
    currentUrl = nextUrl.toString();
  }
  throw new Error('上游重定向次数过多');
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  let release = null;
  try {
    const result = await fetchWithSameOriginRedirects(url, {
      ...options,
      signal: controller.signal,
    });
    const { response } = result;
    release = result.release;
    const text = await readLimitedBody(response, config.upstreamResponseMaxBytes);
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
    try {
      await release?.();
    } catch {
      // Closing an owned dispatcher must not replace the upstream result.
    }
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

function hasScheduledTokenCursor(cursor) {
  return cursor !== undefined
    && cursor !== null
    && cursor !== ''
    && Number.isInteger(Number(cursor));
}

export function scheduledTokenIndexes(size, strategy = 'sticky', cursor) {
  if (!Number.isInteger(size) || size <= 0) return [];
  const hasCursor = hasScheduledTokenCursor(cursor);
  const normalizedCursor = hasCursor
    ? Math.min(size - 1, Math.max(0, Number(cursor)))
    : 0;
  const start = strategy === 'round_robin' && hasCursor ? (normalizedCursor + 1) % size : normalizedCursor;
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
      ...upstreamBrowserSessionHeaders(secret),
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

function nonnegativeFiniteNumber(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteMetadataNumber(source, path) {
  return nonnegativeFiniteNumber(readPath(source, path));
}

function firstFiniteMetadataNumber(source, paths) {
  for (const path of paths) {
    const value = finiteMetadataNumber(source, path);
    if (value !== undefined) return { value, path };
  }
  return undefined;
}

function directApiKeyRateMetadata(body, source) {
  const effective = firstFiniteMetadataNumber(body, [
    'data.effective_rate_multiplier',
    'effective_rate_multiplier',
    'data.rate_multiplier',
    'rate_multiplier',
    'data.group_ratio',
    'group_ratio',
    'data.ratio',
    'ratio',
  ]);
  if (!effective) return {};
  return {
    rateMultiplier: effective.value,
    rateMultiplierStatus: 'available',
    rateMultiplierSource: source,
    rateMultiplierPath: effective.path,
    tokenGroup: String(
      readPath(body, 'data.group')
      || readPath(body, 'data.token_group')
      || readPath(body, 'group')
      || readPath(body, 'token_group')
      || '',
    ),
  };
}

function maskNewApiKey(token) {
  const raw = String(token || '').trim().replace(/^Bearer\s+/i, '').replace(/^sk-/, '');
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  if (raw.length <= 8) return `${raw.slice(0, 2)}****${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}**********${raw.slice(-4)}`;
}

function newApiTokenList(body) {
  const candidates = [
    readPath(body, 'data.items'),
    readPath(body, 'data.data'),
    readPath(body, 'items'),
    readPath(body, 'data'),
  ];
  return candidates.find(Array.isArray) || [];
}

function newApiUsageRemaining(body, balancePath = 'data.total_available') {
  if (balancePath !== 'data.total_available') {
    return { rawBalance: numericBalance(body, balancePath), unlimitedQuota: false, userQuotaRemaining: undefined };
  }
  const data = readPath(body, 'data') || {};
  const keyRemaining = nonnegativeFiniteNumber(data.total_available);
  const userQuotaRemaining = nonnegativeFiniteNumber(data.user_quota?.total_available);
  const unlimitedQuota = data.unlimited_quota === true;
  const candidates = [
    ...(unlimitedQuota ? [] : [keyRemaining]),
    userQuotaRemaining,
  ].filter((value) => value !== undefined);
  if (!candidates.length) {
    const error = new Error('该令牌为无限额度，接口未返回可监控的用户有限余额；请为令牌开启用户额度查询或创建有限额度令牌');
    error.code = 'UNLIMITED_QUOTA';
    throw error;
  }
  return {
    rawBalance: Math.min(...candidates),
    unlimitedQuota: false,
    userQuotaRemaining,
  };
}

function matchNewApiTokenItem(items, authorizationToken, tokenName) {
  const masked = maskNewApiKey(authorizationToken);
  const keyMatches = items.filter((item) => {
    const itemKey = String(item?.key || '').replace(/^sk-/, '');
    return masked && itemKey === masked;
  });
  if (keyMatches.length === 1) return keyMatches[0];
  const nameMatches = items.filter((item) => tokenName && String(item?.name || '') === tokenName);
  return nameMatches.length === 1 ? nameMatches[0] : undefined;
}

async function collectNewApiKeyRate(root, account, secret, authorizationToken, usageBody) {
  const direct = directApiKeyRateMetadata(usageBody, 'newapi_usage_token');
  if (direct.rateMultiplier !== undefined) return direct;

  const directGroup = String(
    readPath(usageBody, 'data.group')
    || readPath(usageBody, 'data.token_group')
    || readPath(usageBody, 'group')
    || readPath(usageBody, 'token_group')
    || '',
  );
  const accessToken = String(secret.accessToken || normalizeTokenPool(secret)[0] || '').trim();
  if (!accessToken || !account.userId) {
    return {
      rateMultiplierStatus: directGroup === 'auto' ? 'dynamic' : 'needs_user_access',
      rateMultiplierSource: 'newapi_user_groups',
      tokenGroup: directGroup,
    };
  }

  const headers = {
    Accept: 'application/json',
    Authorization: accessToken,
    'New-Api-User': String(account.userId),
    ...cloudflareAccessHeaders(secret),
  };
  try {
    const [tokensResult, groupsResult] = await Promise.all([
      requestJson(`${root}/api/token/?p=1&size=100`, { headers }),
      requestJson(`${root}/api/user/self/groups`, { headers }),
    ]);
    assertSuccess(tokensResult.response, tokensResult.body);
    assertSuccess(groupsResult.response, groupsResult.body);

    const tokenName = String(readPath(usageBody, 'data.name') || readPath(usageBody, 'name') || '');
    const tokenItem = matchNewApiTokenItem(newApiTokenList(tokensResult.body), authorizationToken, tokenName);
    if (!tokenItem && !directGroup) {
      return { rateMultiplierStatus: 'unavailable', rateMultiplierSource: 'newapi_user_groups' };
    }
    const tokenGroup = String(tokenItem?.group || directGroup || 'default');
    if (tokenGroup === 'auto') {
      return {
        rateMultiplierStatus: 'dynamic',
        rateMultiplierSource: 'newapi_user_groups',
        tokenGroup,
      };
    }
    const groupInfo = readPath(groupsResult.body, 'data')?.[tokenGroup];
    const rateMultiplier = nonnegativeFiniteNumber(groupInfo?.ratio ?? groupInfo);
    if (rateMultiplier === undefined) {
      return {
        rateMultiplierStatus: 'unavailable',
        rateMultiplierSource: 'newapi_user_groups',
        tokenGroup,
      };
    }
    return {
      rateMultiplier,
      rateMultiplierStatus: 'available',
      rateMultiplierSource: 'newapi_user_groups',
      tokenGroup,
    };
  } catch (error) {
    return {
      rateMultiplierStatus: isCloudflareChallenge(error) ? 'challenge' : 'unavailable',
      rateMultiplierSource: 'newapi_user_groups',
    };
  }
}

async function collectSub2ApiKeyRate(root, secret, authorizationToken) {
  try {
    const result = await requestJson(`${root}/v1/sub2api/billing`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${authorizationToken}`,
        ...cloudflareAccessHeaders(secret),
      },
    });
    assertSuccess(result.response, result.body);
    const rateMultiplier = finiteMetadataNumber(result.body, 'effective_rate_multiplier');
    if (rateMultiplier === undefined) {
      return { rateMultiplierStatus: 'unavailable', rateMultiplierSource: 'sub2api_key_billing' };
    }
    return {
      rateMultiplier,
      rateMultiplierStatus: 'available',
      rateMultiplierSource: 'sub2api_key_billing',
      billingScope: result.body.billing_scope,
      groupRateMultiplier: finiteMetadataNumber(result.body, 'group_rate_multiplier'),
      userRateMultiplier: finiteMetadataNumber(result.body, 'user_rate_multiplier'),
      resolvedRateMultiplier: finiteMetadataNumber(result.body, 'resolved_rate_multiplier'),
      peakRateEnabled: result.body.peak_rate_enabled === true,
      peakRateMultiplier: finiteMetadataNumber(result.body, 'peak_rate_multiplier'),
      appliedPeakMultiplier: finiteMetadataNumber(result.body, 'applied_peak_multiplier'),
      billingTimezone: result.body.timezone,
      billingObservedAt: result.body.observed_at,
    };
  } catch (error) {
    return {
      rateMultiplierStatus: error?.status === 404
        ? 'unsupported'
        : isCloudflareChallenge(error) ? 'challenge' : 'unavailable',
      rateMultiplierSource: 'sub2api_key_billing',
    };
  }
}

async function requestNewApiTokenUsage(root, account, headers) {
  const configuredPath = account.profilePath || '/api/usage/token';
  const paths = [...new Set([
    configuredPath,
    configuredPath.endsWith('/') ? configuredPath.slice(0, -1) : `${configuredPath}/`,
  ])];
  let lastResult;
  for (const path of paths) {
    const result = await requestJson(`${root}${path}`, { headers });
    lastResult = result;
    if (result.response.ok) return { ...result, path };
    if (![404, 405].includes(result.response.status)) assertSuccess(result.response, result.body);
  }
  assertSuccess(lastResult.response, lastResult.body);
  return { ...lastResult, path: paths.at(-1) };
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
        const result = await requestNewApiTokenUsage(root, account, {
          Accept: 'application/json',
          Authorization: `Bearer ${authorizationToken}`,
          ...cloudflareAccessHeaders(secret),
        });
        assertSuccess(result.response, result.body);
        const usage = newApiUsageRemaining(result.body, account.balancePath || 'data.total_available');
        const rawBalance = usage.rawBalance;
        const rateMetadata = await collectNewApiKeyRate(root, account, secret, authorizationToken, result.body);
        const normalizedTokenPool = tokenPool.map((token, slot) => (
          slot === index ? authorizationToken : token
        ));
        const nextSecret = {
          ...secret,
          apiToken: authorizationToken,
          apiTokens: normalizedTokenPool,
          apiTokenCursor: index,
        };
        const poolChanged = Array.isArray(secret.apiTokens)
          && JSON.stringify(secret.apiTokens.map((token) => String(token || '').trim()).filter(Boolean)) !== JSON.stringify(normalizedTokenPool);
        const changed = poolChanged
          || secret.apiToken !== authorizationToken
          || !hasScheduledTokenCursor(secret.apiTokenCursor)
          || Number(secret.apiTokenCursor) !== index;
        return {
          rawBalance,
          metadata: {
            authSource: 'api_key',
            balanceScope: 'api_key',
            tokenName: readPath(result.body, 'data.name'),
            totalGranted: readPath(result.body, 'data.total_granted'),
            totalUsed: readPath(result.body, 'data.total_used'),
            unlimitedQuota: usage.unlimitedQuota,
            userQuotaRemaining: usage.userQuotaRemaining,
            expiresAt: readPath(result.body, 'data.expires_at'),
            profilePath: result.path || account.profilePath || '/api/usage/token',
            apiTokenPoolSize: tokenPool.length,
            apiTokenSlot: index + 1,
            tokenStrategy: account.tokenStrategy || 'sticky',
            tokenFailovers: errors.length,
            tokenPrefixMode: authorizationToken === tokenPool[index] ? 'as_entered' : 'sk_compat',
            ...rateMetadata,
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

function sub2ApiUsageScope(body = {}) {
  if (String(body.mode || '').toLowerCase() === 'quota_limited' || body.quota) return 'api_key';
  if (body.subscription) return 'subscription';
  if (Object.hasOwn(body, 'balance')) return 'wallet';
  return 'api_key';
}

function sub2ApiRemaining(body = {}, balancePath = 'remaining') {
  const raw = readPath(body, balancePath);
  const value = typeof raw === 'boolean' || raw === null || raw === '' ? Number.NaN : Number(raw);
  if (value === -1) {
    const error = new Error(`Sub2API ${balancePath} 返回无限额度（-1），没有可监控的有限余额`);
    error.code = 'UNMONITORABLE_BALANCE';
    throw error;
  }
  if (!Number.isFinite(value) || value < 0) {
    const error = new Error(`Sub2API 未返回可监控的有限 ${balancePath}（可能仅配置了速率限制）`);
    error.code = 'UNMONITORABLE_BALANCE';
    throw error;
  }
  return value;
}

function isSub2ApiKeyAuthFailure(error) {
  return error?.code === 'UPSTREAM_AUTH_FAILED' || [401, 403].includes(error?.status);
}

async function collectSub2ApiTokenUsage(root, account, secret = {}) {
  const tokenPool = normalizeApiTokenPool(secret);
  if (!tokenPool.length) throw new Error('请填写 Sub2API 创建的 API Key');

  const usagePath = account.profilePath || '/v1/usage';
  const balancePath = account.balancePath || 'remaining';
  const errors = [];
  let unmonitorableSlots = 0;
  const indexes = scheduledTokenIndexes(tokenPool.length, account.tokenStrategy, secret.apiTokenCursor);
  for (const index of indexes) {
    let slotError;
    for (const authorizationToken of apiTokenAuthorizationCandidates(tokenPool[index])) {
      try {
        const result = await requestJson(`${root}${usagePath}`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${authorizationToken}`,
            ...cloudflareAccessHeaders(secret),
          },
        });
        assertSuccess(result.response, result.body);
        if (result.body.isValid === false) {
          const error = new Error(`Sub2API API Key 当前不可用${result.body.status ? `（${result.body.status}）` : ''}`);
          error.code = 'UPSTREAM_AUTH_FAILED';
          error.status = 401;
          throw error;
        }

        const rawBalance = sub2ApiRemaining(result.body, balancePath);
        const balanceScope = sub2ApiUsageScope(result.body);
        const rateMetadata = await collectSub2ApiKeyRate(root, secret, authorizationToken);
        const normalizedTokenPool = tokenPool.map((token, slot) => (
          slot === index ? authorizationToken : token
        ));
        const nextSecret = {
          ...secret,
          apiToken: authorizationToken,
          apiTokens: normalizedTokenPool,
          apiTokenCursor: index,
        };
        const poolChanged = Array.isArray(secret.apiTokens)
          && JSON.stringify(secret.apiTokens.map((token) => String(token || '').trim()).filter(Boolean)) !== JSON.stringify(normalizedTokenPool);
        const changed = poolChanged
          || secret.apiToken !== authorizationToken
          || !hasScheduledTokenCursor(secret.apiTokenCursor)
          || Number(secret.apiTokenCursor) !== index;

        return {
          rawBalance,
          metadata: {
            authSource: 'api_key',
            credentialScope: 'api_key',
            balanceScope,
            mode: result.body.mode,
            isValid: result.body.isValid,
            status: result.body.status,
            remaining: rawBalance,
            unit: String(result.body.unit || result.body.quota?.unit || 'USD').toUpperCase(),
            balance: result.body.balance,
            quota: result.body.quota,
            planName: result.body.planName,
            subscription: result.body.subscription,
            profilePath: usagePath,
            balancePath,
            apiTokenPoolSize: tokenPool.length,
            apiTokenSlot: index + 1,
            tokenStrategy: account.tokenStrategy || 'sticky',
            tokenFailovers: errors.length,
            tokenPrefixMode: authorizationToken === tokenPool[index] ? 'as_entered' : 'sk_compat',
            ...rateMetadata,
          },
          ...(changed ? { updatedSecret: nextSecret } : {}),
        };
      } catch (error) {
        if (isCloudflareChallenge(error)) throw error;
        if (error.code === 'UNMONITORABLE_BALANCE') {
          slotError = error;
          unmonitorableSlots += 1;
          break;
        }
        if (!isSub2ApiKeyAuthFailure(error)) throw error;
        slotError = error;
        const enteredWithoutPrefix = authorizationToken === tokenPool[index] && !tokenPool[index].startsWith('sk-');
        if (!enteredWithoutPrefix) break;
      }
    }
    errors.push(`槽位 ${index + 1}：${slotError?.message || '鉴权失败'}`);
  }

  const error = new Error(`${unmonitorableSlots ? 'Sub2API API Key 池没有可监控的有限余额' : 'Sub2API API Key 全部不可用'}（${errors.join('；')}）`);
  error.code = unmonitorableSlots ? 'UNMONITORABLE_BALANCE' : 'UPSTREAM_AUTH_FAILED';
  if (!unmonitorableSlots) error.status = 401;
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
        const cursorUpdate = poolChanged
          || secret.accessToken !== tokenPool[index]
          || !hasScheduledTokenCursor(secret.tokenCursor)
          || Number(secret.tokenCursor) !== index
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
      ...upstreamBrowserSessionHeaders(secret),
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
      ...upstreamBrowserSessionHeaders(secret),
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
          sessionCookie: solved.cookies || '',
          sessionUserAgent: solved.userAgent || '',
          sessionCapturedAt: new Date().toISOString(),
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
  if (account.authMode === 'api_token') return collectSub2ApiTokenUsage(root, account, secret);
  let accessToken = secret.accessToken || '';
  let refreshToken = secret.refreshToken || '';
  let updatedSecret;
  let authSource = accessToken ? 'access_token' : refreshToken ? 'refresh_token' : 'password';
  let refreshReason = '';
  let refreshTokenRotated = false;
  let refreshAttempted = false;
  const errors = [];
  const accessHeaders = {
    ...cloudflareAccessHeaders(secret),
    ...upstreamBrowserSessionHeaders(secret),
  };

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
      ...(tokens.sessionCookie ? { sessionCookie: tokens.sessionCookie } : {}),
      ...(tokens.sessionUserAgent ? { sessionUserAgent: tokens.sessionUserAgent } : {}),
      ...(tokens.sessionCapturedAt ? { sessionCapturedAt: tokens.sessionCapturedAt } : {}),
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

  async function tryProfiles(token = '') {
    let lastError;
    for (const path of paths) {
      try {
        const result = await requestJson(`${root}${path}`, {
          headers: {
            ...accessHeaders,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

  // Interactive browser login fallback: some customized deployments keep the
  // authenticated panel session in cookies instead of exposing an AT.
  if (!accessToken && secret.sessionCookie) {
    try {
      authSource = 'browser_cookie';
      return { ...(await tryProfiles()), updatedSecret };
    } catch (error) {
      errors.push(`浏览器 CK：${error.message}`);
      if (!refreshToken && !secret.password) throw checkpoint(error);
    }
  }

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

  if (!accessToken && !refreshToken && !secret.sessionCookie) {
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

export function maskApiTokenReference(token) {
  const value = String(token || '').trim().replace(/^Bearer\s+/i, '');
  if (!value) return '';
  const prefix = value.startsWith('sk-') ? 'sk-' : '';
  const payload = prefix ? value.slice(prefix.length) : value;
  if (payload.length <= 4) return `${prefix}${'*'.repeat(payload.length)}`;
  return `${prefix}********${payload.slice(-4)}`;
}

function apiKeyProbeFailure(error) {
  if (isCloudflareChallenge(error)) {
    return {
      status: 'challenge',
      errorCode: 'TURNSTILE_REQUIRED',
      message: '上游触发了 Cloudflare/Turnstile 验证',
    };
  }
  if (error?.code === 'UNLIMITED_QUOTA') {
    return {
      status: 'unlimited',
      errorCode: 'UNLIMITED_QUOTA',
      message: '该 Key 为无限额度，接口没有可显示的有限余额',
    };
  }
  if (error?.code === 'UNMONITORABLE_BALANCE') {
    return {
      status: 'unmonitorable',
      errorCode: 'UNMONITORABLE_BALANCE',
      message: '该 Key 没有可监控的有限余额',
    };
  }
  if (isAuthFailure(error) || isSub2ApiKeyAuthFailure(error)) {
    return {
      status: 'unavailable',
      errorCode: 'UPSTREAM_AUTH_FAILED',
      message: 'Key 鉴权失败或已经失效',
    };
  }
  return {
    status: 'error',
    errorCode: String(error?.code || 'UPSTREAM_REQUEST_FAILED'),
    message: '上游暂时没有返回该 Key 的用量信息',
  };
}

function finiteDetailNumber(value) {
  return nonnegativeFiniteNumber(value) ?? null;
}

export function redactCredentialText(value, tokens = []) {
  let output = String(value || '');
  for (const token of tokens) {
    const raw = String(token || '').trim().replace(/^Bearer\s+/i, '');
    const candidates = [...new Set([raw, raw && !raw.startsWith('sk-') ? `sk-${raw}` : ''].filter(Boolean))];
    for (const candidate of candidates) {
      if (output === candidate) output = '[redacted]';
      else if (candidate.length >= 8) output = output.split(candidate).join('[redacted]');
    }
  }
  return output;
}

function apiKeyProbeSuccess(slot, token, result, rawUnit = '') {
  const metadata = result.metadata || {};
  const quota = metadata.quota && typeof metadata.quota === 'object' ? metadata.quota : {};
  const subscription = metadata.subscription && typeof metadata.subscription === 'object' ? metadata.subscription : {};
  const expiresAt = metadata.expiresAt || subscription.expiresAt || subscription.expires_at || null;
  const maskedToken = maskApiTokenReference(token);
  return {
    slot,
    label: `Key ${slot} · ${maskedToken}`,
    maskedToken,
    status: 'available',
    ok: true,
    errorCode: '',
    message: '',
    rawBalance: Number(result.rawBalance),
    unit: redactCredentialText(metadata.unit || rawUnit, [token]),
    balanceScope: String(metadata.balanceScope || 'api_key'),
    totalGranted: finiteDetailNumber(metadata.totalGranted),
    totalUsed: finiteDetailNumber(metadata.totalUsed),
    used: finiteDetailNumber(metadata.totalUsed ?? quota.used ?? subscription.used),
    remaining: finiteDetailNumber(metadata.remaining ?? result.rawBalance),
    quotaLimit: finiteDetailNumber(quota.limit ?? quota.total ?? subscription.limit),
    quotaUsed: finiteDetailNumber(quota.used ?? subscription.used),
    rateMultiplier: finiteDetailNumber(metadata.rateMultiplier),
    rateMultiplierStatus: String(metadata.rateMultiplierStatus || 'unavailable'),
    rateMultiplierSource: String(metadata.rateMultiplierSource || ''),
    tokenGroup: redactCredentialText(metadata.tokenGroup, [token]),
    groupRateMultiplier: finiteDetailNumber(metadata.groupRateMultiplier),
    userRateMultiplier: finiteDetailNumber(metadata.userRateMultiplier),
    resolvedRateMultiplier: finiteDetailNumber(metadata.resolvedRateMultiplier),
    peakRateEnabled: metadata.peakRateEnabled === true,
    peakRateMultiplier: finiteDetailNumber(metadata.peakRateMultiplier),
    appliedPeakMultiplier: finiteDetailNumber(metadata.appliedPeakMultiplier),
    tokenName: redactCredentialText(metadata.tokenName, [token]),
    planName: redactCredentialText(metadata.planName || subscription.planName || subscription.name, [token]),
    expiresAt: typeof expiresAt === 'string' ? redactCredentialText(expiresAt, [token]) : expiresAt,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, concurrency)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function newApiInventoryTokenStatus(item = {}) {
  const enabled = [1, '1', 'enabled', 'active'].includes(item.status);
  const unlimited = item.unlimited_quota === true;
  const remaining = nonnegativeFiniteNumber(item.remain_quota);
  const expiresAt = Number(item.expired_time);
  const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Math.floor(Date.now() / 1000);
  if (expired) return { status: 'unavailable', ok: false, message: 'Key 已过期' };
  if (!enabled) return { status: 'unavailable', ok: false, message: 'Key 已停用' };
  if (!unlimited && remaining === 0) return { status: 'unavailable', ok: false, message: 'Key 额度已用完' };
  if (unlimited) return { status: 'unlimited', ok: true, message: '无限额度 Key' };
  return { status: 'available', ok: true, message: '' };
}

function newApiInventoryRate(groups, group, groupRequestStatus = 'unavailable') {
  const tokenGroup = String(group || 'default');
  if (tokenGroup === 'auto') {
    return {
      tokenGroup,
      rateMultiplier: null,
      rateMultiplierStatus: 'dynamic',
      rateMultiplierSource: 'newapi_user_groups',
    };
  }
  const groupInfo = groups?.[tokenGroup];
  const rateMultiplier = nonnegativeFiniteNumber(groupInfo?.ratio ?? groupInfo);
  return {
    tokenGroup,
    rateMultiplier: rateMultiplier ?? null,
    rateMultiplierStatus: rateMultiplier === undefined ? groupRequestStatus : 'available',
    rateMultiplierSource: 'newapi_user_groups',
  };
}

function newApiInventoryItem(item, index, groups, groupRequestStatus) {
  const maskedToken = maskApiTokenReference(
    String(item?.key || '').startsWith('sk-') ? item.key : `sk-${item?.key || ''}`,
  );
  const remaining = item?.unlimited_quota === true ? null : finiteDetailNumber(item?.remain_quota);
  const used = finiteDetailNumber(item?.used_quota);
  const expiry = Number(item?.expired_time);
  const status = newApiInventoryTokenStatus(item);
  return {
    slot: index + 1,
    label: `${String(item?.name || `Key ${index + 1}`)} · ${maskedToken}`,
    maskedToken,
    ...status,
    errorCode: status.ok ? '' : 'UPSTREAM_KEY_UNAVAILABLE',
    rawBalance: remaining,
    unit: 'quota',
    balanceScope: 'api_key',
    totalGranted: remaining === null ? null : (remaining || 0) + (used || 0),
    totalUsed: used,
    used,
    remaining,
    quotaLimit: null,
    quotaUsed: used,
    ...newApiInventoryRate(groups, item?.group, groupRequestStatus),
    tokenName: String(item?.name || ''),
    planName: '',
    expiresAt: Number.isFinite(expiry) && expiry > 0 ? new Date(expiry * 1000).toISOString() : null,
  };
}

async function collectNewApiAccountKeyDetails(account, secret, inspectedAt) {
  const accountSummary = {
    id: String(account?.id || ''),
    name: String(account?.name || ''),
    type: 'newapi',
    authMode: 'access_token',
  };
  const tokenPool = normalizeTokenPool(secret);
  if (!tokenPool.length || !account.userId) {
    return {
      account: accountSummary,
      supported: false,
      mode: 'access_token',
      inspectedAt,
      keyCount: 0,
      keys: [],
      summary: { available: 0, unavailable: 0 },
      message: '需要账户访问令牌与 User ID 才能读取分 Key 用量',
    };
  }

  const root = baseUrl(account.baseUrl);
  const errors = [];
  const indexes = scheduledTokenIndexes(tokenPool.length, account.tokenStrategy, secret.tokenCursor);
  for (const index of indexes) {
    const rawToken = String(tokenPool[index]).replace(/^Bearer\s+/i, '');
    const authorizationCandidates = [...new Set([`Bearer ${rawToken}`, rawToken])];
    for (const authorization of authorizationCandidates) {
      const headers = {
        Accept: 'application/json',
        Authorization: authorization,
        'New-Api-User': String(account.userId),
        ...cloudflareAccessHeaders(secret),
      };
      try {
        const tokenResult = await requestJson(`${root}/api/token/?p=0&page_size=100&size=100`, { headers });
        assertSuccess(tokenResult.response, tokenResult.body);
        const items = newApiTokenList(tokenResult.body).filter((item) => item && typeof item === 'object').slice(0, 100);

        let groups = {};
        let groupRequestStatus = 'unavailable';
        try {
          const groupsResult = await requestJson(`${root}/api/user/self/groups`, { headers });
          assertSuccess(groupsResult.response, groupsResult.body);
          groups = readPath(groupsResult.body, 'data') || {};
          groupRequestStatus = 'unavailable';
        } catch (error) {
          groupRequestStatus = isCloudflareChallenge(error) ? 'challenge' : 'unavailable';
        }

        const keys = items.map((item, itemIndex) => newApiInventoryItem(item, itemIndex, groups, groupRequestStatus));
        const available = keys.filter((key) => key.ok).length;
        const total = nonnegativeFiniteNumber(
          readPath(tokenResult.body, 'data.total')
          ?? readPath(tokenResult.body, 'total'),
        );
        return {
          account: accountSummary,
          supported: true,
          mode: 'access_token',
          inspectedAt,
          keyCount: keys.length,
          keys,
          summary: { available, unavailable: keys.length - available },
          message: total !== undefined && total > keys.length ? `当前展示前 ${keys.length} 个 Key` : '',
        };
      } catch (error) {
        if (isCloudflareChallenge(error)) throw error;
        if (!isAuthFailure(error)) throw error;
        errors.push(`账户令牌槽位 ${index + 1} 鉴权失败`);
      }
    }
  }
  const error = new Error(errors.length ? errors.join('；') : '账户访问令牌不可用');
  error.code = 'UPSTREAM_AUTH_FAILED';
  error.status = 401;
  throw error;
}

function sub2PanelData(body = {}) {
  return body && typeof body === 'object' && Object.hasOwn(body, 'data') ? body.data : body;
}

function sub2PanelGroups(body = {}) {
  const data = sub2PanelData(body);
  return Array.isArray(data) ? data.filter((item) => item && typeof item === 'object') : [];
}

function sub2PanelRates(body = {}) {
  const data = sub2PanelData(body);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

async function collectSub2ApiKeyList(root, headers) {
  // Sub2API 0.2.x renamed /keys to /api-keys. Keep the legacy path first so
  // older deployments and existing compatible forks do not pay an extra 404.
  let lastResult;
  for (const path of ['/api/v1/keys?page=1&page_size=1000', '/api/v1/api-keys?page=1&page_size=1000']) {
    const result = await requestJson(`${root}${path}`, { headers });
    lastResult = result;
    if (result.response.ok) {
      assertSuccess(result.response, result.body);
      return result;
    }
    if (![404, 405].includes(result.response.status)) {
      assertSuccess(result.response, result.body);
    }
  }
  assertSuccess(lastResult.response, lastResult.body);
  return lastResult;
}

function minutesInTimezone(timezone, current = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(current);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}

function parseClockMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function sub2GroupRate(group = {}, userRates = {}, timezone = 'UTC', current = new Date()) {
  const groupId = String(group.id ?? '');
  const groupRateMultiplier = nonnegativeFiniteNumber(group.rate_multiplier);
  const userRateMultiplier = Object.hasOwn(userRates, groupId)
    ? nonnegativeFiniteNumber(userRates[groupId])
    : undefined;
  const resolvedRateMultiplier = userRateMultiplier ?? groupRateMultiplier;
  const peakStart = parseClockMinutes(group.peak_start);
  const peakEnd = parseClockMinutes(group.peak_end);
  const currentMinute = minutesInTimezone(timezone, current);
  const peakConfigured = group.subscription_type === 'subscription'
    && group.peak_rate_enabled === true
    && peakStart !== null
    && peakEnd !== null
    && peakStart < peakEnd;
  const peakActive = peakConfigured && currentMinute !== null && currentMinute >= peakStart && currentMinute < peakEnd;
  const configuredPeakMultiplier = nonnegativeFiniteNumber(group.peak_rate_multiplier);
  const appliedPeakMultiplier = peakActive ? (configuredPeakMultiplier ?? 1) : 1;
  const effectiveRateMultiplier = resolvedRateMultiplier === undefined
    ? undefined
    : resolvedRateMultiplier * appliedPeakMultiplier;
  return {
    id: group.id,
    name: String(group.name || `分组 ${groupId}`),
    platform: String(group.platform || ''),
    status: String(group.status || ''),
    subscriptionType: String(group.subscription_type || 'standard'),
    groupRateMultiplier: groupRateMultiplier ?? null,
    userRateMultiplier: userRateMultiplier ?? null,
    resolvedRateMultiplier: resolvedRateMultiplier ?? null,
    peakRateEnabled: group.peak_rate_enabled === true,
    peakStart: String(group.peak_start || ''),
    peakEnd: String(group.peak_end || ''),
    peakRateMultiplier: configuredPeakMultiplier ?? null,
    peakActive,
    appliedPeakMultiplier,
    effectiveRateMultiplier: effectiveRateMultiplier ?? null,
    rateMultiplier: effectiveRateMultiplier ?? null,
    rateMultiplierStatus: effectiveRateMultiplier === undefined ? 'unavailable' : 'available',
  };
}

function sub2AccountKeyStatus(item, remaining, unlimited) {
  const enabled = String(item?.status || '').toLowerCase() === 'active';
  const expiresAt = item?.expires_at ? Date.parse(item.expires_at) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    return { status: 'unavailable', ok: false, message: 'Key 已过期' };
  }
  if (!enabled) return { status: 'unavailable', ok: false, message: 'Key 已停用' };
  if (!unlimited && remaining === 0) return { status: 'unavailable', ok: false, message: 'Key 额度已用完' };
  if (unlimited) return { status: 'unlimited', ok: true, message: '无限额度 Key' };
  return { status: 'available', ok: true, message: '' };
}

function sub2UsageStats(body = {}) {
  const data = sub2PanelData(body);
  const rawStats = data?.stats;
  const entries = Array.isArray(rawStats)
    ? rawStats.map((item) => [item?.api_key_id, item])
    : Object.entries(rawStats && typeof rawStats === 'object' ? rawStats : {});
  const stats = new Map();
  for (const [rawId, item] of entries) {
    if (!item || typeof item !== 'object') continue;
    const id = Number(item.api_key_id ?? rawId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    stats.set(String(id), {
      apiKeyId: id,
      todayActualCost: finiteDetailNumber(item.today_actual_cost),
      totalActualCost: finiteDetailNumber(item.total_actual_cost),
    });
  }
  return stats;
}

async function collectSub2ApiKeyUsageStats(root, headers, items) {
  const ids = [...new Set(items
    .map((item) => Number(item?.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return new Map();

  const batches = [];
  for (let index = 0; index < ids.length; index += 100) batches.push(ids.slice(index, index + 100));
  const results = await Promise.all(batches.map(async (apiKeyIds) => {
    const result = await requestJson(`${root}/api/v1/usage/dashboard/api-keys-usage`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key_ids: apiKeyIds }),
    });
    assertSuccess(result.response, result.body);
    return sub2UsageStats(result.body);
  }));

  const merged = new Map();
  for (const result of results) {
    for (const [id, stats] of result) merged.set(id, stats);
  }
  return merged;
}

function sub2AccountKeyItem(item, index, groupRatesById, usageStats, usageStatsStatus) {
  const maskedToken = maskApiTokenReference(item?.key || '');
  const quotaLimit = nonnegativeFiniteNumber(item?.quota) ?? 0;
  const quotaUsed = nonnegativeFiniteNumber(item?.quota_used) ?? 0;
  const unlimited = quotaLimit === 0;
  const remaining = unlimited ? null : Math.max(0, quotaLimit - quotaUsed);
  const groupRate = groupRatesById.get(String(item?.group_id ?? ''));
  const status = sub2AccountKeyStatus(item, remaining, unlimited);
  const actualUsage = usageStats.get(String(item?.id ?? ''));
  const totalActualCost = actualUsage?.totalActualCost ?? null;
  const todayActualCost = actualUsage?.todayActualCost ?? null;
  const hasOfficialUsage = totalActualCost !== null || todayActualCost !== null;
  const totalUsed = totalActualCost ?? quotaUsed;
  return {
    slot: index + 1,
    label: `${String(item?.name || `Key ${index + 1}`)} · ${maskedToken}`,
    maskedToken,
    ...status,
    errorCode: status.ok ? '' : 'UPSTREAM_KEY_UNAVAILABLE',
    rawBalance: remaining,
    unit: 'USD',
    balanceScope: 'api_key',
    totalGranted: unlimited ? null : quotaLimit,
    totalUsed,
    used: totalUsed,
    remaining,
    quotaLimit: unlimited ? null : quotaLimit,
    quotaUsed,
    unlimitedQuota: unlimited,
    todayActualCost,
    totalActualCost,
    usageStatsStatus: hasOfficialUsage
      ? 'available'
      : usageStatsStatus === 'available' ? 'unavailable' : usageStatsStatus,
    usageSource: hasOfficialUsage ? 'sub2api_usage_stats' : 'sub2api_key_quota',
    tokenName: String(item?.name || ''),
    groupId: item?.group_id ?? null,
    tokenGroup: groupRate?.name || (item?.group_id == null ? '未绑定' : `分组 ${item.group_id}`),
    expiresAt: item?.expires_at || null,
    currentConcurrency: finiteDetailNumber(item?.current_concurrency),
    rateLimit5h: finiteDetailNumber(item?.rate_limit_5h),
    rateLimit1d: finiteDetailNumber(item?.rate_limit_1d),
    rateLimit7d: finiteDetailNumber(item?.rate_limit_7d),
    usage5h: finiteDetailNumber(item?.usage_5h),
    usage1d: finiteDetailNumber(item?.usage_1d),
    usage7d: finiteDetailNumber(item?.usage_7d),
    rateMultiplier: groupRate?.effectiveRateMultiplier ?? null,
    rateMultiplierStatus: groupRate?.rateMultiplierStatus || 'unavailable',
    groupRateMultiplier: groupRate?.groupRateMultiplier ?? null,
    userRateMultiplier: groupRate?.userRateMultiplier ?? null,
    resolvedRateMultiplier: groupRate?.resolvedRateMultiplier ?? null,
    peakRateEnabled: groupRate?.peakRateEnabled || false,
    peakRateMultiplier: groupRate?.peakRateMultiplier ?? null,
    appliedPeakMultiplier: groupRate?.appliedPeakMultiplier ?? 1,
    peakActive: groupRate?.peakActive || false,
  };
}

async function collectSub2ApiAccountKeyDetails(account, secret, inspectedAt) {
  const accountSummary = {
    id: String(account?.id || ''),
    name: String(account?.name || ''),
    type: 'sub2api',
    authMode: String(account?.authMode || 'access_token'),
  };
  const balanceResult = await collectSub2Api(account, secret);
  const effectiveSecret = balanceResult.updatedSecret || secret;
  const accessToken = String(effectiveSecret.accessToken || secret.accessToken || '').trim();
  if (!accessToken && !effectiveSecret.sessionCookie) {
    return {
      account: accountSummary,
      supported: false,
      mode: accountSummary.authMode,
      inspectedAt,
      keyCount: 0,
      groupCount: 0,
      keys: [],
      groups: [],
      summary: { available: 0, unavailable: 0 },
      message: '登录态尚未取得 Access Token',
      ...(balanceResult.updatedSecret ? { updatedSecret: balanceResult.updatedSecret } : {}),
    };
  }

  const root = baseUrl(account.baseUrl);
  const headers = {
    Accept: 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken.replace(/^Bearer\s+/i, '')}` } : {}),
    ...cloudflareAccessHeaders(effectiveSecret),
    ...upstreamBrowserSessionHeaders(effectiveSecret),
  };
  const [keysResult, groupsResult, ratesResult, settingsResult] = await Promise.all([
    collectSub2ApiKeyList(root, headers),
    requestJson(`${root}/api/v1/groups/available`, { headers }).catch((error) => ({ error })),
    requestJson(`${root}/api/v1/groups/rates`, { headers }).catch((error) => ({ error })),
    requestJson(`${root}/api/v1/settings/public`, { headers: { Accept: 'application/json' } }).catch((error) => ({ error })),
  ]);
  assertSuccess(keysResult.response, keysResult.body);

  let groups = [];
  let userRates = {};
  let groupRateStatus = 'available';
  if (groupsResult.error) groupRateStatus = isCloudflareChallenge(groupsResult.error) ? 'challenge' : 'unavailable';
  else {
    try {
      assertSuccess(groupsResult.response, groupsResult.body);
      groups = sub2PanelGroups(groupsResult.body);
    } catch (error) {
      groupRateStatus = isCloudflareChallenge(error) ? 'challenge' : 'unavailable';
    }
  }
  if (ratesResult.error) groupRateStatus = isCloudflareChallenge(ratesResult.error) ? 'challenge' : 'unavailable';
  else {
    try {
      assertSuccess(ratesResult.response, ratesResult.body);
      userRates = sub2PanelRates(ratesResult.body);
    } catch (error) {
      groupRateStatus = isCloudflareChallenge(error) ? 'challenge' : 'unavailable';
    }
  }
  let settings = {};
  if (!settingsResult.error) {
    try {
      assertSuccess(settingsResult.response, settingsResult.body);
      settings = sub2PanelData(settingsResult.body);
    } catch {
      settings = {};
    }
  }
  const timezone = String(settings?.server_timezone || settings?.timezone || 'UTC');
  const groupRates = groups.map((group) => sub2GroupRate(group, userRates, timezone));
  const groupRatesById = new Map(groupRates.map((group) => [String(group.id), group]));
  const keyData = sub2PanelData(keysResult.body);
  const items = Array.isArray(keyData?.items) ? keyData.items.filter((item) => item && typeof item === 'object') : [];
  let usageStats = new Map();
  let usageStatsStatus = 'available';
  try {
    usageStats = await collectSub2ApiKeyUsageStats(root, headers, items);
  } catch (error) {
    usageStatsStatus = isCloudflareChallenge(error) ? 'challenge' : 'unavailable';
  }
  const keys = items.map((item, index) => sub2AccountKeyItem(
    item,
    index,
    groupRatesById,
    usageStats,
    usageStatsStatus,
  ));
  if (usageStatsStatus === 'available' && keys.some((key) => key.usageStatsStatus !== 'available')) {
    usageStatsStatus = usageStats.size ? 'partial' : 'unavailable';
  }
  const available = keys.filter((key) => key.ok).length;
  const total = nonnegativeFiniteNumber(keyData?.total);
  return {
    account: accountSummary,
    supported: true,
    mode: 'account_session',
    inspectedAt,
    keyCount: keys.length,
    groupCount: groupRates.length,
    keys,
    groups: groupRates,
    groupRateStatus,
    usageStatsStatus,
    serverTimezone: timezone,
    summary: { available, unavailable: keys.length - available },
    message: total !== undefined && total > keys.length ? `当前展示前 ${keys.length} 个 Key` : '',
    ...(balanceResult.updatedSecret ? { updatedSecret: balanceResult.updatedSecret } : {}),
  };
}

/**
 * Inspect every configured API key without returning any credential material.
 * The regular collector is reused with an isolated one-key pool so scheduling
 * and failover never hide an unhealthy slot behind a healthy one.
 */
export async function collectApiKeyDetails(account, secret = {}, options = {}) {
  const inspectedAt = new Date().toISOString();
  const accountSummary = {
    id: String(account?.id || ''),
    name: String(account?.name || ''),
    type: String(account?.type || ''),
    authMode: String(account?.authMode || ''),
  };
  if (account?.type === 'newapi' && account?.authMode === 'access_token') {
    return withUpstreamProxyContext(account, () => collectNewApiAccountKeyDetails(account, secret, inspectedAt));
  }
  if (account?.type === 'sub2api' && account?.authMode !== 'api_token') {
    return withUpstreamProxyContext(account, () => collectSub2ApiAccountKeyDetails(account, secret, inspectedAt));
  }
  if (account?.authMode !== 'api_token') {
    return {
      account: accountSummary,
      supported: false,
      mode: account?.authMode || 'access_token',
      inspectedAt,
      keyCount: 0,
      keys: [],
      summary: { available: 0, unavailable: 0 },
      message: '该账号使用账户访问令牌，不包含可拆分查看的 API Key',
    };
  }
  const tokens = normalizeApiTokenPool(secret);
  const safeAccountSummary = {
    ...accountSummary,
    name: redactCredentialText(accountSummary.name, tokens),
  };
  if (!['newapi', 'sub2api'].includes(account?.type)) {
    return {
      account: safeAccountSummary,
      supported: false,
      mode: 'api_token',
      inspectedAt,
      keyCount: 0,
      keys: [],
      summary: { available: 0, unavailable: 0 },
      message: '当前上游类型不支持分 Key 用量查询',
    };
  }

  if (!tokens.length) {
    return {
      account: accountSummary,
      supported: true,
      mode: 'api_token',
      inspectedAt,
      keyCount: 0,
      keys: [],
      summary: { available: 0, unavailable: 0 },
      message: '该账号尚未保存 API Key',
    };
  }

  const root = baseUrl(account.baseUrl);
  const concurrency = Math.min(3, Math.max(1, Number(options.concurrency || 3)));
  const keys = await withUpstreamProxyContext(account, () => mapWithConcurrency(
    tokens,
    concurrency,
    async (token, index) => {
      const isolatedSecret = {
        ...secret,
        apiToken: token,
        apiTokens: [token],
        apiTokenCursor: 0,
      };
      delete isolatedSecret.turnstileToken;
      try {
        const isolatedAccount = { ...account, tokenStrategy: 'sticky' };
        const result = account.type === 'newapi'
          ? await collectNewApiTokenUsage(root, isolatedAccount, isolatedSecret)
          : await collectSub2ApiTokenUsage(root, isolatedAccount, isolatedSecret);
        return apiKeyProbeSuccess(index + 1, token, result, account.rawUnit);
      } catch (error) {
        const maskedToken = maskApiTokenReference(token);
        return {
          slot: index + 1,
          label: `Key ${index + 1} · ${maskedToken}`,
          maskedToken,
          ...apiKeyProbeFailure(error),
          ok: false,
          rawBalance: null,
          unit: '',
          rateMultiplier: null,
          rateMultiplierStatus: 'unavailable',
        };
      }
    },
  ));
  const available = keys.filter((key) => key.status === 'available').length;
  return {
    account: safeAccountSummary,
    supported: true,
    mode: 'api_token',
    inspectedAt,
    keyCount: keys.length,
    keys,
    summary: { available, unavailable: keys.length - available },
    message: '',
  };
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
