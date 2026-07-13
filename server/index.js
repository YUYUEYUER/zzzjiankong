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
import { collectBalance, mergeSecrets } from './collectors.js';
import { evaluateFormula, normalizeFormula } from './converter.js';
import {
  consumeRecoveryCode,
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
  verifySessionToken,
  verifyTotpCode,
  verifyTurnstileToken,
  verifyTwoFactorChallenge,
} from './security.js';
import { notify } from './notifications.js';
import { getTurnstileSolverStatus } from './turnstile.js';
import { aggregateUpstreams } from './upstreams.js';

const app = express();
const store = await new JsonStore().init();
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

const accountSchema = z.object({
  upstreamId: z.string().trim().max(80).optional().default(''),
  name: z.string().trim().min(1).max(60),
  type: z.enum(['newapi', 'sub2api', 'generic']),
  baseUrl: z.union([z.string().url(), z.literal('')]),
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
  credentials: z.object({
    accessToken: z.string().optional(),
    accessTokens: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
    apiToken: z.string().optional(),
    apiTokens: z.array(z.string().trim().min(1).max(4096)).max(20).optional(),
    refreshToken: z.string().optional(),
    password: z.string().optional(),
    /** One-shot token after manual browser verification; also used as fallback when auto-solve is off */
    turnstileToken: z.string().optional(),
  }).optional(),
}).refine((value) => value.thresholdRecover >= value.thresholdLow, {
  message: '恢复阈值不能低于告警阈值',
  path: ['thresholdRecover'],
});

const upstreamSchema = z.object({
  name: z.string().trim().min(1, '请填写上游名称').max(60),
});

const settingsSchema = z.object({
  resendEnabled: z.boolean(),
  resendFrom: z.string().max(200),
  resendTo: z.string().max(500),
  resendApiKey: z.string().optional(),
  feishuEnabled: z.boolean(),
  feishuWebhook: z.string().optional(),
  recoveryConfirmations: z.coerce.number().int().min(1).max(5),
  reminderHours: z.coerce.number().int().min(1).max(168),
});

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
const setupSchema = z.object({ username: usernameSchema, password: strongPasswordSchema, turnstileToken: z.string().optional().default('') });
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

function dashboard() {
  const data = store.snapshot();
  const accounts = data.accounts.map(sanitizeAccount);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const upstreams = aggregateUpstreams(data.upstreams, accounts, data.incidents);
  const upstreamById = new Map(upstreams.map((upstream) => [upstream.id, upstream]));
  const incidents = data.incidents.map((incident) => {
    const account = byId.get(incident.accountId);
    return { ...incident, account, upstream: upstreamById.get(account?.upstreamId) };
  });
  return {
    upstreams,
    accounts,
    snapshots: data.snapshots,
    incidents,
    audit: data.audit.slice(0, 200),
    settings: publicSettings(data.settings),
    turnstileSolver: getTurnstileSolverStatus(config),
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
  } else {
    current.count += 1;
  }
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function setSessionCookie(res, auth) {
  res.cookie('frosted_session', createSessionToken(auth), {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.production,
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
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
    username: authenticated && auth.username ? auth.username : '',
    twoFactorEnabled: Boolean(auth.twoFactorEnabled),
    turnstile: {
      enabled: config.dashboardTurnstileEnabled,
      siteKey: config.dashboardTurnstileEnabled ? config.dashboardTurnstileSiteKey : '',
    },
    passwordPolicy: ['至少 12 位', '大写字母', '小写字母', '数字', '特殊符号'],
  };
}

async function verifySecondFactor(auth, code) {
  const secret = decryptSecret(auth.totpSecretEncrypted).value;
  if (secret && await verifyTotpCode(secret, code)) return { valid: true, recovery: false, hashes: auth.recoveryCodeHashes };
  const recovery = consumeRecoveryCode(code, auth.recoveryCodeHashes);
  return { valid: recovery.valid, recovery: recovery.valid, hashes: recovery.hashes };
}

function authRequired(req, res, next) {
  const auth = store.snapshot().auth;
  if (config.authDisabled || verifySessionToken(req.cookies.frosted_session, auth)) return next();
  return res.status(401).json({ error: 'AUTH_REQUIRED', message: '请先登录霜镜控制台' });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/session', (req, res) => res.json(publicSession(req)));

app.post('/api/session/setup', asyncRoute(async (req, res) => {
  if (config.authDisabled) return res.status(400).json({ message: '认证已被环境变量关闭' });
  const input = setupSchema.parse(req.body);
  if (store.snapshot().auth.passwordHash) return res.status(409).json({ message: '管理员账户已经初始化' });
  await verifyTurnstileToken(input.turnstileToken, req.ip, 'setup');
  const passwordHash = await hashPassword(input.password);
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    if (data.auth.passwordHash) throw Object.assign(new Error('管理员账户已经初始化'), { statusCode: 409 });
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
  const verified = await verifySecondFactor(auth, input.code);
  if (!verified.valid) {
    recordLoginFailure(key);
    return res.status(401).json({ message: '验证码或恢复码不正确' });
  }
  clearLoginFailures(key);
  if (verified.recovery) {
    await store.mutate((data) => {
      data.auth.recoveryCodeHashes = verified.hashes;
      data.audit.unshift({ id: crypto.randomUUID(), type: 'security.recovery_code_used', at: new Date().toISOString() });
    });
  }
  const currentAuth = store.snapshot().auth;
  setSessionCookie(res, currentAuth);
  await store.mutate((data) => {
    data.auth.lastLoginAt = new Date().toISOString();
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.login_2fa_succeeded', at: data.auth.lastLoginAt, details: { recoveryCode: verified.recovery } });
  });
  res.json({ success: true });
}));

app.post('/api/session/logout', (req, res) => {
  res.clearCookie('frosted_session', { path: '/' });
  res.json({ success: true });
});

app.use('/api', authRequired);

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
    data.auth.sessionVersion = Number(data.auth.sessionVersion || 1) + 1;
    data.auth.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.2fa_enabled', at: timestamp });
  });
  const updated = store.snapshot().auth;
  setSessionCookie(res, updated);
  res.json({ success: true, recoveryCodes });
}));

