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
  seedDemo: process.env.SEED_DEMO !== "false",
  monitorTickMs: Math.max(5000, Number(process.env.MONITOR_TICK_MS || 15000)),
  production: process.env.NODE_ENV === "production",
  /** none | browser | capsolver | 2captcha — default browser (DOM + human-like) */
  turnstileSolver,
  turnstileSolverApiKey: resolveTurnstileApiKey(turnstileSolver),
  turnstileSolveTimeoutMs: Math.max(30000, Number(process.env.TURNSTILE_SOLVE_TIMEOUT_MS || 120000)),
  /** Run Chromium headless; set TURNSTILE_HEADLESS=false to watch the browser */
  turnstileHeadless: process.env.TURNSTILE_HEADLESS !== "false",
};

config.dashboardTurnstileEnabled = Boolean(config.dashboardTurnstileSiteKey && config.dashboardTurnstileSecretKey);

if (config.production && config.authDisabled) {
  console.warn("[security] AUTH_DISABLED=true; dashboard authentication is disabled.");
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
