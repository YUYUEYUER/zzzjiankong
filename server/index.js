import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from './config.js';
import { JsonStore } from './store.js';
import { Monitor } from './monitor.js';
import { collectApiKeyDetails, collectBalance, mergeSecrets } from './collectors.js';
import { takeCredentialCheckpoint } from './credential-checkpoint.js';
import { evaluateFormula, normalizeFormula } from './converter.js';
import {
  consumeRecoveryCode,
  consumeTwoFactorChallenge,
  createSessionToken,
  createTotpEnrollment,
  createTwoFactorChallenge,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  hashPassword,
  hashRecoveryCode,
  normalizeUsername,
  passwordIssues,
  usernameMatches,
  verifyPassword,
  verifyBootstrapToken,
  verifySessionToken,
  verifyTotpCode,
  verifyTotpCodeResult,
  verifyTurnstileToken,
  verifyTwoFactorChallenge,
} from './security.js';
import { notify } from './notifications.js';
import { getTurnstileSolverStatus } from './turnstile.js';
import { attachBrowserGateway, browserWorkspaceTicketUrl, closeBrowserConnections, issueBrowserTicket } from './browser-gateway.js';
import { aggregateUpstreams } from './upstreams.js';
import { withAccountCredentialLock } from './account-lock.js';
import { getUpstreamProxyContext, ProxyPoolManager } from './proxy-pool.js';
import { parseUpstreamUrl, resolveUpstreamUrl } from './network-policy.js';
import {
  cancelUpstreamLogin,
  consumeUpstreamLogin,
  getUpstreamLogin,
  getUpstreamLoginCredential,
  shutdownUpstreamLogins,
  startUpstreamBrowserSession,
  startUpstreamLogin,
  updateUpstreamLoginCredential,
} from './upstream-login.js';

const app = express();

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

const store = await new JsonStore().init();
if (
  config.production
  && !config.authDisabled
  && !store.snapshot().auth.passwordHash
  && !config.adminPassword
  && config.bootstrapToken.length < 32
) {
  throw new Error('生产环境首次初始化必须配置至少 32 个字符的 BOOTSTRAP_TOKEN');
}
if (!store.snapshot().auth.passwordHash && config.adminPassword) {
  const issues = passwordIssues(config.adminPassword);
  if (issues.length) {
    console.warn(`[security] ADMIN_PASSWORD 未达到新强度要求，将进入首次设置：${issues.join('、')}`);
  } else {
    const timestamp = new Date().toISOString();
    await store.mutate(async (data) => {
      data.auth = {
        ...data.auth,
        username: config.adminUsername,
        usernameCanonical: normalizeUsername(config.adminUsername),
        passwordHash: await hashPassword(config.adminPassword),
        sessionVersion: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }
}
const proxyPool = new ProxyPoolManager(store);
void proxyPool.sync().catch((error) => {
  console.warn(`[proxy] Mihomo 尚未就绪，将自动重试：${error.message}`);
  proxyPool.startSyncRetry();
});
const monitor = new Monitor(store);
monitor.start();

app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
      frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
      connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host') || origin === config.appOrigin) return next();
  } catch {
    // handled below
  }
  return res.status(403).json({ message: '请求来源校验失败' });
});

const accountBaseUrlSchema = z.string().trim().min(1, '请填写上游地址').max(2048).superRefine((value, context) => {
  try {
    parseUpstreamUrl(value, { production: config.production, allowedHosts: config.upstreamAllowedHosts });
  } catch (error) {
    context.addIssue({ code: 'custom', message: error.message });
  }
}).transform((value) => {
  const url = parseUpstreamUrl(value, { production: config.production, allowedHosts: config.upstreamAllowedHosts });
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
});

async function validateUpstreamDestination(value) {
  if (config.enforceUpstreamNetworkPolicy) {
    return resolveUpstreamUrl(value, {
      production: config.production,
      allowedHosts: config.upstreamAllowedHosts,
      allowPrivate: false,
    });
  }
  return { url: parseUpstreamUrl(value, { production: config.production, allowedHosts: config.upstreamAllowedHosts }) };
}

const accountSchema = z.object({
  upstreamId: z.string().trim().min(1, '请选择所属上游').max(80),
  name: z.string().trim().min(1).max(60),
  type: z.enum(['newapi', 'sub2api', 'generic']),
  baseUrl: accountBaseUrlSchema,
  region: z.string().trim().max(40).default('未分组'),
  subgroup: z.string().trim().max(40).optional(),
  authMode: z.enum(['api_token', 'access_token', 'password']).default('access_token'),
  tokenStrategy: z.enum(['sticky', 'round_robin']).default('sticky'),
  username: z.string().trim().max(160).optional().default(''),
  userId: z.string().trim().max(40).optional().default(''),
  profilePath: z.string().trim().max(160).optional().default(''),
  balancePath: z.string().trim().min(1).max(120),
  formula: z.string().trim().max(120).default('x'),
  rawUnit: z.string().trim().max(24).default('unknown'),
  /** Optional Cloudflare Turnstile sitekey; auto-discovered when empty */
  turnstileSiteKey: z.string().trim().max(120).optional().default(''),
  thresholdLow: z.coerce.number().min(0).max(1e12),
  thresholdRecover: z.coerce.number().min(0).max(1e12),
  pollIntervalMinutes: z.coerce.number().int().min(1).max(1440).default(5),
  enabled: z.boolean().default(true),
  notifications: z.object({ resend: z.boolean(), feishu: z.boolean() }).default({ resend: true, feishu: true }),
  browserLoginId: z.string().uuid().optional(),
  credentials: z.object({
    accessToken: z.string().optional(),
    accessTokens: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
    apiToken: z.string().optional(),
    apiTokens: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
    refreshToken: z.string().optional(),
    password: z.string().optional(),
    cfAccessClientId: z.string().trim().max(512).optional(),
    cfAccessClientSecret: z.string().trim().max(4096).optional(),
    /** One-shot token after manual browser verification; also used as fallback when auto-solve is off */
    turnstileToken: z.string().optional(),
  }).optional(),
}).refine((value) => value.thresholdRecover >= value.thresholdLow, {
  message: '恢复阈值不能低于告警阈值',
  path: ['thresholdRecover'],
});

const upstreamNameSchema = z.string().trim().min(1, '请填写上游名称').max(60);

const upstreamSchema = z.object({
  name: upstreamNameSchema,
  proxyMode: z.enum(['direct', 'auto_sticky']).optional(),
});

const upstreamLoginSchema = z.object({
  type: z.literal('sub2api'),
  baseUrl: accountBaseUrlSchema,
  upstreamId: z.string().trim().min(1).max(80),
});