app.post('/api/security/2fa/recovery-codes', asyncRoute(async (req, res) => {
  const input = disableTwoFactorSchema.parse(req.body);
  const auth = store.snapshot().auth;
  if (!auth.twoFactorEnabled) return res.status(400).json({ message: '两步验证尚未启用' });
  if (!await verifyPassword(input.currentPassword, auth.passwordHash)) return res.status(401).json({ message: '当前密码不正确' });
  const verified = await verifySecondFactor(auth, input.code);
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
  const verified = await verifySecondFactor(auth, input.code);
  if (!verified.valid) return res.status(400).json({ message: '验证码或恢复码不正确' });
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    data.auth.twoFactorEnabled = false;
    data.auth.totpSecretEncrypted = '';
    data.auth.pendingTotpEncrypted = '';
    data.auth.pendingTotpCreatedAt = null;
    data.auth.recoveryCodeHashes = [];
    data.auth.sessionVersion = Number(data.auth.sessionVersion || 1) + 1;
    data.auth.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'security.2fa_disabled', at: timestamp });
  });
  const updated = store.snapshot().auth;
  setSessionCookie(res, updated);
  res.json({ success: true });
}));

app.get('/api/dashboard', (req, res) => res.json(dashboard()));

app.post('/api/upstreams', asyncRoute(async (req, res) => {
  const input = upstreamSchema.parse(req.body);
  const timestamp = new Date().toISOString();
  const upstream = { id: crypto.randomUUID(), name: input.name, createdAt: timestamp, updatedAt: timestamp };
  await store.mutate((data) => {
    data.upstreams.push(upstream);
    data.audit.unshift({ id: crypto.randomUUID(), type: 'upstream.created', upstreamId: upstream.id, at: timestamp, details: { name: upstream.name } });
  });
  res.status(201).json({ upstream: aggregateUpstreams(store.snapshot().upstreams, store.snapshot().accounts.map(sanitizeAccount), store.snapshot().incidents).find((item) => item.id === upstream.id) });
}));

