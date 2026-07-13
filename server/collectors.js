import { config } from './config.js';
import {
  getTurnstileSolverStatus,
  isTurnstileFailure,
  obtainTurnstileToken,
} from './turnstile.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('站点地址仅支持 HTTP 或 HTTPS');
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

export function readPath(source, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => value?.[key], source);
}

/** Detect Cloudflare / Turnstile challenges from errors or API bodies */
export function isCloudflareChallenge(errorOrBody, reason = '') {
  if (errorOrBody && typeof errorOrBody === 'object' && !(errorOrBody instanceof Error)) {
    if (isTurnstileFailure(errorOrBody, reason)) return true;
  }
  const message = String(errorOrBody?.message || errorOrBody || reason || '');
  return /turnstile|captcha|人机|cloudflare|cf.?challenge|challenge.?platform|just a moment|cf-browser-verification|挑战页|自动过盾|TURNSTILE/i.test(message);
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      if (/turnstile|cf-browser-verification|just a moment|challenge-platform|cf-challenge|cdn-cgi\/challenge/i.test(text)) {
        const err = new Error(
          `上游返回了 Cloudflare 挑战页而非 JSON (${response.status})`,
        );
        err.code = 'CF_CHALLENGE_PAGE';
        throw err;
      }
      throw new Error(`上游返回了非 JSON 数据 (${response.status})`);
    }
    return { response, body };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接上游超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertSuccess(response, body) {
  if (!response.ok || body?.success === false) {
    const message = body?.message || body?.reason || body?.error || `上游请求失败 (${response.status})`;
    const err = new Error(message);
    if (isTurnstileFailure(body, message)) err.code = 'TURNSTILE';
    throw err;
  }
}

function numericBalance(body, balancePath) {
  const value = Number(readPath(body, balancePath));
  if (!Number.isFinite(value)) throw new Error(`余额字段 ${balancePath} 不是有效数字`);
  return value;
}

