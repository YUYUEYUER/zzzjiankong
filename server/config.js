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

const turnstileSolver = String(process.env.TURNSTILE_SOLVER || "browser").toLowerCase();

export const config = {
  port: Number(process.env.PORT || 8787),
  appOrigin: process.env.APP_ORIGIN || "http://localhost:8787",
  dataFile: path.resolve(root, process.env.DATA_FILE || "./data/frosted-console.json"),
  masterKey: process.env.MASTER_KEY || "frosted-console-development-master-key",
  sessionSecret: process.env.SESSION_SECRET || "frosted-console-development-session-secret",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  authDisabled: process.env.AUTH_DISABLED === "true",
  trustProxy: process.env.TRUST_PROXY === "true",
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
  mihomoControllerUrl: String(process.env.MIHOMO_CONTROLLER_URL || 'http://127.0.0.1:9090').replace(/\/$/, ''),
  mihomoSecret: process.env.MIHOMO_SECRET || '',
  mihomoSharedDir: path.resolve(process.env.MIHOMO_SHARED_DIR || path.join(root, 'data', 'mihomo')),
  mihomoRuntimePath: process.env.MIHOMO_RUNTIME_PATH || path.resolve(process.env.MIHOMO_SHARED_DIR || path.join(root, 'data', 'mihomo'), 'config.yaml'),
  mihomoBindAddress: process.env.MIHOMO_BIND_ADDRESS || '127.0.0.1',
  mihomoControllerBindAddress: process.env.MIHOMO_CONTROLLER_BIND_ADDRESS || '127.0.0.1',
  upstreamProxyHost: process.env.UPSTREAM_PROXY_HOST || '127.0.0.1',
  proxyBasePort: Math.min(60000, Math.max(1024, Number(process.env.PROXY_BASE_PORT || 17890))),
  proxyImportMaxBytes: Math.min(10 * 1024 * 1024, Math.max(64 * 1024, Number(process.env.PROXY_IMPORT_MAX_BYTES || 2 * 1024 * 1024))),
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