app.patch('/api/upstreams/:id', asyncRoute(async (req, res) => {
  const input = upstreamSchema.parse(req.body);
  const timestamp = new Date().toISOString();
  await store.mutate((data) => {
    const upstream = data.upstreams.find((item) => item.id === req.params.id);
    if (!upstream) throw Object.assign(new Error('上游不存在'), { statusCode: 404 });
    const previousName = upstream.name;
    upstream.name = input.name;
    upstream.updatedAt = timestamp;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'upstream.renamed', upstreamId: upstream.id, at: timestamp, details: { previousName, name: upstream.name } });
  });
  res.json({ upstream: dashboard().upstreams.find((item) => item.id === req.params.id) });
}));

app.delete('/api/upstreams/:id', asyncRoute(async (req, res) => {
  const data = store.snapshot();
  if (!data.upstreams.some((item) => item.id === req.params.id)) return res.status(404).json({ message: '上游不存在' });
  if (data.accounts.some((account) => account.upstreamId === req.params.id)) return res.status(409).json({ message: '该上游仍有关联账号，请先移动或删除账号' });
  await store.mutate((state) => {
    state.upstreams = state.upstreams.filter((item) => item.id !== req.params.id);
    state.audit.unshift({ id: crypto.randomUUID(), type: 'upstream.deleted', upstreamId: req.params.id, at: new Date().toISOString() });
  });
  res.status(204).end();
}));

app.post('/api/formulas/test', (req, res) => {
  const rawValue = Number(req.body?.rawValue);
  const formula = normalizeFormula(req.body?.formula);
  res.json({ formula, rawValue, convertedCny: evaluateFormula(formula, rawValue) });
});

app.post('/api/accounts/test', asyncRoute(async (req, res) => {
  const input = accountSchema.parse(req.body);
  evaluateFormula(input.formula, 1);
  let secret = input.credentials || {};
  // 编辑已有账号时，测试连接可与已加密凭据合并（请求体可只带部分字段）
  if (req.body?.id) {
    const existing = store.snapshot().accounts.find((item) => item.id === req.body.id);
    if (existing?.encryptedSecret) {
      try {
        secret = mergeSecrets(decryptSecret(existing.encryptedSecret), secret);
      } catch {
        // 忽略解密失败，仅用请求体凭据
      }
    }
  }
  const result = await collectBalance(input, secret);
  // 对已有账号：测试成功且拿到/续期了 token 时写回加密存储，实现长久登录
  if (req.body?.id && result.updatedSecret) {
    const existing = store.snapshot().accounts.find((item) => item.id === req.body.id);
    if (existing) {
      await store.mutate((data) => {
        const account = data.accounts.find((item) => item.id === req.body.id);
        if (account) {
          account.encryptedSecret = encryptSecret(result.updatedSecret);
          account.updatedAt = new Date().toISOString();
          account.metadata = { ...(account.metadata || {}), ...(result.metadata || {}) };
        }
      });
    }
  }
  res.json({
    rawBalance: result.rawBalance,
    convertedCny: evaluateFormula(input.formula, result.rawBalance),
    metadata: result.metadata,
    tokensCaptured: Boolean(result.updatedSecret?.apiToken || result.updatedSecret?.apiTokens?.length || result.updatedSecret?.accessToken || result.updatedSecret?.accessTokens?.length || result.updatedSecret?.refreshToken),
  });
}));

