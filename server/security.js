import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verify } from 'otplib';
import { config } from './config.js';

function deriveEncryptionKey(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function buildEncryptionKeys() {
  if (!KEY_ID_PATTERN.test(config.masterKeyId)) {
    throw new Error('MASTER_KEY_ID must contain only letters, numbers, underscores, or hyphens');
  }
  const keys = new Map([[config.masterKeyId, deriveEncryptionKey(config.masterKey)]]);
  for (const { id, key } of config.previousMasterKeys) {
    if (!KEY_ID_PATTERN.test(id)) {
      throw new Error(`PREVIOUS_MASTER_KEYS contains an invalid key id: ${id}`);
    }
    if (keys.has(id)) {
      throw new Error(`Encryption key id is duplicated: ${id}`);
    }
    keys.set(id, deriveEncryptionKey(key));
  }
  return keys;
}

const encryptionKeys = buildEncryptionKeys();
const PASSWORD_ROUNDS = 12;
const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const pendingTwoFactorChallenges = new Map();

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}

function equalText(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyBootstrapToken(expected, candidate) {
  return Boolean(expected) && equalText(expected, candidate);
}

function createSignedToken(type, payload, ttlMs) {
  const body = encode(JSON.stringify({ ...payload, type, exp: Date.now() + ttlMs }));
  return `${body}.${sign(body)}`;
}

function readSignedToken(token, type) {
  if (!token) return null;
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature || !equalText(sign(payload), signature)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.type !== type || Number(data.exp) <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function challengeKey(jti) {
  return crypto.createHash('sha256').update(String(jti || '')).digest('base64url');
}

function pruneTwoFactorChallenges(now = Date.now()) {
  for (const [key, challenge] of pendingTwoFactorChallenges) {
    if (Number(challenge.exp) <= now) pendingTwoFactorChallenges.delete(key);
  }
}

export function encryptSecret(value) {
  if (!value || Object.keys(value).length === 0) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKeys.get(config.masterKeyId), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [config.masterKeyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload) {
  if (!payload) return {};
  const parts = String(payload).split('.');
  if (parts.length !== 3 && parts.length !== 4) throw new Error('密文格式无效');
  const versioned = parts.length === 4;
  const keyEntries = versioned
    ? [[parts[0], encryptionKeys.get(parts[0])]]
    : [...encryptionKeys.entries()];
  const [, ivValue, tagValue, encryptedValue] = versioned ? parts : ['', ...parts];
  let lastError;
  for (const [, key] of keyEntries) {
    if (!key) continue;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('密文无法使用已配置的主密钥解密', { cause: lastError });
}

export function passwordIssues(password) {
  const value = String(password || '');
  return [
    value.length < 12 && '至少 12 位',
    !/[a-z]/.test(value) && '包含小写字母',
    !/[A-Z]/.test(value) && '包含大写字母',
    !/\d/.test(value) && '包含数字',
    !/[^A-Za-z0-9]/.test(value) && '包含特殊符号',
  ].filter(Boolean);
}

export async function hashPassword(password) {
  const issues = passwordIssues(password);
  if (issues.length) throw new Error(`密码强度不足：${issues.join('、')}`);
  return bcrypt.hash(String(password), PASSWORD_ROUNDS);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(password || ''), hash);
}

export function normalizeUsername(username) {
  return String(username || '').trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function usernameMatches(candidate, auth) {
  return equalText(normalizeUsername(candidate), auth?.usernameCanonical || normalizeUsername(auth?.username));
}

export function createSessionToken(auth) {
  return createSignedToken('session', {
    username: auth.usernameCanonical || normalizeUsername(auth.username),
    version: Number(auth.sessionVersion || 1),
  }, 12 * 60 * 60 * 1000);
}

export function verifySessionToken(token, auth) {
  const data = readSignedToken(token, 'session');
  return Boolean(
    data
    && auth?.passwordHash
    && data.username === (auth.usernameCanonical || normalizeUsername(auth.username))
    && Number(data.version) === Number(auth.sessionVersion || 1),
  );
}

export function createTwoFactorChallenge(auth) {
  pruneTwoFactorChallenges();
  const username = auth.usernameCanonical || normalizeUsername(auth.username);
  const version = Number(auth.sessionVersion || 1);
  for (const [key, challenge] of pendingTwoFactorChallenges) {
    if (challenge.username === username && Number(challenge.version) === version) {
      pendingTwoFactorChallenges.delete(key);
    }
  }
  const jti = crypto.randomBytes(32).toString('base64url');
  const token = createSignedToken('two_factor', {
    jti,
    username,
    version,
  }, TWO_FACTOR_CHALLENGE_TTL_MS);
  const data = readSignedToken(token, 'two_factor');
  pendingTwoFactorChallenges.set(challengeKey(jti), {
    exp: data.exp,
    username: data.username,
    version: data.version,
  });
  return token;
}

export function verifyTwoFactorChallenge(token, auth) {
  const data = readSignedToken(token, 'two_factor');
  pruneTwoFactorChallenges();
  const pending = data?.jti ? pendingTwoFactorChallenges.get(challengeKey(data.jti)) : null;
  return Boolean(
    data
    && pending
    && auth?.twoFactorEnabled
    && data.username === (auth.usernameCanonical || normalizeUsername(auth.username))
    && Number(data.version) === Number(auth.sessionVersion || 1)
    && pending.username === data.username
    && Number(pending.version) === Number(data.version),
  );
}

export function consumeTwoFactorChallenge(token, auth) {
  const data = readSignedToken(token, 'two_factor');
  if (!data?.jti || !verifyTwoFactorChallenge(token, auth)) return false;
  return pendingTwoFactorChallenges.delete(challengeKey(data.jti));
}

export function createTotpEnrollment(username) {
  const secret = generateSecret();
  return {
    secret,
    uri: generateURI({ issuer: '霜镜上游监控', label: username, secret }),
  };
}

export async function verifyTotpCode(secret, code) {
  return Boolean((await verifyTotpCodeResult(secret, code)).valid);
}

export async function verifyTotpCodeResult(secret, code, afterTimeStep) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return { valid: false };
  return verify({
    secret,
    token: String(code).trim(),
    epochTolerance: 30,
    ...(Number.isInteger(afterTimeStep) && afterTimeStep >= 0 ? { afterTimeStep } : {}),
  });
}

export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

export function hashRecoveryCode(code) {
  const normalized = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return crypto.createHmac('sha256', config.sessionSecret).update(normalized).digest('hex');
}

export function consumeRecoveryCode(code, hashes = []) {
  const candidate = hashRecoveryCode(code);
  const index = hashes.findIndex((hash) => equalText(hash, candidate));
  if (index < 0) return { valid: false, hashes };
  return { valid: true, hashes: hashes.filter((_, current) => current !== index) };
}

export async function verifyTurnstileToken(token, remoteIp, expectedAction = 'login') {
  if (!config.dashboardTurnstileEnabled) return { skipped: true };
  if (!token) throw Object.assign(new Error('请先完成人机验证'), { statusCode: 400 });
  const form = new URLSearchParams({ secret: config.dashboardTurnstileSecretKey, response: String(token) });
  if (remoteIp) form.set('remoteip', String(remoteIp));
  let response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw Object.assign(new Error('人机验证服务暂时不可用，请稍后重试'), { statusCode: 503, code: 'TURNSTILE_UNAVAILABLE' });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success || (body.action && body.action !== expectedAction)) {
    throw Object.assign(new Error('人机验证失败或已过期，请重新验证'), { statusCode: 400, code: 'TURNSTILE_FAILED' });
  }
  return body;
}