function canonicalUpstreamName(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function findUpstreamByName(data, name) {
  const canonical = canonicalUpstreamName(name);
  return data.upstreams.find((upstream) => canonicalUpstreamName(upstream.name) === canonical);
}

function requireUpstream(upstreamId, data = store.snapshot()) {
  const upstream = data.upstreams.find((item) => item.id === upstreamId);
  if (!upstream) throw Object.assign(new Error('所选上游不存在'), { statusCode: 400 });
  return upstream;
}

function browserProxyServer(upstreamId) {
  requireUpstream(upstreamId);
  return getUpstreamProxyContext(upstreamId)?.browserProxy?.server || '';
}

function requestedUpstreamName(body) {
  if (body?.upstreamName === undefined) return '';
  return upstreamNameSchema.parse(body.upstreamName);
}

function createDirectUpstream(name, timestamp) {
  return {
    id: crypto.randomUUID(),
    name,
    proxyMode: 'direct',
    proxyNodeName: '',
    proxyPort: null,
    proxyAssignedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const proxySubscriptionSchema = z.object({
  url: z.string().trim().url('请填写有效的 Clash 订阅地址').max(4096),
});

const settingsSchema = z.object({
  resendEnabled: z.boolean(),
  resendFrom: z.string().max(200),
  resendTo: z.string().max(500),
  resendApiKey: z.string().optional(),
  feishuEnabled: z.boolean(),
  feishuWebhook: z.string().optional(),
  recoveryConfirmations: z.coerce.number().int().min(1).max(5),
  reminderMinutes: z.coerce.number().int().min(1).max(10080).optional(),
  reminderHours: z.coerce.number().int().min(1).max(168).optional(),
});

const saveSettingsSchema = settingsSchema.refine(
  (input) => input.reminderMinutes !== undefined || input.reminderHours !== undefined,
  { message: '提醒周期不能为空', path: ['reminderMinutes'] },
);

const notificationTestSchema = z.object({
  channel: z.enum(['resend', 'feishu']),
  settings: settingsSchema.partial().optional().default({}),
});

const usernameSchema = z.string().trim().min(3, '用户名至少 3 个字符').max(32, '用户名最多 32 个字符')
  .regex(/^[\p{L}\p{N}_.-]+$/u, '用户名仅支持文字、数字、点、下划线和短横线');
const strongPasswordSchema = z.string().max(128).superRefine((value, context) => {
  const issues = passwordIssues(value);
  if (issues.length) context.addIssue({ code: 'custom', message: `密码强度不足：${issues.join('、')}` });
});
const setupSchema = z.object({
  username: usernameSchema,
  password: strongPasswordSchema,
  bootstrapToken: z.string().max(512).optional().default(''),
  turnstileToken: z.string().optional().default(''),
});
const loginSchema = z.object({ username: z.string().max(64), password: z.string().max(128), turnstileToken: z.string().optional().default('') });
const twoFactorLoginSchema = z.object({ challengeToken: z.string().min(1), code: z.string().min(6).max(32) });
const securityProfileSchema = z.object({
  currentPassword: z.string().max(128),
  username: usernameSchema.optional(),
  newPassword: strongPasswordSchema.optional(),
}).refine((value) => value.username || value.newPassword, { message: '没有需要保存的修改' });
const twoFactorCodeSchema = z.object({ code: z.string().min(6).max(32) });
const disableTwoFactorSchema = z.object({ currentPassword: z.string().max(128), code: z.string().min(6).max(32) });

function sanitizeAccount(account) {
  const { encryptedSecret, ...safe } = account;
  let hasAccessToken = false;
  let hasRefreshToken = false;
  let hasPassword = false;
  let accessTokenCount = 0;
  let hasApiToken = false;
  let apiTokenCount = 0;
  let hasCfAccess = false;
  let hasBrowserSession = false;
  try {
    const secret = decryptSecret(encryptedSecret);
    hasAccessToken = Boolean(secret.accessToken);
    accessTokenCount = Math.max(Number(hasAccessToken), Array.isArray(secret.accessTokens) ? secret.accessTokens.filter(Boolean).length : 0);
    hasAccessToken = accessTokenCount > 0;
    hasRefreshToken = Boolean(secret.refreshToken);
    hasPassword = Boolean(secret.password);
    hasApiToken = Boolean(secret.apiToken);
    apiTokenCount = Math.max(Number(hasApiToken), Array.isArray(secret.apiTokens) ? secret.apiTokens.filter(Boolean).length : 0);
    hasApiToken = apiTokenCount > 0;
    hasCfAccess = Boolean(secret.cfAccessClientId && secret.cfAccessClientSecret);
    hasBrowserSession = Boolean(secret.sessionCookie || secret.browserProfileId);
  } catch {
    // 密钥不匹配时仍返回账号，但不暴露凭据细节
  }
  return {
    ...safe,
    hasCredentials: Boolean(encryptedSecret),
    hasAccessToken,
    hasRefreshToken,
    hasPassword,
    accessTokenCount,
    hasApiToken,
    apiTokenCount,
    hasCfAccess,
    hasBrowserSession,
  };
}

function publicSettings(settings) {
  const { resendApiKeyEncrypted, feishuWebhookEncrypted, ...safe } = settings;
  return {
    ...safe,
    hasResendApiKey: Boolean(resendApiKeyEncrypted),
    hasFeishuWebhook: Boolean(feishuWebhookEncrypted),
    resendConfigured: Boolean(resendApiKeyEncrypted && settings.resendFrom && settings.resendTo),
    feishuConfigured: Boolean(feishuWebhookEncrypted),
  };
}

function dashboardSnapshots(snapshots, accountIds, maxPerAccount = 600) {
  const grouped = new Map();
  for (const snapshot of snapshots) {
    if (!accountIds.has(snapshot.accountId)) continue;
    const list = grouped.get(snapshot.accountId) || [];
    list.push(snapshot);
    grouped.set(snapshot.accountId, list);
  }
  const result = [];
  for (const list of grouped.values()) {
    list.sort((left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime());
    if (list.length <= maxPerAccount) {
      result.push(...list);
      continue;
    }
    const step = (list.length - 1) / (maxPerAccount - 1);
    const selected = new Set([0, list.length - 1]);
    for (let index = 1; index < maxPerAccount - 1; index += 1) selected.add(Math.round(index * step));
    result.push(...[...selected].sort((a, b) => a - b).map((index) => list[index]));
  }
  return result;
}

function dashboard() {
  const data = store.snapshot();
  const accounts = data.accounts.filter((account) => !account.deletedAt).map(sanitizeAccount);
  const deletedAccounts = data.accounts.filter((account) => account.deletedAt).map(sanitizeAccount);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const upstreams = aggregateUpstreams(data.upstreams, accounts, data.incidents);
  const upstreamById = new Map(upstreams.map((upstream) => [upstream.id, upstream]));
  const incidents = data.incidents.filter((incident) => byId.has(incident.accountId)).map((incident) => {
    const account = byId.get(incident.accountId);
    return { ...incident, account, upstream: upstreamById.get(account?.upstreamId) };
  });
  return {
    upstreams,
    accounts,
    deletedAccounts,
    snapshots: dashboardSnapshots(data.snapshots, new Set(byId.keys())),
    incidents,
    audit: data.audit.slice(0, 200),
    settings: publicSettings(data.settings),
    proxyPool: proxyPool.publicState(),
    turnstileSolver: getTurnstileSolverStatus(config),
    browserWorkspaceUrl: config.browserWorkspaceUrl,
    summary: {
      totalCny: accounts.reduce((sum, account) => sum + Number(account.convertedCny || 0), 0),
      healthy: accounts.filter((account) => account.status === 'healthy').length,
      warning: accounts.filter((account) => ['warning', 'critical'].includes(account.status)).length,
      openIncidents: incidents.filter((incident) => incident.state === 'open').length,
      upstreamCount: upstreams.length,
      realUpstreamCount: upstreams.filter((upstream) => upstream.realAccountCount > 0).length,
      lastSyncAt: accounts.map((account) => account.lastSyncAt).filter(Boolean).sort().at(-1) || null,
    },
  };
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

function attemptKey(req, username, scope = 'password') {
  return `${scope}:${req.ip}:${normalizeUsername(username)}`;
}

function checkLoginLimit(req, username, scope = 'password') {
  const key = attemptKey(req, username, scope);
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return key;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((entry.startedAt + LOGIN_WINDOW_MS - Date.now()) / 1000));
    throw Object.assign(new Error(`尝试次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`), { statusCode: 429, retryAfter });
  }
  return key;
}

function recordLoginFailure(key) {
  const current = loginAttempts.get(key);
  if (!current || Date.now() - current.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, startedAt: Date.now() });
    return 1;
  } else {
    current.count += 1;
    return current.count;
  }
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: config.production,
  path: '/',
};

function setSessionCookie(res, auth) {
  res.cookie('frosted_session', createSessionToken(auth), {
    ...sessionCookieOptions,
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function publicSession(req) {
  const auth = store.snapshot().auth;
  const setupRequired = !auth.passwordHash;
  const authenticated = config.authDisabled || (!setupRequired && verifySessionToken(req.cookies.frosted_session, auth));
  return {
    authenticated,
    authRequired: !config.authDisabled,
    setupRequired: !config.authDisabled && setupRequired,
    bootstrapRequired: !config.authDisabled && setupRequired && Boolean(config.bootstrapToken),
    username: authenticated && auth.username ? auth.username : '',
    twoFactorEnabled: Boolean(auth.twoFactorEnabled),
    turnstile: {
      enabled: config.dashboardTurnstileEnabled,
      siteKey: config.dashboardTurnstileEnabled ? config.dashboardTurnstileSiteKey : '',
    },
    passwordPolicy: ['至少 12 位', '大写字母', '小写字母', '数字', '特殊符号'],
  };
}

async function consumeSecondFactor(code) {
  const auth = store.snapshot().auth;
  const secret = decryptSecret(auth.totpSecretEncrypted).value;
  if (secret && /^\d{6}$/.test(String(code || '').trim())) {
    const result = await verifyTotpCodeResult(secret, code, auth.lastAcceptedTotpCounter);
    if (result.valid) {
      return store.mutate((data) => {
        const previous = Number(data.auth.lastAcceptedTotpCounter);
        if (Number.isInteger(previous) && result.timeStep <= previous) {
          return { valid: false, recovery: false, replayed: true };
        }
        data.auth.lastAcceptedTotpCounter = result.timeStep;
        data.auth.updatedAt = new Date().toISOString();
        return { valid: true, recovery: false, timeStep: result.timeStep };
      });
    }
  }
  return store.mutate((data) => {
    const recovery = consumeRecoveryCode(code, data.auth.recoveryCodeHashes);
    if (!recovery.valid) return { valid: false, recovery: false };
    data.auth.recoveryCodeHashes = recovery.hashes;
    data.auth.updatedAt = new Date().toISOString();
    return { valid: true, recovery: true };
  });
}

function authRequired(req, res, next) {
  const auth = store.snapshot().auth;
  if (config.authDisabled || verifySessionToken(req.cookies.frosted_session, auth)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED', message: '请先登录霜镜控制台' });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString(), storage: store.health() }));
app.get('/api/ready', (req, res) => {
  const health = store.health();
  if (health.status !== 'healthy') return res.status(503).json({ status: 'not_ready', storage: health });
  return res.json({ status: 'ready', storage: health });
});
app.get('/api/session', (req, res) => res.json(publicSession(req)));

app.post('/api/session/setup', asyncRoute(async (req, res) => {
  if (config.authDisabled) return res.status(400).json({ message: '认证已被环境变量关闭' });
  if (store.snapshot().auth.passwordHash) return res.status(410).json({ message: '管理员初始化入口已关闭' });
  const input = setupSchema.parse(req.body);
  if (config.bootstrapToken && !verifyBootstrapToken(config.bootstrapToken, input.bootstrapToken)) {
    return res.status(403).json({ message: '初始化引导令牌不正确' });
  }
  await verifyTurnstileToken(input.turnstileToken, req.ip, 'setup');
  const passwordHash = await hashPassword(input.password);
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    if (data.auth.passwordHash) throw Object.assign(new Error('管理员初始化入口已关闭'), { statusCode: 410 });
    data.auth = {
      ...data.auth,
      username: input.username,
      usernameCanonical: normalizeUsername(input.username),
      passwordHash,
      sessionVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.account_initialized', at: timestamp, details: { username: input.username } });
  });
  const auth = store.snapshot().auth;
  setSessionCookie(res, auth);
  res.status(201).json({ success: true, session: publicSession({ ...req, cookies: { ...req.cookies, frosted_session: createSessionToken(auth) } }) });
}));

app.post('/api/session/login', asyncRoute(async (req, res) => {
  if (config.authDisabled) return res.json({ success: true });
  const input = loginSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!auth.passwordHash) return res.status(409).json({ message: '请先完成管理员账户初始化', setupRequired: true });
  const key = checkLoginLimit(req, input.username);
  await verifyTurnstileToken(input.turnstileToken, req.ip, 'login');
  const passwordValid = await verifyPassword(input.password, auth.passwordHash);
  const valid = usernameMatches(input.username, auth) && passwordValid;
  if (!valid) {
    recordLoginFailure(key);
    return res.status(401).json({ message: '用户名或密码不正确' });
  }
  clearLoginFailures(key);
  if (auth.twoFactorEnabled) {
    return res.json({ requiresTwoFactor: true, challengeToken: createTwoFactorChallenge(auth) });
  }
  setSessionCookie(res, auth);
  await store.mutate((data) => {
    data.auth.lastLoginAt = new Date().toISOString();
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.login_succeeded', at: data.auth.lastLoginAt, details: { username: auth.username } });
  });
  return res.json({ success: true });
}));

app.post('/api/session/verify-2fa', asyncRoute(async (req, res) => {
  const input = twoFactorLoginSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!verifyTwoFactorChallenge(input.challengeToken, auth)) return res.status(401).json({ message: '二次验证已过期，请重新登录' });
  const key = checkLoginLimit(req, auth.username, 'two_factor');
  const verified = await consumeSecondFactor(input.code);
  if (!verified.valid) {
    if (recordLoginFailure(key) >= LOGIN_MAX_ATTEMPTS) {
      consumeTwoFactorChallenge(input.challengeToken, auth);
    }
    return res.status(401).json({ message: '验证码或恢复码不正确' });
  }
  if (!consumeTwoFactorChallenge(input.challengeToken, auth)) {
    return res.status(401).json({ message: '二次验证已过期，请重新登录' });
  }
  clearLoginFailures(key);
  if (verified.recovery) await store.mutate((data) => {
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.recovery_code_used', at: new Date().toISOString() });
  });
  const currentAuth = store.snapshot().auth;
  setSessionCookie(res, currentAuth);
  await store.mutate((data) => {
    data.auth.lastLoginAt = new Date().toISOString();
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.login_2fa_succeeded', at: data.auth.lastLoginAt, details: { recoveryCode: verified.recovery } });
  });
  res.json({ success: true });
}));

app.post('/api/session/logout', asyncRoute(async (req, res) => {
  const token = req.cookies.frosted_session;
  let revoked = config.authDisabled;
  if (!config.authDisabled && token && verifySessionToken(token, store.snapshot().auth)) {
    revoked = await store.mutate((data) => {
      if (!verifySessionToken(token, data.auth)) return false;
      data.auth.sessionVersion = Number(data.auth.sessionVersion || 1) + 1;
      data.auth.updatedAt = new Date().toISOString();
      data.audit.unshift({ id: crypto.randomUUID(), type: 'security.logout', at: data.auth.updatedAt });
      return true;
    });
  }
  if (revoked) closeBrowserConnections();
  res.clearCookie('frosted_session', sessionCookieOptions);
  res.json({ success: true });
}));

app.use('/api', authRequired);

app.post('/api/browser-ticket', (req, res) => {
  if (!config.browserWorkspaceUrl) return res.status(404).json({ message: '远程浏览器工作区未启用' });
  const auth = store.snapshot().auth;
  const ticket = issueBrowserTicket(auth, config.appOrigin);
  res.json({ url: browserWorkspaceTicketUrl(ticket), expiresIn: 60 });
});

app.get('/api/browser-access', (req, res) => {
  if (!config.browserWorkspaceUrl) return res.status(404).json({ message: '远程浏览器工作区未启用' });
  const origin = req.get('origin');
  if (origin && !sameOrigin(origin, config.appOrigin)) return res.status(403).json({ message: '浏览器工作区来源不受信任' });
  return res.status(204).end();
});

app.post('/api/upstream-logins', asyncRoute(async (req, res) => {
  const input = upstreamLoginSchema.parse(req.body);
  const destination = await validateUpstreamDestination(input.baseUrl);
  res.status(202).json(startUpstreamLogin({
    ...input,
    proxyServer: browserProxyServer(input.upstreamId),
    resolvedAddresses: destination.addresses || [],
  }));
}));

app.get('/api/upstream-logins/:id', (req, res) => {
  res.json(getUpstreamLogin(req.params.id));
});

app.delete('/api/upstream-logins/:id', asyncRoute(async (req, res) => {
  const cancelled = await cancelUpstreamLogin(req.params.id);
  if (!cancelled) return res.status(404).json({ message: '登录任务不存在或已经结束' });
  res.status(204).end();
}));

app.post('/api/accounts/:id/open-upstream', asyncRoute(async (req, res) => {
  const account = store.snapshot().accounts.find((item) => item.id === req.params.id);
  if (!account) return res.status(404).json({ message: '账号不存在' });
  if (account.demo) return res.status(400).json({ message: '演示账号没有可进入的上游会话' });
  if (account.type !== 'sub2api') return res.status(400).json({ message: '当前仅支持进入 Sub2API 浏览器会话' });
  const destination = await validateUpstreamDestination(account.baseUrl);

  let secret;
  try {
    secret = decryptSecret(account.encryptedSecret);
  } catch {
    return res.status(422).json({ message: '账号凭据无法解密，请重新保存浏览器登录态' });
  }
  if (!secret.sessionCookie && !secret.browserProfileId) {
    return res.status(409).json({ message: '该账号没有保存浏览器登录态' });
  }
  if (secret.browserSessionOrigin && !sameOrigin(secret.browserSessionOrigin, account.baseUrl)) {
    return res.status(409).json({ message: '保存的浏览器登录态与当前上游地址不一致' });
  }
  if (secret.sessionCookie && !secret.browserSessionOrigin && !secret.browserProfileId) {
    return res.status(409).json({ message: '保存的 Cookie 缺少上游来源，请重新建立浏览器登录态' });
  }

  const job = startUpstreamBrowserSession({
    type: account.type,
    baseUrl: account.baseUrl,
    sessionCookie: secret.browserSessionOrigin && sameOrigin(secret.browserSessionOrigin, account.baseUrl)
      ? secret.sessionCookie
      : '',
    browserProfileId: secret.browserProfileId,
    proxyServer: browserProxyServer(account.upstreamId),
    resolvedAddresses: destination.addresses || [],
  });
  await store.mutate((data) => {
    data.audit.unshift({
      id: crypto.randomUUID(),
      type: 'account.upstream_opened',
      accountId: account.id,
      upstreamId: account.upstreamId,
      at: new Date().toISOString(),
      details: { browserSessionReused: true },
    });
  });
  res.status(202).json(job);
}));

app.get('/api/security', (req, res) => {
  const auth = store.snapshot().auth;
  res.json({
    username: auth.username,
    twoFactorEnabled: Boolean(auth.twoFactorEnabled),
    recoveryCodesRemaining: auth.recoveryCodeHashes.length,
    lastLoginAt: auth.lastLoginAt || null,
    turnstileEnabled: config.dashboardTurnstileEnabled,
  });
});

app.patch('/api/security/profile', asyncRoute(async (req, res) => {
  const input = securityProfileSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!await verifyPassword(input.currentPassword, auth.passwordHash)) return res.status(401).json({ message: '当前密码不正确' });
  const nextPasswordHash = input.newPassword ? await hashPassword(input.newPassword) : auth.passwordHash;
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    const previousUsername = data.auth.username;
    data.auth.username = input.username || data.auth.username;
    data.auth.usernameCanonical = normalizeUsername(data.auth.username);
    data.auth.passwordHash = nextPasswordHash;
  data.auth.sessionVersion = Number(data.auth.sessionVersion || 1) + 1;
    data.auth.updatedAt = timestamp;
    data.audit.unshift({
      id: crypto.randomUUID(),
      type: 'security.profile_updated',
      at: timestamp,
      details: { usernameChanged: previousUsername !== data.auth.username, passwordChanged: Boolean(input.newPassword) },
    });
  });
  closeBrowserConnections();
  const updated = store.snapshot().auth;
  setSessionCookie(res, updated);
  res.json({ username: updated.username, twoFactorEnabled: Boolean(updated.twoFactorEnabled) });
}));