function isAuthFailure(error) {
  const message = String(error?.message || error || '');
  return /401|403|unauthorized|token|登录|过期|expired|invalid|鉴权|认证|forbidden/i.test(message);
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

function extractTokens(payload = {}) {
  const candidates = [payload, payload?.data, payload?.tokens, payload?.data?.tokens, payload?.result]
    .filter((item) => item && typeof item === 'object');
  const accessToken = candidates.map((item) => item.access_token || item.accessToken || item.token || '').find(Boolean) || '';
  const refreshToken = candidates.map((item) => item.refresh_token || item.refreshToken || '').find(Boolean) || '';
  const expiresIn = Number(candidates.map((item) => item.expires_in || item.expiresIn || 0).find(Boolean) || 0);
  return {
    accessToken: accessToken ? String(accessToken) : '',
    refreshToken: refreshToken ? String(refreshToken) : '',
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0,
  };
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
async function solveCloudflareChallenge({ root, account, secret }) {
  const solver = getTurnstileSolverStatus(config);
  if (!solver.enabled) {
    throw new Error(turnstileManualHint());
  }

  const solved = await obtainTurnstileToken({
    rootUrl: root,
    siteKey: account.turnstileSiteKey || '',
    provider: config.turnstileSolver,
    apiKey: config.turnstileSolverApiKey,
    timeoutMs: config.turnstileSolveTimeoutMs,
    email: account.username || '',
    password: secret.password || '',
    headless: config.turnstileHeadless,
  });

  return {
    token: solved.token || '',
    accessToken: solved.accessToken || '',
    refreshToken: solved.refreshToken || '',
    cookies: solved.cookies || '',
    method: solved.method || config.turnstileSolver,
  };
}

async function fetchNewApiProfile(root, account, headers, source) {
  let lastError;
  for (const delay of [0, 800, 1800, 3200]) {
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

async function loginNewApiPassword(root, account, secret, turnstileToken = '') {
  const body = {
    username: account.username,
    password: secret.password,
  };
  if (turnstileToken) {
    body.turnstile_token = turnstileToken;
    body.cf_turnstile_response = turnstileToken;
    body['cf-turnstile-response'] = turnstileToken;
  }

  const login = await requestJson(`${root}/api/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const reason = login.body?.reason || login.body?.error || login.body?.message || '';
  if (isTurnstileFailure(login.body, reason)) {
    const err = new Error(reason || 'TURNSTILE_VERIFICATION_FAILED');
    err.code = 'TURNSTILE';
    err.body = login.body;
    throw err;
  }

  const cookies = login.response.headers.getSetCookie?.() || [];
  if (cookies.length === 0 && !login.response.ok) assertSuccess(login.response, login.body);
  if (!login.response.ok && login.body?.success === false) assertSuccess(login.response, login.body);

  return {
    cookieHeader: cookies.map((cookie) => cookie.split(';')[0]).join('; '),
    body: login.body,
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
          headers: { Accept: 'application/json', Authorization: `Bearer ${authorizationToken}` },
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
        slotError = error;
        if (error.code === 'UNLIMITED_QUOTA') break;
        const enteredWithoutPrefix = authorizationToken === tokenPool[index] && !tokenPool[index].startsWith('sk-');
        if (!enteredWithoutPrefix || !isAuthFailure(error)) break;
      }
    }
    errors.push(`槽位 ${index + 1}：${slotError?.message || '鉴权失败'}`);
  }
  throw new Error(`API 密钥全部不可用（${errors.join('；')}）`);
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
  let updatedSecret;
  const errors = [];

  const viaToken = async (source = 'access_token') => {
    if (!hasToken) throw new Error('未配置用户访问令牌与 User ID');
    const tokenErrors = [];
    const indexes = scheduledTokenIndexes(tokenPool.length, account.tokenStrategy, secret.tokenCursor);
    for (const index of indexes) {
      const headers = {
        Accept: 'application/json',
        Authorization: tokenPool[index],
        'New-Api-User': String(account.userId),
      };
      try {
        const result = await fetchNewApiProfile(root, account, headers, source);
        const nextSecret = {
          ...secret,
          accessToken: tokenPool[index],
          accessTokens: tokenPool,
          tokenCursor: index,
        };
        const poolChanged = Array.isArray(secret.accessTokens)
          && JSON.stringify(secret.accessTokens) !== JSON.stringify(tokenPool);
        updatedSecret = poolChanged || secret.accessToken !== tokenPool[index] || Number(secret.tokenCursor || 0) !== index
          ? nextSecret
          : undefined;
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
        tokenErrors.push(`槽位 ${index + 1}：${error.message}`);
      }
    }
    throw new Error(`令牌池全部不可用（${tokenErrors.join('；')}）`);
  };

  const viaCookie = async (cookieHeader, source = 'password_session') => {
    if (!cookieHeader) throw new Error('登录未返回会话 Cookie');
    const headers = { Accept: 'application/json', Cookie: cookieHeader };
    return fetchNewApiProfile(root, account, headers, source);
  };

  const viaPasswordApi = async (turnstileToken = '') => {
    if (!hasPassword) throw new Error('未配置用户名与密码');
    const login = await loginNewApiPassword(root, account, secret, turnstileToken);
    return viaCookie(login.cookieHeader, turnstileToken ? 'password_with_turnstile' : 'password_session');
  };

  /**
   * CF 出现时：先浏览器过盾；成功则用会话/token；失败再抛出让上层回退令牌
   */
  const viaBrowserOnCf = async () => {
    const solved = await solveCloudflareChallenge({ root, account, secret });

    // Browser completed login with session cookies (typical New API)
    if (solved.cookies) {
      try {
        return await viaCookie(solved.cookies, 'password_with_turnstile_browser');
      } catch (error) {
        errors.push(`浏览器会话拉取资料失败：${error.message}`);
      }
    }

    // Browser returned API access token
    if (solved.accessToken) {
      const nextPool = [solved.accessToken, ...tokenPool.filter((token) => token !== solved.accessToken)].slice(0, 20);
      const next = { ...secret, accessToken: solved.accessToken, accessTokens: nextPool, tokenCursor: 0 };
      if (solved.refreshToken) next.refreshToken = solved.refreshToken;
      updatedSecret = next;
      const headers = {
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
        const result = await viaPasswordApi(solved.token);
        return result;
      } catch (error) {
        errors.push(`Turnstile token 重试登录失败：${error.message}`);
      }
    }

    throw new Error(
      `浏览器过盾未能完成 New API 登录。${errors.join('；') || turnstileManualHint()}`,
    );
  };

  const preferPassword = account.authMode === 'password' || (hasPassword && !hasToken);

  // --- Password-first path ---
  if (preferPassword && hasPassword) {
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
          throw new Error(`New API 遇 CF 盾：浏览器过盾失败后令牌回退也失败。${errors.join(' → ')}`);
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
      throw new Error(errors.join(' → '));
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
        if (hasPassword) {
          try {
            const result = await viaBrowserOnCf();
            return updatedSecret ? { ...result, updatedSecret } : result;
          } catch (browserError) {
            errors.push(`浏览器过盾：${browserError.message}`);
          }
        }
        throw new Error(
          `New API 令牌请求遇到 Cloudflare 防护。${errors.join(' → ')}。${turnstileManualHint()}`,
        );
      }

      // Auth failure with password available → password / CF browser chain
      if (hasPassword && (isAuthFailure(error) || account.authMode === 'password')) {
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

      throw new Error(errors.join(' → '));
    }
  }

  if (hasPassword) {
    // No token at all
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

async function refreshSub2Api(root, refreshToken) {
  const result = await requestJson(`${root}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  };
  if (turnstileToken) body.turnstile_token = turnstileToken;

  return requestJson(`${root}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  let login = await postSub2Login(root, account, secret, secret.turnstileToken || '');
  let reason = login.body?.reason || login.body?.error || login.body?.message || '';

  if (isTurnstileFailure(login.body, reason) || login.body?.code === 'CF_CHALLENGE_PAGE') {
    try {
      const solved = await solveCloudflareChallenge({ root, account, secret });
      usedTurnstile = true;

      if (solved.accessToken) {
        return {
          accessToken: solved.accessToken,
          refreshToken: solved.refreshToken || '',
          _authSource: 'password_with_turnstile_browser',
        };
      }

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
  const errors = [];

  const remember = (tokens, source) => {
    const previousRefreshToken = refreshToken;
    accessToken = tokens.accessToken || accessToken;
    refreshToken = tokens.refreshToken || refreshToken;
    refreshTokenRotated = Boolean(tokens.refreshToken && previousRefreshToken && tokens.refreshToken !== previousRefreshToken);
    authSource = source;
    const next = {
      ...secret,
      accessToken,
      refreshToken,
      accessTokenExpiresAt: tokenTiming(accessToken).expiresAt || (tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : ''),
      refreshTokenExpiresAt: tokenTiming(refreshToken).expiresAt || '',
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

  async function tryProfiles(token) {
    let lastError;
    for (const path of paths) {
      try {
        const result = await requestJson(`${root}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        assertSuccess(result.response, result.body);
        return {
          rawBalance: numericBalance(result.body, account.balancePath || 'data.balance'),
          metadata: {
            authSource,
            profilePath: path,
            status: readPath(result.body, 'data.status'),
            hasAccessToken: Boolean(accessToken),
            hasRefreshToken: Boolean(refreshToken),
            tokenRenewed: Boolean(updatedSecret),
            accessTokenExpiresAt: tokenTiming(accessToken).expiresAt || updatedSecret?.accessTokenExpiresAt || null,
            refreshTokenExpiresAt: tokenTiming(refreshToken).expiresAt || updatedSecret?.refreshTokenExpiresAt || null,
            refreshReason,
            refreshTokenRotated,
          },
        };
      } catch (error) {
        lastError = error;
        if (error.code === 'CF_CHALLENGE_PAGE' || isCloudflareChallenge(error) || isAuthFailure(error)) break;
      }
    }
    throw lastError;
  }

  const accessTiming = tokenTiming(accessToken);
  const refreshTiming = tokenTiming(refreshToken, 0);

  // 1) 没有 AT，或 JWT AT 已到期/即将到期时，优先用 RT 主动续期
  if ((!accessToken || accessTiming.expiringSoon) && refreshToken && !refreshTiming.expired) {
    try {
      refreshReason = !accessToken ? 'missing_access_token' : accessTiming.expired ? 'access_token_expired' : 'access_token_expiring';
      remember(await refreshSub2Api(root, refreshToken), 'refresh_token');
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
              return { ...(await tryProfiles(accessToken)), updatedSecret };
            }
            if (solved.token) {
              const tokens = await loginSub2Api(root, account, { ...secret, turnstileToken: solved.token });
              remember(tokens, tokens._authSource || 'password_with_turnstile');
              return { ...(await tryProfiles(accessToken)), updatedSecret };
            }
          } catch (browserError) {
            errors.push(`浏览器过盾：${browserError.message}`);
            // fall through to RT / password / throw
          }
        }
      } else if (!isAuthFailure(error) && !refreshToken && !secret.password) {
        throw error;
      }
    }
  }

  // 3) AT 失败后用 RT 续期（令牌回退链）
  if (refreshToken && !tokenTiming(refreshToken, 0).expired) {
    try {
      remember(await refreshSub2Api(root, refreshToken), 'refresh_token');
      return { ...(await tryProfiles(accessToken)), updatedSecret };
    } catch (error) {
      errors.push(`RT 续期：${error.message}`);
      if (!secret.password) {
        throw new Error(
          `Access/Refresh Token 均已失效：${error.message}。`
          + (errors.length ? `（${errors.join('；')}）` : '')
          + ' 请重新粘贴 AT/RT，或提供密码以在遇 CF 时自动过盾。',
        );
      }
    }
  }

  // 4) 密码登录：遇 CF 先浏览器过盾；失败则说明已无可用令牌
  if (secret.password && account.username) {
    try {
      const tokens = await loginSub2Api(root, account, secret);
      const source = tokens._authSource || (secret.turnstileToken ? 'password_with_turnstile' : 'password');
      remember(tokens, source);
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
      throw new Error(`${errors.join(' → ')}。${turnstileManualHint()}`);
    }
  }

  if (!accessToken && !refreshToken) {
    throw new Error('Sub2API 需要 Access Token，或 Access+Refresh Token，或可登录的邮箱密码');
  }
  throw new Error(
    errors.length
      ? `Sub2API 鉴权失败：${errors.join(' → ')}`
      : 'Sub2API 鉴权失败：请更新 Access Token / Refresh Token',
  );
}

async function collectGeneric(account, secret) {
  const root = baseUrl(account.baseUrl);
  const headers = { Accept: 'application/json' };
  if (secret.accessToken) headers.Authorization = account.tokenPrefix === 'none' ? secret.accessToken : `Bearer ${secret.accessToken}`;
  const result = await requestJson(`${root}${account.profilePath || '/api/user/self'}`, { headers });
  assertSuccess(result.response, result.body);
  return { rawBalance: numericBalance(result.body, account.balancePath), metadata: { authSource: 'generic' } };
}

export async function collectBalance(account, secret) {
  if (account.type === 'newapi') return collectNewApi(account, secret);
  if (account.type === 'sub2api') return collectSub2Api(account, secret);
  return collectGeneric(account, secret);
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
