import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

const LOGIN_TTL_MS = Math.max(2 * 60_000, Number(process.env.UPSTREAM_LOGIN_TTL_MS || 10 * 60_000));
const CAPTURE_TTL_MS = Math.max(LOGIN_TTL_MS, Number(process.env.UPSTREAM_CAPTURE_TTL_MS || 30 * 60_000));
const jobs = new Map();
const activeOrigins = new Map();

function normalizedKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenValue(value) {
  return typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : '';
}

export function extractSub2SessionTokens(value, result = {}, depth = 0, seen = new WeakSet()) {
  if (depth > 10 || value == null) return result;
  if (typeof value === 'string') {
    const text = value.trim();
    if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2_000_000) {
      try {
        return extractSub2SessionTokens(JSON.parse(text), result, depth + 1, seen);
      } catch {
        return result;
      }
    }
    return result;
  }
  if (typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (typeof item === 'string') {
      if (['accesstoken', 'authtoken'].includes(normalized)) result.accessToken = tokenValue(item);
      if (normalized === 'refreshtoken') result.refreshToken = tokenValue(item);
    }
    extractSub2SessionTokens(item, result, depth + 1, seen);
  }
  return result;
}

function loginOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('上游地址必须是 HTTP(S) 站点'), { statusCode: 400 });
  }
  return url.origin;
}

function profileId(origin) {
  return crypto.createHash('sha256').update(origin).digest('hex').slice(0, 24);
}

function profileDirectory(id) {
  return path.join(path.dirname(config.dataFile), 'upstream-browser-profiles', `${id}-system-chrome`);
}