app.post('/api/security/2fa/setup', asyncRoute(async (req, res) => {
  const auth = store.snapshot().auth;
  if (auth.twoFactorEnabled) return res.status(409).json({ message: '两步验证已经启用' });
  const enrollment = createTotpEnrollment(auth.username);
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    data.auth.pendingTotpEncrypted = encryptSecret({ value: enrollment.secret });
    data.auth.pendingTotpCreatedAt = timestamp;
  });
  res.json({
    secret: enrollment.secret,
    qrCodeDataUrl: await QRCode.toDataURL(enrollment.uri, { width: 220, margin: 1, errorCorrectionLevel: 'M' }),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
}));

app.post('/api/security/2fa/enable', asyncRoute(async (req, res) => {
  const input = twoFactorCodeSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!auth.pendingTotpEncrypted || Date.now() - new Date(auth.pendingTotpCreatedAt || 0).getTime() > 10 * 60 * 1000) {
    return res.status(400).json({ message: '绑定信息已过期，请重新生成二维码' });
  }
  const secret = decryptSecret(auth.pendingTotpEncrypted).value;
  if (!await verifyTotpCode(secret, input.code)) return res.status(400).json({ message: '动态验证码不正确' });
  const recoveryCodes = generateRecoveryCodes();
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    data.auth.twoFactorEnabled = true;
    data.auth.totpSecretEncrypted = encryptSecret({ value: secret });
    data.auth.pendingTotpEncrypted = '';
    data.auth.pendingTotpCreatedAt = null;
    data.auth.recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);
    data.auth.lastAcceptedTotpCounter = null;
  data.auth.sessionVersion = Number(data.auth.sessionVersion || 1) + 1;
    data.auth.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.2fa_enabled', at: timestamp });
  });
  closeBrowserConnections();
  const updated = store.snapshot().auth;
  setSessionCookie(res, updated);
  res.json({ success: true, recoveryCodes });
}));

