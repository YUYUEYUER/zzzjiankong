import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verify } from 'otplib';
import { config } from './config.js';

const encryptionKey = crypto.createHash('sha256').update(config.masterKey).digest();
const PASSWORD_ROUNDS = 12;

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

export function encryptSecret(value) {
  if (!value || Object.keys(value).length === 0) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(payload) {
  if (!payload) return {};
  const [iv, tag, encrypted] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
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
  return createSignedToken('two_factor', {
    username: auth.usernameCanonical || normalizeUsername(auth.username),
    version: Number(auth.sessionVersion || 1),
  }, 5 * 60 * 1000);
}

export function verifyTwoFactorChallenge(token, auth) {
  const data = readSignedToken(token, 'two_factor');
  return Boolean(
    data
    && auth?.twoFactorEnabled
    && data.username === (auth.usernameCanonical || normalizeUsername(auth.username))
    && Number(data.version) === Number(auth.sessionVersion || 1),
  );
}

export function createTotpEnrollment(username) {
  const secret = generateSecret();
  return {
    secret,
    uri: generateURI({ issuer: '霜镜上游监控', label: username, secret }),
  };
}

export async function verifyTotpCode(secret, code) {
  if (!/^\d{6}$/.test(String(code || '').trim())) return false;
  const result = await verify({ secret, token: String(code).trim(), epochTolerance: 30 });
  return Boolean(result.valid);
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