export function resolveSystemBrowser() {
  const configured = String(process.env.UPSTREAM_BROWSER_PATH || '').trim();
  const localAppData = String(process.env.LOCALAPPDATA || '').trim();
  const programFiles = String(process.env.ProgramFiles || 'C:\\Program Files').trim();
  const programFilesX86 = String(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)').trim();
  const candidates = [
    configured && { executablePath: configured, name: 'Chrome' },
    process.platform === 'win32' && { executablePath: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Chrome' },
    process.platform === 'win32' && { executablePath: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Chrome' },
    process.platform === 'win32' && localAppData && { executablePath: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'), name: 'Chrome' },
    process.platform === 'win32' && { executablePath: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Edge' },
    process.platform === 'win32' && { executablePath: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), name: 'Edge' },
    process.platform !== 'win32' && { executablePath: '/usr/bin/google-chrome', name: 'Chrome' },
    process.platform !== 'win32' && { executablePath: '/usr/bin/google-chrome-stable', name: 'Chrome' },
    process.platform !== 'win32' && { executablePath: '/usr/bin/chromium', name: 'Chromium' },
    process.platform !== 'win32' && { executablePath: '/usr/bin/chromium-browser', name: 'Chromium' },
    process.platform !== 'win32' && { executablePath: chromium.executablePath(), name: 'Chromium' },
  ].filter(Boolean);
  return candidates.find(({ executablePath }) => existsSync(executablePath)) || null;
}

async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

export function buildSystemBrowserArgs(job, port) {
  const targetUrl = job.targetUrl || `${job.origin}/login`;
  return [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${job.profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--new-window',
    targetUrl,
  ];
}

export function browserCookiesFromHeader(origin, cookieHeader = '') {
  const url = `${loginOrigin(origin)}/`;
  const cookies = new Map();
  for (const segment of String(cookieHeader || '').replace(/[\r\n]/g, '').split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    const name = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    cookies.set(name, { name, value, url });
  }
  return [...cookies.values()];
}

export async function clearStaleBrowserLocks(profilePath) {
  await Promise.all([
    'DevToolsActivePort',
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
  ].map((name) => fs.rm(path.join(profilePath, name), { force: true })));
}

async function connectVisibleSystemBrowser(job) {
  const installed = resolveSystemBrowser();
  if (!installed) {
    throw new Error('未找到系统 Chrome 或 Edge，请安装浏览器或配置 UPSTREAM_BROWSER_PATH');
  }

  await clearStaleBrowserLocks(job.profilePath);
  const port = await freeLoopbackPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const browserProcess = spawn(installed.executablePath, buildSystemBrowserArgs(job, port), {
    stdio: 'ignore',
    windowsHide: false,
  });
  let launchError = null;
  browserProcess.once('error', (error) => { launchError = error; });

  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) break;
    if (browserProcess.exitCode != null) break;
    ready = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(750),
    }).then((response) => response.ok).catch(() => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) {
    if (browserProcess.exitCode == null) browserProcess.kill();
    throw launchError || new Error(`${installed.name} 启动后未能建立本地会话连接`);
  }

  try {
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('浏览器上下文未建立');
    return { browser, browserProcess, context, browserEngine: installed.name };
  } catch (error) {
    if (browserProcess.exitCode == null) browserProcess.kill();
    throw error;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    origin: job.origin,
    status: job.status,
    captureMode: job.captureMode || '',
    hasAccessToken: Boolean(job.candidate?.accessToken || job.secret?.accessToken),
    hasRefreshToken: Boolean(job.candidate?.refreshToken || job.secret?.refreshToken),
    hasCookies: Boolean(job.hasCookies || job.secret?.sessionCookie),
    message: job.message || '',
    error: job.error || '',
    browserEngine: job.browserEngine || '',
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    capturedAt: job.capturedAt || '',
  };
}

async function browserSession(context, origin) {
  const cookies = await context.cookies(origin).catch(() => []);
  return {
    cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    hasCookies: cookies.length > 0,
  };
}

async function pageStorageTokens(page, origin) {
  if (new URL(page.url()).origin !== origin) return {};
  return page.evaluate(() => {
    const read = (storage, names) => {
      for (const name of names) {
        const value = storage.getItem(name);
        if (value) return value;
      }
      return '';
    };
    return {
      accessToken: read(localStorage, ['auth_token', 'access_token', 'accessToken']),
      refreshToken: read(localStorage, ['refresh_token', 'refreshToken']),
      hasAuthUser: Boolean(localStorage.getItem('auth_user')),
    };
  }).catch(() => ({}));
}

async function profileVerified(page, origin, accessToken = '') {
  if (new URL(page.url()).origin !== origin) return false;
  return page.evaluate(async ({ root, token }) => {
    for (const path of ['/api/v1/auth/me', '/api/v1/user/profile', '/api/v1/users/me']) {
      try {
        const response = await fetch(`${root}${path}`, {
          credentials: 'include',
          headers: token ? { Accept: 'application/json', Authorization: `Bearer ${token}` } : { Accept: 'application/json' },
        });
        if (response.ok) return true;
        if ([401, 403].includes(response.status)) return false;
      } catch {
        // Try the next compatible profile path.
      }
    }
    return false;
  }, { root: origin, token: accessToken }).catch(() => false);
}

async function captureJob(job, page, tokens = {}) {
  if (job.status === 'captured' || job.status === 'consumed' || job.status === 'cancelled') return;
  job.candidate = {
    accessToken: tokens.accessToken || job.candidate?.accessToken || '',
    refreshToken: tokens.refreshToken || job.candidate?.refreshToken || '',
  };
  const session = await browserSession(job.context, job.origin);
  job.hasCookies = session.hasCookies;
  const accessToken = job.candidate.accessToken;
  const verified = await profileVerified(page, job.origin, accessToken);

  if (!accessToken && !verified) {
    if (job.candidate.refreshToken) job.message = '已发现 Refresh Token，继续等待完整登录态';
    return;
  }

  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  job.secret = {
    ...(accessToken ? { accessToken } : {}),
    ...(job.candidate.refreshToken ? { refreshToken: job.candidate.refreshToken } : {}),
    ...(session.cookieHeader ? { sessionCookie: session.cookieHeader } : {}),
    ...(userAgent ? { sessionUserAgent: userAgent } : {}),
    sessionCapturedAt: new Date().toISOString(),
    browserProfileId: job.profileId,
    browserSessionOrigin: job.origin,
  };
  job.captureMode = accessToken ? 'tokens' : 'cookies';
  job.status = 'captured';
  job.capturedAt = new Date().toISOString();
  job.expiresAt = new Date(Date.now() + CAPTURE_TTL_MS).toISOString();
  job.message = accessToken
    ? `登录成功，已取得${job.secret.refreshToken ? ' AT + RT' : ' AT'}${session.hasCookies ? ' 与浏览器 Cookie' : ''}`
    : '登录成功，已取得浏览器 Cookie';
  clearInterval(job.pollTimer);
  clearTimeout(job.timeoutTimer);
}

async function scanJob(job) {
  if (job.scanning || !['opening', 'waiting'].includes(job.status) || !job.context) return;
  job.scanning = true;
  try {
    for (const page of job.context.pages()) {
      let pageOrigin = '';
      try {
        pageOrigin = new URL(page.url()).origin;
      } catch {
        continue;
      }
      if (pageOrigin !== job.origin) continue;
      const tokens = await pageStorageTokens(page, job.origin);
      await captureJob(job, page, tokens);
      if (job.status === 'captured') break;
    }
  } finally {
    job.scanning = false;
  }
}

function watchPage(job, page) {
  page.on('response', async (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== job.origin || !/\/api\/v1\/auth\/(?:login|refresh)$/.test(url.pathname)) return;
      const payload = await response.json();
      const tokens = extractSub2SessionTokens(payload);
      await captureJob(job, page, tokens);
    } catch {
      // The storage scanner remains the fallback.
    }
  });
}