app.post('/api/security/2fa/recovery-codes', asyncRoute(async (req, res) => {
  const input = disableTwoFactorSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!auth.twoFactorEnabled) return res.status(400).json({ message: '两步验证尚未启用' });
  if (!await verifyPassword(input.currentPassword, auth.passwordHash)) return res.status(401).json({ message: '当前密码不正确' });
  const verified = await consumeSecondFactor(input.code);
  if (!verified.valid) return res.status(400).json({ message: '验证码或恢复码不正确' });
  const recoveryCodes = generateRecoveryCodes();
  await store.mutate((data) => {
    data.auth.recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.recovery_codes_regenerated', at: new Date().toISOString() });
  });
  res.json({ recoveryCodes });
}));

app.delete('/api/security/2fa', asyncRoute(async (req, res) => {
  const input = disableTwoFactorSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!auth.twoFactorEnabled) return res.status(400).json({ message: '两步验证尚未启用' });
  if (!await verifyPassword(input.currentPassword, auth.passwordHash)) return res.status(401).json({ message: '当前密码不正确' });
  const verified = await consumeSecondFactor(input.code);
  if (!verified.valid) return res.status(400).json({ message: '验证码或恢复码不正确' });
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    data.auth.twoFactorEnabled = false;
    data.auth.totpSecretEncrypted = '';
    data.auth.pendingTotpEncrypted = '';
    data.auth.pendingTotpCreatedAt = null;
    data.auth.recoveryCodeHashes = [];
    data.auth.lastAcceptedTotpCounter = null;
  data.auth.sessionVersion = Number(data.auth.sessionVersion || 1) + 1;
    data.auth.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.2fa_disabled', at: timestamp });
  });
  closeBrowserConnections();
  const updated = store.snapshot().auth;
  setSessionCookie(res, updated);
  res.json({ success: true });
}));

