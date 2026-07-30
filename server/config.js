import "dotenv/config";
import path from "node:path";

const root = process.cwd();

function resolveTurnstileApiKey(solver) {
  const normalized = String(solver || "none").toLowerCase();
  if (normalized === "capsolver") {
    return process.env.CAPSOLVER_API_KEY || process.env.TURNSTILE_SOLVER_API_KEY || "";
  }
  if (normalized === "2captcha" || normalized === "twocaptcha") {
    return process.env.TWOCAPTCHA_API_KEY || process.env.TURNSTILE_SOLVER_API_KEY || "";
  }
  return process.env.TURNSTILE_SOLVER_API_KEY || "";
}

function browserWorkspaceUrl(value) {
  const url = String(value || "").trim();
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
    return loopback && ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : "";
  } catch {
    return "";
  }
}

const turnstileSolver = String(process.env.TURNSTILE_SOLVER || "browser").toLowerCase();

function commaSeparated(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function previousMasterKeys(value) {
  return String(value || '').split(',').map((entry) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) return null;
    const id = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1);
    return id && key ? { id, key } : null;
  }).filter(Boolean);
}

const masterKeyId = String(process.env.MASTER_KEY_ID || 'active').trim();
const previousKeys = previousMasterKeys(process.env.PREVIOUS_MASTER_KEYS);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(masterKeyId)) {
  throw new Error('MASTER_KEY_ID must contain only letters, numbers, underscores, or hyphens');
}
if (previousKeys.some(({ id }) => !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
  throw new Error('PREVIOUS_MASTER_KEYS contains an invalid key id');
}
if (previousKeys.some(({ id }) => id === masterKeyId) || new Set(previousKeys.map(({ id }) => id)).size !== previousKeys.length) {
  throw new Error('PREVIOUS_MASTER_KEYS contains a duplicated key id');
}

export const config = {
  port: Number(process.env.PORT || 8787),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:8787",
  dataFile: path.resolve(root, process.env.DATA_FILE || "./data/frosted-console.json"),
  masterKey: process.env.MASTER_KEY || "frosted-console-development-master-key",
  masterKeyId,
  previousMasterKeys: previousKeys,
  sessionSecret: process.env.SESSION_SECRET || "frosted-console-development-session-secret",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  bootstrapToken: process.env.BOOTSTRAP_TOKEN || "",
  authDisabled: process.env.AUTH_DISABLED === "true",
  trustProxy: process.env.TRUST_PROXY === "true",
  browserWorkspaceUrl: browserWorkspaceUrl(process.env.BROWSER_WORKSPACE_URL),
  dashboardTurnstileSiteKey: process.env.DASHBOARD_TURNSTILE_SITE_KEY || "",
  dashboardTurnstileSecretKey: process.env.DASHBOARD_TURNSTILE_SECRET_KEY || "",
  seedDemo: process.env.SEED_DEMO
    ? process.env.SEED_DEMO !== "false"
    : process.env.NODE_ENV !== "production",
  monitorTickMs: Math.max(5000, Number(process.env.MONITOR_TICK_MS || 15000)),
  production: process.env.NODE_ENV === "production",
  /** none | browser | capsolver | 2captcha — default browser (DOM + human-like) */
  turnstileSolver,
  turnstileSolverApiKey: resolveTurnstileApiKey(turnstileSolver),
  turnstileSolveTimeoutMs: Math.max(30000, Number(process.env.TURNSTILE_SOLVE_TIMEOUT_MS || 120000)),
  /** Keep challenge handling visible by default so a human can complete interactive checks. */
  turnstileHeadless: process.env.TURNSTILE_HEADLESS === "true",
  /** Only for isolated containers that cannot enable the Chromium sandbox. */
  turnstileDisableBrowserSandbox: process.env.TURNSTILE_DISABLE_BROWSER_SANDBOX === "true",
  /** Global Chromium process cap across different upstream origins. */
  turnstileBrowserConcurrency: Math.min(4, Math.max(1, Number(process.env.TURNSTILE_BROWSER_CONCURRENCY || 2))),
  turnstileBrowserQueueLimit: Math.min(200, Math.max(1, Number(process.env.TURNSTILE_BROWSER_QUEUE_LIMIT || 20))),
  upstreamBrowserSessionTtlMs: Math.max(1, Number(process.env.UPSTREAM_BROWSER_SESSION_TTL_HOURS || 168)) * 3600000,
  upstreamBrowserMaxActive: Math.min(8, Math.max(1, Number(process.env.UPSTREAM_BROWSER_MAX_ACTIVE || 2))),
  upstreamBrowserAbsoluteTtlMs: Math.min(
    24 * 3600000,
    Math.max(10 * 60_000, Number(process.env.UPSTREAM_BROWSER_ABSOLUTE_TTL_MINUTES || 720) * 60_000),
  ),
  upstreamBrowserSweepIntervalMs: Math.min(
    60_000,
    Math.max(1000, Number(process.env.UPSTREAM_BROWSER_SWEEP_INTERVAL_MS || 15_000)),
  ),
  upstreamBrowserResultRetentionMs: Math.min(
    60 * 60_000,
    Math.max(60_000, Number(process.env.UPSTREAM_BROWSER_RESULT_RETENTION_MS || 5 * 60_000)),
  ),
  browserGatewayMaxConnections: Math.min(16, Math.max(1, Number(process.env.BROWSER_GATEWAY_MAX_CONNECTIONS || 4))),
  browserGatewayIdleTtlMs: Math.min(
    60 * 60_000,
    Math.max(60_000, Number(process.env.BROWSER_GATEWAY_IDLE_TTL_MINUTES || 15) * 60_000),
  ),
  mihomoControllerUrl: String(process.env.MIHOMO_CONTROLLER_URL || 'http://127.0.0.1:9090').replace(/\/$/, ''),
  mihomoSecret: process.env.MIHOMO_SECRET || '',
  mihomoSharedDir: path.resolve(process.env.MIHOMO_SHARED_DIR || path.join(root, 'data', 'mihomo')),
  mihomoRuntimePath: process.env.MIHOMO_RUNTIME_PATH || path.resolve(process.env.MIHOMO_SHARED_DIR || path.join(root, 'data', 'mihomo'), 'config.yaml'),
  mihomoBindAddress: process.env.MIHOMO_BIND_ADDRESS || '127.0.0.1',
  mihomoControllerBindAddress: process.env.MIHOMO_CONTROLLER_BIND_ADDRESS || '127.0.0.1',
  upstreamProxyHost: process.env.UPSTREAM_PROXY_HOST || '127.0.0.1',
  proxyBasePort: Math.min(60000, Math.max(1024, Number(process.env.PROXY_BASE_PORT || 17890))),
  proxyImportMaxBytes: Math.min(10 * 1024 * 1024, Math.max(64 * 1024, Number(process.env.PROXY_IMPORT_MAX_BYTES || 2 * 1024 * 1024))),
  upstreamResponseMaxBytes: Math.min(10 * 1024 * 1024, Math.max(64 * 1024, Number(process.env.UPSTREAM_RESPONSE_MAX_BYTES || 2 * 1024 * 1024))),
  upstreamAllowedHosts: commaSeparated(process.env.UPSTREAM_ALLOWED_HOSTS),
  enforceUpstreamNetworkPolicy: process.env.ENFORCE_UPSTREAM_NETWORK_POLICY
    ? process.env.ENFORCE_UPSTREAM_NETWORK_POLICY !== 'false'
    : process.env.NODE_ENV === 'production',
  notificationOutboxTickMs: Math.max(1000, Number(process.env.NOTIFICATION_OUTBOX_TICK_MS || 5000)),
  notificationOutboxLeaseMs: Math.max(10_000, Number(process.env.NOTIFICATION_OUTBOX_LEASE_MS || 60_000)),
  notificationOutboxMaxAttempts: Math.min(20, Math.max(1, Number(process.env.NOTIFICATION_OUTBOX_MAX_ATTEMPTS || 8))),
  backupDir: path.resolve(root, process.env.BACKUP_DIR || './data/backups'),
};

config.dashboardTurnstileEnabled = Boolean(config.dashboardTurnstileSiteKey && config.dashboardTurnstileSecretKey);

if (config.production && config.authDisabled) {
  console.warn("[security] AUTH_DISABLED=true; dashboard authentication is disabled.");
}

if (config.production && (
  config.masterKey === "frosted-console-development-master-key"
  || config.sessionSecret === "frosted-console-development-session-secret"
  || config.masterKey.startsWith("replace-with-")
  || config.sessionSecret.startsWith("replace-with-")
)) {
  throw new Error("生产环境必须显式配置 MASTER_KEY 与 SESSION_SECRET，禁止使用开发默认值");
}

if (config.production && (config.masterKey.length < 32 || config.sessionSecret.length < 32)) {
  throw new Error('Production MASTER_KEY and SESSION_SECRET must each be at least 32 characters');
}
if (config.production && config.previousMasterKeys.some(({ key }) => key.length < 32)) {
  throw new Error('Production PREVIOUS_MASTER_KEYS values must each be at least 32 characters');
}

if (config.production && config.turnstileDisableBrowserSandbox) {
  console.warn("[security] Chromium sandbox is disabled; run the solver in a dedicated low-privilege container.");
}

if (config.turnstileSolver === "browser") {
  console.info(
    `[turnstile] browser solver enabled (headless=${config.turnstileHeadless}); requires: npx playwright install chromium`,
  );
} else if (config.turnstileSolver !== "none" && !config.turnstileSolverApiKey) {
  console.warn(
    `[turnstile] TURNSTILE_SOLVER=${config.turnstileSolver} but API key is empty; auto-solve disabled.`,
  );
}