async function closeJobBrowser(job) {
  clearInterval(job.pollTimer);
  clearTimeout(job.timeoutTimer);
  const browser = job.browser;
  const browserProcess = job.browserProcess;
  job.closing = true;
  job.browser = null;
  job.browserProcess = null;
  job.context = null;
  if (job.purpose === 'browse') job.savedCookieHeader = '';
  if (browser) await browser.close().catch(() => {});
  if (browserProcess?.exitCode == null) browserProcess.kill();
  job.closing = false;
  if (activeOrigins.get(job.origin) === job.id) activeOrigins.delete(job.origin);
}

async function runJob(job) {
  try {
    await fs.mkdir(job.profilePath, { recursive: true });
    const { browser, browserProcess, context, browserEngine } = await connectVisibleSystemBrowser(job);
    job.browser = browser;
    job.browserProcess = browserProcess;
    job.browserEngine = browserEngine;
    job.context = context;
    if (job.purpose !== 'browse') context.on('page', (page) => watchPage(job, page));
    browser.on('disconnected', () => {
      job.context = null;
      job.browser = null;
      if (activeOrigins.get(job.origin) === job.id) activeOrigins.delete(job.origin);
      if (!job.closing && !['captured', 'consumed', 'cancelled', 'expired'].includes(job.status)) {
        job.status = 'closed';
        job.message = job.purpose === 'browse'
          ? '上游浏览器窗口已关闭'
          : '浏览器窗口已关闭，尚未检测到有效登录态';
      }
    });
    const pages = context.pages();
    const page = pages.find((candidate) => {
      try {
        return new URL(candidate.url()).origin === job.origin;
      } catch {
        return false;
      }
    }) || pages[0] || await context.newPage();
    if (job.purpose === 'browse') {
      const cookies = browserCookiesFromHeader(job.origin, job.savedCookieHeader);
      job.savedCookieHeader = '';
      if (cookies.length) await context.addCookies(cookies);
      await page.goto(job.targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(async () => {
        await page.goto(job.origin, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      });
      await page.bringToFront().catch(() => {});
      job.status = 'opened';
      job.message = cookies.length ? '已复用浏览器登录态打开上游' : '已使用原浏览器配置打开上游';
      return;
    }

    for (const currentPage of context.pages()) watchPage(job, currentPage);
    job.status = 'waiting';
    job.message = `请在弹出的系统 ${browserEngine} 中完成 Cloudflare 验证与账号登录`;
    await page.bringToFront().catch(() => {});
    let currentOrigin = '';
    try {
      currentOrigin = new URL(page.url()).origin;
    } catch {
      currentOrigin = '';
    }
    if (currentOrigin !== job.origin) {
      await page.goto(`${job.origin}/login`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(async () => {
        await page.goto(job.origin, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      });
    }
    await scanJob(job);
    if (job.status !== 'captured') {
      job.pollTimer = setInterval(() => { scanJob(job).catch(() => {}); }, 750);
      job.timeoutTimer = setTimeout(async () => {
        if (!['opening', 'waiting'].includes(job.status)) return;
        job.status = 'expired';
        job.message = '登录窗口等待超时，请重新发起';
        await closeJobBrowser(job);
      }, LOGIN_TTL_MS);
    }
  } catch (error) {
    job.status = 'failed';
    job.error = String(error?.message || error || '浏览器启动失败');
    job.message = '内置浏览器启动失败';
    await closeJobBrowser(job);
  }
}

export function startUpstreamLogin({ type = 'sub2api', baseUrl }) {
  if (type !== 'sub2api') throw Object.assign(new Error('当前仅支持 Sub2API 浏览器登录'), { statusCode: 400 });
  const origin = loginOrigin(baseUrl);
  const existingId = activeOrigins.get(origin);
  const existing = existingId ? jobs.get(existingId) : null;
  if (existing?.purpose === 'browse' && ['opening', 'opened'].includes(existing.status)) {
    throw Object.assign(new Error('请先关闭已打开的上游窗口，再发起新的浏览器登录'), { statusCode: 409 });
  }
  if (existing && ['opening', 'waiting', 'captured'].includes(existing.status)) return publicJob(existing);

  const id = crypto.randomUUID();
  const browserProfileId = profileId(origin);
  const now = new Date();
  const job = {
    id,
    type,
    origin,
    profileId: browserProfileId,
    profilePath: profileDirectory(browserProfileId),
    status: 'opening',
    message: '正在打开系统浏览器',
    error: '',
    browserEngine: '',
    candidate: { accessToken: '', refreshToken: '' },
    secret: null,
    hasCookies: false,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOGIN_TTL_MS).toISOString(),
    capturedAt: '',
    context: null,
    browser: null,
    browserProcess: null,
    closing: false,
    pollTimer: null,
    timeoutTimer: null,
    scanning: false,
  };
  jobs.set(id, job);
  activeOrigins.set(origin, id);
  runJob(job).catch(() => {});
  return publicJob(job);
}

export function startUpstreamBrowserSession({ type = 'sub2api', baseUrl, sessionCookie = '' }) {
  if (type !== 'sub2api') throw Object.assign(new Error('当前仅支持 Sub2API 浏览器会话'), { statusCode: 400 });
  const origin = loginOrigin(baseUrl);
  const existingId = activeOrigins.get(origin);
  const existing = existingId ? jobs.get(existingId) : null;
  if (existing && ['opening', 'waiting', 'captured', 'opened'].includes(existing.status)) {
    const page = existing.context?.pages().find((candidate) => {
      try {
        return new URL(candidate.url()).origin === origin;
      } catch {
        return false;
      }
    });
    page?.bringToFront().catch(() => {});
    return publicJob(existing);
  }

  const id = crypto.randomUUID();
  const browserProfileId = profileId(origin);
  const now = new Date();
  const job = {
    id,
    type,
    origin,
    purpose: 'browse',
    targetUrl: `${origin}/`,
    savedCookieHeader: String(sessionCookie || ''),
    profileId: browserProfileId,
    profilePath: profileDirectory(browserProfileId),
    status: 'opening',
    message: '正在用原浏览器登录态打开上游',
    error: '',
    browserEngine: '',
    candidate: { accessToken: '', refreshToken: '' },
    secret: null,
    hasCookies: Boolean(sessionCookie),
    createdAt: now.toISOString(),
    expiresAt: '',
    capturedAt: '',
    context: null,
    browser: null,
    browserProcess: null,
    closing: false,
    pollTimer: null,
    timeoutTimer: null,
    scanning: false,
  };
  jobs.set(id, job);
  activeOrigins.set(origin, id);
  runJob(job).catch(() => {});
  return publicJob(job);
}

export function getUpstreamLogin(id) {
  const job = jobs.get(String(id || ''));
  if (!job) throw Object.assign(new Error('登录任务不存在或已经过期'), { statusCode: 404 });
  if (Date.parse(job.expiresAt) <= Date.now() && job.status === 'captured') {
    job.status = 'expired';
    job.secret = null;
    job.message = '捕获的登录态已过期，请重新登录';
    closeJobBrowser(job).catch(() => {});
  }
  return publicJob(job);
}

export function getUpstreamLoginCredential(id, expectedBaseUrl) {
  const job = jobs.get(String(id || ''));
  if (!job || job.status !== 'captured' || !job.secret) {
    throw Object.assign(new Error('内置浏览器尚未取得有效登录态'), { statusCode: 409 });
  }
  if (expectedBaseUrl && job.origin !== loginOrigin(expectedBaseUrl)) {
    throw Object.assign(new Error('浏览器登录态与账号上游地址不一致'), { statusCode: 409 });
  }
  return { ...job.secret };
}

export function updateUpstreamLoginCredential(id, secret = {}) {
  const job = jobs.get(String(id || ''));
  if (!job || job.status !== 'captured' || !job.secret) return;
  job.secret = { ...job.secret, ...secret };
}

export async function consumeUpstreamLogin(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return;
  job.status = 'consumed';
  job.secret = null;
  job.message = '登录态已加密保存到监控账号';
  await closeJobBrowser(job);
  setTimeout(() => jobs.delete(job.id), 60_000).unref?.();
}

export async function cancelUpstreamLogin(id) {
  const job = jobs.get(String(id || ''));
  if (!job) return false;
  job.status = 'cancelled';
  job.secret = null;
  job.message = '登录任务已取消';
  await closeJobBrowser(job);
  setTimeout(() => jobs.delete(job.id), 60_000).unref?.();
  return true;
}

export async function shutdownUpstreamLogins() {
  const activeJobs = [...jobs.values()].filter((job) => job.context || job.browserProcess);
  await Promise.allSettled(activeJobs.map(async (job) => {
    job.status = 'cancelled';
    job.secret = null;
    await closeJobBrowser(job);
  }));
  activeOrigins.clear();
  jobs.clear();
}