app.get('/api/dashboard', (req, res) => res.json(dashboard()));

app.post('/api/upstreams', asyncRoute(async (req, res) => {
  const input = upstreamSchema.parse(req.body);
  const timestamp = new Date().toISOString();
  const upstream = {
    id: crypto.randomUUID(),
    name: input.name,
    proxyMode: input.proxyMode || 'direct',
    proxyNodeName: '',
    proxyPort: null,
    proxyAssignedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (upstream.proxyMode === 'auto_sticky' && !store.snapshot().proxyPool.subscriptionUrlEncrypted) {
    return res.status(409).json({ message: '请先在系统设置中导入 Clash 订阅' });
  }
  const auditId = crypto.randomUUID();
  const create = () => store.mutate((data) => {
    if (findUpstreamByName(data, upstream.name)) {
      throw Object.assign(new Error('已存在同名上游'), { statusCode: 409 });
    }
    data.upstreams.push(upstream);
    data.audit.unshift({ id: auditId, type: 'upstream.created', upstreamId: upstream.id, at: timestamp, details: { name: upstream.name } });
  });
  if (upstream.proxyMode === 'auto_sticky') {
    await proxyPool.withConfigurationChange(async () => {
      await create();
      try {
        await proxyPool.syncUnlocked();
      } catch (error) {
        await store.mutate((data) => {
          data.upstreams = data.upstreams.filter((item) => item.id !== upstream.id);
          data.audit = data.audit.filter((item) => item.id !== auditId);
        });
        await proxyPool.syncUnlocked().catch(() => { proxyPool.startSyncRetry(); });
        throw error;
      }
    });
  } else {
    await create();
  }
  res.status(201).json({ upstream: aggregateUpstreams(store.snapshot().upstreams, store.snapshot().accounts.map(sanitizeAccount), store.snapshot().incidents).find((item) => item.id === upstream.id) });
}));

app.patch('/api/upstreams/:id', asyncRoute(async (req, res) => {
  const input = upstreamSchema.parse(req.body);
  const timestamp = new Date().toISOString();
  const previous = store.snapshot().upstreams.find((item) => item.id === req.params.id);
  if (!previous) return res.status(404).json({ message: '上游不存在' });
  if (input.proxyMode === 'auto_sticky' && !store.snapshot().proxyPool.subscriptionUrlEncrypted) {
    return res.status(409).json({ message: '请先在系统设置中导入 Clash 订阅' });
  }
  const auditId = crypto.randomUUID();
  const update = () => store.mutate((data) => {
    const upstream = data.upstreams.find((item) => item.id === req.params.id);
    if (!upstream) throw Object.assign(new Error('上游不存在'), { statusCode: 404 });
    const duplicate = findUpstreamByName(data, input.name);
    if (duplicate && duplicate.id !== upstream.id) {
      throw Object.assign(new Error('已存在同名上游'), { statusCode: 409 });
    }
    const previousName = upstream.name;
    upstream.name = input.name;
    if (input.proxyMode) {
      upstream.proxyMode = input.proxyMode;
      if (input.proxyMode === 'direct') {
        upstream.proxyNodeName = '';
        upstream.proxyAssignedAt = null;
        upstream.proxyStatus = 'direct';
        upstream.proxyLatencyMs = null;
      }
    }
    upstream.updatedAt = timestamp;
    data.audit.unshift({ id: auditId, type: 'upstream.updated', upstreamId: upstream.id, at: timestamp, details: { previousName, name: upstream.name, proxyMode: upstream.proxyMode } });
  });
  const proxyChanged = Boolean(input.proxyMode && input.proxyMode !== previous.proxyMode);
  if (proxyChanged) {
    await proxyPool.withConfigurationChange(async () => {
      await update();
      try {
        await proxyPool.syncUnlocked();
      } catch (error) {
        await store.mutate((data) => {
          const index = data.upstreams.findIndex((item) => item.id === previous.id);
          if (index >= 0) data.upstreams[index] = previous;
          data.audit = data.audit.filter((item) => item.id !== auditId);
        });
        await proxyPool.syncUnlocked().catch(() => { proxyPool.startSyncRetry(); });
        throw error;
      }
    });
  } else {
    await update();
  }
  res.json({ upstream: dashboard().upstreams.find((item) => item.id === req.params.id) });
}));

app.delete('/api/upstreams/:id', asyncRoute(async (req, res) => {
  const data = store.snapshot();
  const previousIndex = data.upstreams.findIndex((item) => item.id === req.params.id);
  if (previousIndex < 0) return res.status(404).json({ message: '上游不存在' });
  const previous = data.upstreams[previousIndex];
  const auditId = crypto.randomUUID();
  const remove = () => store.mutate((state) => {
    const target = state.upstreams.find((item) => item.id === req.params.id);
    if (!target) throw Object.assign(new Error('上游不存在'), { statusCode: 404 });
    if (state.accounts.some((account) => account.upstreamId === req.params.id)) {
      throw Object.assign(new Error('该上游仍有关联账号，请先移动或删除账号'), { statusCode: 409 });
    }
    state.upstreams = state.upstreams.filter((item) => item.id !== req.params.id);
    state.audit.unshift({ id: auditId, type: 'upstream.deleted', upstreamId: req.params.id, at: new Date().toISOString() });
  });
  if (previous.proxyMode === 'auto_sticky') {
    await proxyPool.withConfigurationChange(async () => {
      await remove();
      try {
        await proxyPool.syncUnlocked();
      } catch (error) {
        await store.mutate((state) => {
          state.upstreams.splice(previousIndex, 0, previous);
          state.audit = state.audit.filter((item) => item.id !== auditId);
        });
        await proxyPool.syncUnlocked().catch(() => { proxyPool.startSyncRetry(); });
        throw error;
      }
    });
  } else {
    await remove();
  }
  res.status(204).end();
}));

app.post('/api/upstreams/:id/proxy/reassign', asyncRoute(async (req, res) => {
  await proxyPool.reassign(req.params.id);
  res.json({ upstream: dashboard().upstreams.find((item) => item.id === req.params.id), proxyPool: proxyPool.publicState() });
}));

app.get('/api/proxy-pool', (req, res) => res.json(proxyPool.publicState()));

app.put('/api/proxy-pool/subscription', asyncRoute(async (req, res) => {
  const input = proxySubscriptionSchema.parse(req.body);
  const result = await proxyPool.importSubscription(input.url);
  await store.mutate((data) => {
    data.audit.unshift({ id: crypto.randomUUID(), type: 'proxy.subscription_imported', at: new Date().toISOString(), details: { nodeCount: result.summary.total } });
    data.audit = data.audit.slice(0, 500);
  });
  res.json(result);
}));

app.post('/api/proxy-pool/refresh', asyncRoute(async (req, res) => {
  res.json(await proxyPool.refreshSubscription());
}));

app.post('/api/proxy-pool/check', asyncRoute(async (req, res) => {
  res.json(await proxyPool.check());
}));

app.post('/api/formulas/test', (req, res) => {
  const rawValue = Number(req.body?.rawValue);
  const formula = normalizeFormula(req.body?.formula);
  res.json({ formula, rawValue, convertedCny: evaluateFormula(formula, rawValue) });
});

app.post('/api/accounts/test', asyncRoute(async (req, res) => {
  const input = accountSchema.parse(req.body);
  await validateUpstreamDestination(input.baseUrl);
  requireUpstream(input.upstreamId);
  evaluateFormula(input.formula, 1);
  const accountId = String(req.body?.id || '');
  const runTest = async () => {
    let secret = input.credentials || {};
    if (input.browserLoginId) {
      secret = mergeSecrets(secret, getUpstreamLoginCredential(input.browserLoginId, input.baseUrl));
    }
    let mayPersistToExistingAccount = false;
    // 编辑已有账号时，在账号锁内读取最新密文，避免与后台续期互相覆盖。
    if (accountId) {
      const existing = store.snapshot().accounts.find((item) => item.id === accountId);
      mayPersistToExistingAccount = Boolean(existing && sameOrigin(existing.baseUrl, input.baseUrl));
      if (existing?.encryptedSecret && mayPersistToExistingAccount) {
        try {
          secret = mergeSecrets(decryptSecret(existing.encryptedSecret), secret);
        } catch {
          // 忽略解密失败，仅用请求体凭据。
        }
      }
    }

    let collected;
    try {
      collected = await collectBalance(input, secret);
    } catch (error) {
      const credentialCheckpoint = takeCredentialCheckpoint(error);
      if (input.browserLoginId && credentialCheckpoint) {
        updateUpstreamLoginCredential(input.browserLoginId, credentialCheckpoint);
      }
      if (accountId && mayPersistToExistingAccount && credentialCheckpoint) {
        await store.mutate((data) => {
          const account = data.accounts.find((item) => item.id === accountId);
          if (!account) return;
          const timestamp = new Date().toISOString();
          account.encryptedSecret = encryptSecret(credentialCheckpoint);
          account.updatedAt = timestamp;
          data.audit.unshift({
            id: crypto.randomUUID(),
            type: 'account.credentials.checkpointed',
            accountId: account.id,
            upstreamId: account.upstreamId,
            at: timestamp,
            details: { reason: 'connection_test_after_token_rotation' },
          });
          data.audit = data.audit.slice(0, 500);
        });
      }
      throw error;
    }

    // 测试成功且拿到/续期凭据时写回加密存储。
    if (accountId && mayPersistToExistingAccount && collected.updatedSecret) {
      await store.mutate((data) => {
        const account = data.accounts.find((item) => item.id === accountId);
        if (!account) return;
        account.encryptedSecret = encryptSecret(collected.updatedSecret);
        account.updatedAt = new Date().toISOString();
        account.metadata = { ...(account.metadata || {}), ...(collected.metadata || {}) };
      });
    }
    if (input.browserLoginId) {
      updateUpstreamLoginCredential(input.browserLoginId, collected.updatedSecret || secret);
    }
    return collected;
  };
  const result = accountId
    ? await withAccountCredentialLock(accountId, runTest)
    : await runTest();
  res.json({
    rawBalance: result.rawBalance,
    convertedCny: evaluateFormula(input.formula, result.rawBalance),
    metadata: result.metadata,
    tokensCaptured: Boolean(result.updatedSecret?.apiToken || result.updatedSecret?.apiTokens?.length || result.updatedSecret?.accessToken || result.updatedSecret?.accessTokens?.length || result.updatedSecret?.refreshToken),
  });
}));

app.post('/api/accounts', asyncRoute(async (req, res) => {
  const input = accountSchema.parse(req.body);
  await validateUpstreamDestination(input.baseUrl);
  evaluateFormula(input.formula, 1);
  const capturedCredential = input.browserLoginId
    ? getUpstreamLoginCredential(input.browserLoginId, input.baseUrl)
    : null;
  const credentials = mergeSecrets(input.credentials || {}, capturedCredential || {});
  const timestamp = new Date().toISOString();
  const account = {
    ...input,
    id: crypto.randomUUID(),
    subgroup: input.subgroup || input.region,
    encryptedSecret: encryptSecret(credentials),
    demo: false,
    rawBalance: 0,
    convertedCny: 0,
    status: 'pending',
    lastSyncAt: null,
    lastError: '',
    recoveryChecks: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  delete account.credentials;
  delete account.browserLoginId;
  await store.mutate((data) => {
    requireUpstream(account.upstreamId, data);
    data.accounts.push(account);
    data.audit.unshift({ id: crypto.randomUUID(), type: 'account.created', accountId: account.id, upstreamId: account.upstreamId, at: timestamp });
  });
  if (input.browserLoginId) await consumeUpstreamLogin(input.browserLoginId);
  let syncError = '';
  try {
    await monitor.poll(account.id);
  } catch (error) {
    syncError = error.message;
  }
  res.status(201).json({ account: sanitizeAccount(store.snapshot().accounts.find((item) => item.id === account.id)), syncError });
}));

app.patch('/api/accounts/:id', asyncRoute(async (req, res) => {
  const outcome = await withAccountCredentialLock(req.params.id, async () => {
    const currentData = store.snapshot();
    const current = currentData.accounts.find((item) => item.id === req.params.id);
    if (!current) return { status: 404, message: '账号不存在' };
    const timestamp = new Date().toISOString();
    const targetUpstreamId = req.body.upstreamId || current.upstreamId;
    const merged = accountSchema.parse({ ...current, ...req.body, upstreamId: targetUpstreamId, credentials: req.body.credentials || undefined });
    await validateUpstreamDestination(merged.baseUrl);
    evaluateFormula(merged.formula, Number(current.rawBalance || 1));
    const originChanged = !sameOrigin(current.baseUrl, merged.baseUrl);
    if (originChanged && !req.body.credentials) {
      return { status: 400, message: '更换站点域名时必须重新输入凭据，旧凭据不会发送到新站点' };
    }
    const changedFields = Object.keys(req.body || {}).filter((key) => key !== 'credentials' && key !== 'encryptedSecret');
    await store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === req.params.id);
      if (!account) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
      requireUpstream(merged.upstreamId, data);
      let nextSecret = account.encryptedSecret;
      if (req.body.credentials) {
        let existing = {};
        if (!originChanged) {
          try {
            existing = decryptSecret(account.encryptedSecret);
          } catch {
            existing = {};
          }
        }
        nextSecret = encryptSecret(mergeSecrets(existing, req.body.credentials));
      }
      Object.assign(account, merged, { updatedAt: timestamp });
      account.encryptedSecret = nextSecret;
      delete account.credentials;
      data.audit.unshift({ id: crypto.randomUUID(), type: 'account.updated', accountId: account.id, upstreamId: account.upstreamId, at: account.updatedAt, details: { changedFields, credentialsUpdated: Boolean(req.body.credentials) } });
    });
    return { account: sanitizeAccount(store.snapshot().accounts.find((item) => item.id === req.params.id)) };
  });
  if (outcome.status) return res.status(outcome.status).json({ message: outcome.message });
  return res.json({ account: outcome.account });
}));