app.post('/api/accounts', asyncRoute(async (req, res) => {
  const input = accountSchema.parse(req.body);
  evaluateFormula(input.formula, 1);
  const timestamp = new Date().toISOString();
  let upstreamId = input.upstreamId;
  let implicitUpstream = null;
  const currentData = store.snapshot();
  if (upstreamId && !currentData.upstreams.some((upstream) => upstream.id === upstreamId)) return res.status(400).json({ message: '所选上游不存在' });
  if (!upstreamId) {
    implicitUpstream = { id: crypto.randomUUID(), name: input.name, createdAt: timestamp, updatedAt: timestamp };
    upstreamId = implicitUpstream.id;
  }
  const account = {
    ...input,
    upstreamId,
    id: crypto.randomUUID(),
    subgroup: input.subgroup || input.region,
    encryptedSecret: encryptSecret(input.credentials || {}),
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
  await store.mutate((data) => {
    if (implicitUpstream) {
      data.upstreams.push(implicitUpstream);
      data.audit.unshift({ id: crypto.randomUUID(), type: 'upstream.created', upstreamId: implicitUpstream.id, at: timestamp, details: { name: implicitUpstream.name } });
    }
    data.accounts.push(account);
    data.audit.unshift({ id: crypto.randomUUID(), type: 'account.created', accountId: account.id, upstreamId, at: timestamp });
  });
  let syncError = '';
  try {
    await monitor.poll(account.id);
  } catch (error) {
    syncError = error.message;
  }
  res.status(201).json({ account: sanitizeAccount(store.snapshot().accounts.find((item) => item.id === account.id)), syncError });
}));

app.patch('/api/accounts/:id', asyncRoute(async (req, res) => {
  const current = store.snapshot().accounts.find((item) => item.id === req.params.id);
  if (!current) return res.status(404).json({ message: '账号不存在' });
  const merged = accountSchema.parse({ ...current, ...req.body, credentials: req.body.credentials || undefined });
  if (!store.snapshot().upstreams.some((upstream) => upstream.id === merged.upstreamId)) return res.status(400).json({ message: '所选上游不存在' });
  evaluateFormula(merged.formula, Number(current.rawBalance || 1));
  const changedFields = Object.keys(req.body || {}).filter((key) => key !== 'credentials' && key !== 'encryptedSecret');
  await store.mutate((data) => {
    const account = data.accounts.find((item) => item.id === req.params.id);
    let nextSecret = account.encryptedSecret;
    if (req.body.credentials) {
      let existing = {};
      try {
        existing = decryptSecret(account.encryptedSecret);
      } catch {
        existing = {};
      }
      nextSecret = encryptSecret(mergeSecrets(existing, req.body.credentials));
    }
    Object.assign(account, merged, { updatedAt: new Date().toISOString() });
    account.encryptedSecret = nextSecret;
    delete account.credentials;
    data.audit.unshift({ id: crypto.randomUUID(), type: 'account.updated', accountId: account.id, upstreamId: account.upstreamId, at: account.updatedAt, details: { changedFields, credentialsUpdated: Boolean(req.body.credentials) } });
  });
  res.json({ account: sanitizeAccount(store.snapshot().accounts.find((item) => item.id === req.params.id)) });
}));

app.patch('/api/accounts/:id/upstream', asyncRoute(async (req, res) => {
  const upstreamId = z.string().trim().min(1).parse(req.body?.upstreamId);
  const data = store.snapshot();
  const current = data.accounts.find((account) => account.id === req.params.id);
  if (!current) return res.status(404).json({ message: '账号不存在' });
  if (!data.upstreams.some((upstream) => upstream.id === upstreamId)) return res.status(400).json({ message: '所选上游不存在' });
  const previousUpstreamId = current.upstreamId;
  await store.mutate((state) => {
    const account = state.accounts.find((item) => item.id === req.params.id);
    account.upstreamId = upstreamId;
    account.updatedAt = new Date().toISOString();
    state.audit.unshift({ id: crypto.randomUUID(), type: 'account.upstream_changed', accountId: account.id, upstreamId, at: account.updatedAt, details: { previousUpstreamId } });
  });
  res.json({ account: sanitizeAccount(store.snapshot().accounts.find((item) => item.id === req.params.id)) });
}));

app.delete('/api/accounts/:id', asyncRoute(async (req, res) => {
  await store.mutate((data) => {
    data.accounts = data.accounts.filter((item) => item.id !== req.params.id);
    data.snapshots = data.snapshots.filter((item) => item.accountId !== req.params.id);
    data.incidents = data.incidents.filter((item) => item.accountId !== req.params.id);
  });
  res.status(204).end();
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
  const input = settingsSchema.parse(req.body);
  await store.mutate((data) => {
    data.settings = {
      ...data.settings,
      resendEnabled: input.resendEnabled,
      resendFrom: input.resendFrom,
      resendTo: input.resendTo,
      feishuEnabled: input.feishuEnabled,
      recoveryConfirmations: input.recoveryConfirmations,
      reminderHours: input.reminderHours,
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
  console.error(error);
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError) return res.status(400).json({ message: error.issues[0]?.message || '参数错误', issues: error.issues });
  if (error.statusCode) {
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.statusCode).json({ message: error.message });
  }
  res.status(500).json({ message: error.message || '服务器内部错误' });
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[frosted-console] http://localhost:${config.port}`);
});