app.patch('/api/accounts/:id/upstream', asyncRoute(async (req, res) => {
  const upstreamId = z.string().trim().min(1).parse(req.body?.upstreamId);
  const account = await withAccountCredentialLock(req.params.id, () => store.mutate((state) => {
    const current = state.accounts.find((item) => item.id === req.params.id);
    if (!current) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    requireUpstream(upstreamId, state);
    const previousUpstreamId = current.upstreamId;
    current.upstreamId = upstreamId;
    current.updatedAt = new Date().toISOString();
    state.audit.unshift({ id: crypto.randomUUID(), type: 'account.upstream_changed', accountId: current.id, upstreamId, at: current.updatedAt, details: { previousUpstreamId } });
    return structuredClone(current);
  }));
  res.json({ account: sanitizeAccount(account) });
}));

app.get('/api/accounts/:id/api-keys', asyncRoute(async (req, res) => {
  const details = await withAccountCredentialLock(req.params.id, async () => {
    const account = store.snapshot().accounts.find((item) => item.id === req.params.id);
    if (!account) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    const supportsKeyDetails = account.authMode === 'api_token'
      || (account.type === 'newapi' && account.authMode === 'access_token')
      || (account.type === 'sub2api' && account.authMode !== 'api_token');
    if (!supportsKeyDetails) return collectApiKeyDetails(account);

    let secret;
    try {
      secret = decryptSecret(account.encryptedSecret);
    } catch {
      throw Object.assign(new Error('账号凭据无法解密，请重新保存 API Key'), { statusCode: 422 });
    }
    const result = await collectApiKeyDetails(account, secret);
    const { updatedSecret, ...safeResult } = result;
    if (updatedSecret) {
      await store.mutate((data) => {
        const current = data.accounts.find((item) => item.id === account.id);
        if (!current) return;
        current.encryptedSecret = encryptSecret(updatedSecret);
        current.updatedAt = new Date().toISOString();
      });
    }
    return {
      ...safeResult,
      keys: result.keys.map((key) => ({
        ...key,
        convertedCny: Number.isFinite(key.rawBalance)
          ? evaluateFormula(account.formula, key.rawBalance)
          : null,
      })),
    };
  });
  res.json(details);
}));

app.get('/api/accounts/:id/snapshots', (req, res) => {
  const input = z.object({
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  const data = store.snapshot();
  const account = data.accounts.find((item) => item.id === req.params.id);
  if (!account) return res.status(404).json({ message: '账号不存在' });
  const snapshots = data.snapshots
    .filter((item) => item.accountId === account.id && (!input.cursor || item.capturedAt < input.cursor))
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
    .slice(0, input.limit);
  return res.json({
    snapshots,
    nextCursor: snapshots.length === input.limit ? snapshots.at(-1).capturedAt : null,
  });
});

app.delete('/api/accounts/:id', asyncRoute(async (req, res) => {
  await withAccountCredentialLock(req.params.id, () => store.mutate((data) => {
    const account = data.accounts.find((item) => item.id === req.params.id);
    if (!account || account.deletedAt) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    const timestamp = new Date().toISOString();
    account.enabledBeforeDelete = Boolean(account.enabled);
    account.enabled = false;
    account.deletedAt = timestamp;
    account.status = 'deleted';
    account.updatedAt = timestamp;
    for (const event of data.notificationOutbox) {
      if (event.accountId === account.id && !['completed', 'dead', 'cancelled'].includes(event.status)) {
        event.status = 'cancelled';
        event.cancelledAt = timestamp;
      }
    }
    data.audit.unshift({ id: crypto.randomUUID(), type: 'account.deleted', accountId: account.id, upstreamId: account.upstreamId, at: timestamp });
  }));
  res.status(204).end();
}));

app.post('/api/accounts/:id/restore', asyncRoute(async (req, res) => {
  const account = await withAccountCredentialLock(req.params.id, () => store.mutate((data) => {
    const current = data.accounts.find((item) => item.id === req.params.id);
    if (!current || !current.deletedAt) throw Object.assign(new Error('回收站中没有该账号'), { statusCode: 404 });
    requireUpstream(current.upstreamId, data);
    const timestamp = new Date().toISOString();
    current.enabled = Boolean(current.enabledBeforeDelete);
    delete current.enabledBeforeDelete;
    current.deletedAt = null;
    current.status = 'pending';
    current.lastError = '';
    current.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'account.restored', accountId: current.id, upstreamId: current.upstreamId, at: timestamp });
    return structuredClone(current);
  }));
  res.json({ account: sanitizeAccount(account) });
}));

app.delete('/api/accounts/:id/credentials', asyncRoute(async (req, res) => {
  const account = await withAccountCredentialLock(req.params.id, () => store.mutate((data) => {
    const current = data.accounts.find((item) => item.id === req.params.id && !item.deletedAt);
    if (!current) throw Object.assign(new Error('账号不存在'), { statusCode: 404 });
    const timestamp = new Date().toISOString();
    current.encryptedSecret = '';
    current.enabled = false;
    current.status = 'credentials_required';
    current.lastError = '凭据已清除，请重新编辑账号后启用';
    current.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'account.credentials_cleared', accountId: current.id, upstreamId: current.upstreamId, at: timestamp });
    return structuredClone(current);
  }));
  res.json({ account: sanitizeAccount(account) });
}));

app.post('/api/accounts/:id/refresh', asyncRoute(async (req, res) => {
  const account = await monitor.poll(req.params.id);
  res.json({ account: sanitizeAccount(account), dashboard: dashboard() });
}));

app.post('/api/accounts/:id/simulate-recharge', asyncRoute(async (req, res) => {
  const account = store.snapshot().accounts.find((item) => item.id === req.params.id);
  if (!account?.demo) return res.status(400).json({ message: '仅演示账号支持模拟充值' });
  await monitor.poll(req.params.id, { recharge: true });
  await monitor.poll(req.params.id, { recharge: true });
  res.json(dashboard());
}));

app.post('/api/incidents/:id/acknowledge', asyncRoute(async (req, res) => {
  await store.mutate((data) => {
    const incident = data.incidents.find((item) => item.id === req.params.id);
    if (!incident) throw new Error('事件不存在');
    incident.acknowledgedAt = new Date().toISOString();
  });
  res.json(dashboard());
}));

app.put('/api/settings', asyncRoute(async (req, res) => {
  const input = saveSettingsSchema.parse(req.body);
  await store.mutate((data) => {
    data.settings = {
      ...data.settings,
      resendEnabled: input.resendEnabled,
      resendFrom: input.resendFrom,
      resendTo: input.resendTo,
      feishuEnabled: input.feishuEnabled,
      recoveryConfirmations: input.recoveryConfirmations,
      reminderMinutes: input.reminderHours !== undefined ? input.reminderHours * 60 : input.reminderMinutes,
      resendApiKeyEncrypted: input.resendApiKey ? encryptSecret({ value: input.resendApiKey }) : data.settings.resendApiKeyEncrypted,
      feishuWebhookEncrypted: input.feishuWebhook ? encryptSecret({ value: input.feishuWebhook }) : data.settings.feishuWebhookEncrypted,
    };
  });
  res.json({ settings: publicSettings(store.snapshot().settings) });
}));

app.post('/api/settings/test-notification', asyncRoute(async (req, res) => {
  const input = notificationTestSchema.parse(req.body);
  const data = store.snapshot();
  const draft = { ...data.settings, ...input.settings };
  const realAccount = data.accounts.find((item) => !item.demo) || data.accounts[0];
  const upstream = data.upstreams.find((item) => item.id === realAccount?.upstreamId);
  const account = {
    ...(realAccount || { name: '测试账号', thresholdLow: 50 }),
    upstreamName: upstream?.name || '',
    notifications: { resend: true, feishu: true },
  };
  const incident = { id: 'test-notification', currentBalance: account.convertedCny || 21.6 };
  const secrets = {
    resendApiKey: input.settings.resendApiKey || decryptSecret(data.settings.resendApiKeyEncrypted).value,
    feishuWebhook: input.settings.feishuWebhook || decryptSecret(data.settings.feishuWebhookEncrypted).value,
  };
  const results = await notify('opened', account, incident, draft, secrets, { channels: [input.channel], force: true });
  await store.mutate((state) => {
    state.audit.unshift({ id: crypto.randomUUID(), type: 'notification.test', accountId: account.id, upstreamId: account.upstreamId, at: new Date().toISOString(), details: results });
    state.audit = state.audit.slice(0, 500);
  });
  res.json({ result: results[input.channel] });
}));

const dist = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || !req.accepts('html')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((error, req, res, next) => {
  console.error('[request-error]', {
    method: req.method,
    path: req.path,
    name: error?.name,
    message: error?.message,
    code: error?.code,
    statusCode: error?.statusCode,
    ...(!config.production && error?.stack ? { stack: error.stack } : {}),
  });
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError) return res.status(400).json({ message: error.issues[0]?.message || '参数错误', issues: error.issues });
  if (error.statusCode) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.statusCode).json({ message: error.message });
  }
  res.status(500).json({ message: error.message || '服务器内部错误' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`[frosted-console] http://localhost:${port}`);
  process.send?.({ type: 'ready', port });
});
const browserGateway = attachBrowserGateway(server, store);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  monitor.stop();
  browserGateway.close();
  await shutdownUpstreamLogins();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref?.();
}

process.once('SIGINT', () => { shutdown().catch(() => process.exit(1)); });
process.once('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
