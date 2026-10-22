import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const iso = (offsetMinutes = 0) => new Date(Date.now() + offsetMinutes * 60000).toISOString();
const STORE_VERSION = 4;
/** audit 只保留最新 N 条；在事务层统一截断，防止各写入点遗漏上限导致文件膨胀。 */
const AUDIT_RETENTION_LIMIT = 500;

function defaultProxyPool() {
  return {
    subscriptionUrlEncrypted: '',
    subscriptionUpdatedAt: null,
    lastCheckedAt: null,
    lastError: '',
    nodes: [],
  };
}

function withProxyDefaults(upstream) {
  return {
    proxyMode: 'direct',
    proxyNodeName: '',
    proxyPort: null,
    proxyAssignedAt: null,
    ...upstream,
  };
}

function defaultSettings() {
  return {
    resendEnabled: false,
    resendFrom: "霜镜告警 <alerts@example.com>",
    resendTo: "",
    resendApiKeyEncrypted: "",
    feishuEnabled: false,
    feishuWebhookEncrypted: "",
    telegramEnabled: false,
    telegramChatId: "",
    telegramBotTokenEncrypted: "",
    wecomEnabled: false,
    wecomWebhookEncrypted: "",
    depletionAlertDays: 0,
    recoveryConfirmations: 2,
    reminderMinutes: 360,
  };
}

function migrateReminderSettings(settings) {
  const configuredMinutes = Number(settings.reminderMinutes);
  const legacyHours = Number(settings.reminderHours);
  settings.reminderMinutes = Number.isInteger(configuredMinutes) && configuredMinutes >= 1 && configuredMinutes <= 10080
    ? configuredMinutes
    : Number.isFinite(legacyHours) && legacyHours > 0
      ? Math.min(10080, Math.max(1, Math.round(legacyHours * 60)))
      : 360;
  delete settings.reminderHours;
}

function defaultAuth() {
  return {
    username: '',
    usernameCanonical: '',
    passwordHash: '',
    twoFactorEnabled: false,
    totpSecretEncrypted: '',
    pendingTotpEncrypted: '',
    pendingTotpCreatedAt: null,
    recoveryCodeHashes: [],
    lastAcceptedTotpCounter: null,
    sessionVersion: 1,
    createdAt: null,
    updatedAt: null,
  };
}

function history(accountId, start, steps = 14) {
  return Array.from({ length: steps }, (_, index) => ({
    id: crypto.randomUUID(),
    accountId,
    rawBalance: Math.max(0, start - index * (start * 0.035) + (index % 3) * 2.2),
    convertedCny: Math.max(0, start - index * (start * 0.035) + (index % 3) * 2.2),
    capturedAt: iso(-(steps - index) * 720),
  }));
}

function demoAccount(input) {
  return {
    id: input.id,
    upstreamId: input.upstreamId,
    name: input.name,
    type: input.type,
    baseUrl: input.baseUrl || "",
    region: input.region,
    subgroup: input.subgroup,
    authMode: input.authMode || "access_token",
    tokenStrategy: input.tokenStrategy || "sticky",
    userId: "",
    balancePath: input.type === "newapi" ? "data.quota" : "data.balance",
    formula: input.formula || "x",
    rawUnit: input.rawUnit || "CNY",
    thresholdLow: input.thresholdLow ?? 20,
    thresholdRecover: input.thresholdRecover ?? 50,
    pollIntervalMinutes: 5,
    notifications: { resend: true, feishu: true, telegram: true, wecom: true },
    enabled: input.enabled ?? true,
    demo: true,
    encryptedSecret: "",
    rawBalance: input.rawBalance,
    convertedCny: input.convertedCny,
    status: input.status || "healthy",
    lastSyncAt: iso(-2),
    lastError: "",
    recoveryChecks: input.recoveryChecks || 0,
    createdAt: iso(-10080),
    updatedAt: iso(-2),
  };
}

function demoUpstream(id, name) {
  return withProxyDefaults({
    id,
    name,
    createdAt: iso(-10080),
    updatedAt: iso(-2),
  });
}

export function deriveInitialUpstream(account, idFactory = () => crypto.randomUUID()) {
  const timestamp = account.createdAt || new Date().toISOString();
  return withProxyDefaults({
    id: idFactory(),
    name: String(account.name || '未命名上游').trim() || '未命名上游',
    createdAt: timestamp,
    updatedAt: account.updatedAt || timestamp,
  });
}

function normalizeDataShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据文件格式无效');
  if (!Array.isArray(data.accounts)) throw new Error('数据文件缺少 accounts 数组');
  for (const key of ['snapshots', 'incidents', 'audit', 'notificationOutbox']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  if (!data.settings || typeof data.settings !== 'object') data.settings = {};
  if (!data.auth || typeof data.auth !== 'object') data.auth = defaultAuth();
  if (!data.proxyPool || typeof data.proxyPool !== 'object') data.proxyPool = defaultProxyPool();
  data.proxyPool = { ...defaultProxyPool(), ...data.proxyPool };
  if (!Array.isArray(data.proxyPool.nodes)) data.proxyPool.nodes = [];
  data.auth = { ...defaultAuth(), ...data.auth };
  if (!Array.isArray(data.auth.recoveryCodeHashes)) data.auth.recoveryCodeHashes = [];
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 格式无效`);
  }
}

function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    assertObject(item, label);
    const id = String(item.id || '').trim();
    if (!id) throw new Error(`${label} 缺少 id`);
    if (ids.has(id)) throw new Error(`${label} id 重复：${id}`);
    ids.add(id);
  }
  return ids;
}

export function validateDataGraph(data) {
  assertObject(data, '数据文件');
  if (Number(data.version) !== STORE_VERSION) throw new Error(`数据版本必须为 ${STORE_VERSION}`);
  for (const key of ['upstreams', 'accounts', 'snapshots', 'incidents', 'audit', 'notificationOutbox']) {
    if (!Array.isArray(data[key])) throw new Error(`数据文件缺少 ${key} 数组`);
  }
  assertObject(data.settings, 'settings');
  if (!Number.isInteger(data.settings.reminderMinutes) || data.settings.reminderMinutes < 1 || data.settings.reminderMinutes > 10080) {
    throw new Error('settings.reminderMinutes 必须是 1–10080 的整数');
  }
  assertObject(data.auth, 'auth');
  assertObject(data.proxyPool, 'proxyPool');
  if (!Array.isArray(data.proxyPool.nodes)) throw new Error('proxyPool 缺少 nodes 数组');
  if (!Array.isArray(data.auth.recoveryCodeHashes)) throw new Error('auth 缺少 recoveryCodeHashes 数组');

  const upstreamIds = uniqueIds(data.upstreams, '上游');
  const accountIds = uniqueIds(data.accounts, '账号');
  const snapshotIds = uniqueIds(data.snapshots, '快照');
  const incidentIds = uniqueIds(data.incidents, '事件');
  uniqueIds(data.audit, '审计记录');
  uniqueIds(data.notificationOutbox, '通知事件');

  const upstreamNames = new Set();
  for (const upstream of data.upstreams) {
    const canonical = String(upstream.name || '').trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
    if (!canonical) throw new Error(`上游 ${upstream.id || 'unknown'} 缺少有效名称`);
    if (upstreamNames.has(canonical)) throw new Error(`上游名称重复：${upstream.name}`);
    upstreamNames.add(canonical);
  }

  for (const account of data.accounts) {
    if (!account.upstreamId || !upstreamIds.has(account.upstreamId)) {
      throw new Error(`账号 ${account.id || account.name || 'unknown'} 未关联有效上游`);
    }
  }
  for (const snapshot of data.snapshots) {
    if (!snapshot.accountId || !accountIds.has(snapshot.accountId)) {
      throw new Error(`快照 ${snapshot.id || 'unknown'} 未关联有效账号`);
    }
  }
  for (const incident of data.incidents) {
    if (!incident.accountId || !accountIds.has(incident.accountId)) {
      throw new Error(`事件 ${incident.id || 'unknown'} 未关联有效账号`);
    }
  }
  for (const event of data.notificationOutbox) {
    if (event.accountId && !accountIds.has(event.accountId)) {
      throw new Error(`通知事件 ${event.id || 'unknown'} 未关联有效账号`);
    }
    if (event.incidentId && !incidentIds.has(event.incidentId)) {
      throw new Error(`通知事件 ${event.id || 'unknown'} 未关联有效事件`);
    }
    if (event.upstreamId && !upstreamIds.has(event.upstreamId)) {
      throw new Error(`通知事件 ${event.id || 'unknown'} 未关联有效上游`);
    }
  }

  return { upstreamIds, accountIds, snapshotIds, incidentIds };
}

export function migrateData(source, idFactory = () => crypto.randomUUID()) {
  const data = structuredClone(source);
  normalizeDataShape(data);
  const fromVersion = Number(data.version || 1);
  if (!Number.isInteger(fromVersion) || fromVersion < 1) throw new Error(`不支持的数据版本 ${data.version}`);
  if (fromVersion > STORE_VERSION) throw new Error(`数据版本 ${fromVersion} 高于当前支持版本 ${STORE_VERSION}`);

  if (fromVersion === STORE_VERSION) {
    if (!Array.isArray(data.upstreams)) throw new Error(`版本 ${STORE_VERSION} 数据缺少 upstreams 数组`);
    data.upstreams = data.upstreams.map(withProxyDefaults);
    // 归一默认键：旧数据文件缺少后续新增的 settings 字段时自动补齐（已存值优先，含加密字段）。
    data.settings = { ...defaultSettings(), ...data.settings };
    validateDataGraph(data);
    return { data, changed: false, fromVersion };
  }

  if (fromVersion === 1) {
    data.upstreams = [];
    for (const account of data.accounts) {
      const upstream = deriveInitialUpstream(account, idFactory);
      data.upstreams.push(upstream);
      account.upstreamId = upstream.id;
    }
  }

  if (!Array.isArray(data.upstreams)) throw new Error('数据缺少 upstreams 数组');
  data.upstreams = data.upstreams.map(withProxyDefaults);
  data.proxyPool = { ...defaultProxyPool(), ...(data.proxyPool || {}) };
  if (!Array.isArray(data.proxyPool.nodes)) data.proxyPool.nodes = [];
  migrateReminderSettings(data.settings);
  data.settings = { ...defaultSettings(), ...data.settings };
  data.version = STORE_VERSION;
  validateDataGraph(data);
  return { data, changed: true, fromVersion };
}

function seedData() {
  const upstreams = [
    demoUpstream('upstream-east-prod', 'east-prod'),
    demoUpstream('upstream-us-backup', 'us-backup'),
    demoUpstream('upstream-sg-test', 'sg-test'),
    demoUpstream('upstream-de-staging', 'de-staging'),
    demoUpstream('upstream-jp-prod', 'jp-prod'),
    demoUpstream('upstream-hk-backup', 'hk-backup'),
    demoUpstream('upstream-us-test', 'us-test'),
  ];
  const accounts = [
    demoAccount({ id: "acct-east-prod", upstreamId: "upstream-east-prod", name: "east-prod", type: "newapi", region: "美国 (US)", subgroup: "美国 (US)", rawBalance: 1500000, convertedCny: 21.6, formula: "x / 500000 * 7.2", rawUnit: "quota" }),
    demoAccount({ id: "acct-us-backup", upstreamId: "upstream-us-backup", name: "us-backup", type: "newapi", region: "美国 (US)", subgroup: "美国 (US)", rawBalance: 19.765, convertedCny: 142.3, formula: "x * 7.2", rawUnit: "USD" }),
    demoAccount({ id: "acct-sg-test", upstreamId: "upstream-sg-test", name: "sg-test", type: "newapi", region: "新加坡 (SG)", subgroup: "新加坡 (SG)", rawBalance: 12.044, convertedCny: 86.72, formula: "x * 7.2", rawUnit: "USD" }),
    demoAccount({ id: "acct-de-staging", upstreamId: "upstream-de-staging", name: "de-staging", type: "newapi", region: "德国 (DE)", subgroup: "德国 (DE)", rawBalance: 4.469, convertedCny: 32.18, formula: "x * 7.2", rawUnit: "USD", status: "warning", thresholdLow: 50, thresholdRecover: 60 }),
    demoAccount({ id: "acct-jp-prod", upstreamId: "upstream-jp-prod", name: "jp-prod", type: "sub2api", region: "日本 (JP)", subgroup: "日本 (JP)", rawBalance: 165.48, convertedCny: 165.48 }),
    demoAccount({ id: "acct-hk-backup", upstreamId: "upstream-hk-backup", name: "hk-backup", type: "sub2api", region: "香港 (HK)", subgroup: "香港 (HK)", rawBalance: 12.45, convertedCny: 12.45, status: "critical", thresholdLow: 20, thresholdRecover: 30 }),
    demoAccount({ id: "acct-us-test", upstreamId: "upstream-us-test", name: "us-test", type: "sub2api", region: "美国 (US)", subgroup: "美国 (US)", rawBalance: 0, convertedCny: 0, status: "offline", enabled: false }),
  ];

  return {
    version: STORE_VERSION,
    upstreams,
    accounts,
    snapshots: accounts.flatMap((account) => history(account.id, Math.max(account.convertedCny, 10))),
    incidents: [
      { id: "inc-hk", accountId: "acct-hk-backup", state: "open", openedAt: iso(-68), resolvedAt: null, acknowledgedAt: null, triggerBalance: 12.45, currentBalance: 12.45, channelResults: { resend: "sent", feishu: "sent" }, recoveryChecks: 0 },
      { id: "inc-de", accountId: "acct-de-staging", state: "open", openedAt: iso(-51), resolvedAt: null, acknowledgedAt: null, triggerBalance: 32.18, currentBalance: 32.18, channelResults: { resend: "sent", feishu: "sent" }, recoveryChecks: 0 },
      { id: "inc-east", accountId: "acct-east-prod", state: "resolved", openedAt: iso(-1560), resolvedAt: iso(-20), acknowledgedAt: iso(-1490), triggerBalance: 18.2, currentBalance: 21.6, channelResults: { resend: "sent", feishu: "sent" }, recoveryChecks: 2 },
      { id: "inc-jp", accountId: "acct-jp-prod", state: "resolved", openedAt: iso(-2960), resolvedAt: iso(-1573), acknowledgedAt: iso(-2900), triggerBalance: 18.8, currentBalance: 165.48, channelResults: { resend: "sent", feishu: "sent" }, recoveryChecks: 2 },
    ],
    settings: defaultSettings(),
    proxyPool: defaultProxyPool(),
    auth: defaultAuth(),
    audit: [],
    notificationOutbox: [],
  };
}

function blankData() {
  return { version: STORE_VERSION, upstreams: [], accounts: [], snapshots: [], incidents: [], settings: defaultSettings(), proxyPool: defaultProxyPool(), auth: defaultAuth(), audit: [], notificationOutbox: [] };
}

export class JsonStore {
  constructor(file = config.dataFile) {
    this.file = file;
    this.data = null;
    this.queue = Promise.resolve();
    this.storageHealth = {
      status: 'initializing',
      lastSuccessfulWriteAt: null,
      lastFailureAt: null,
      lastErrorCode: null,
    };
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const migrated = migrateData(JSON.parse(raw));
      this.data = migrated.data;
      if (migrated.changed) {
        try {
          await fs.writeFile(`${this.file}.v${migrated.fromVersion}.bak`, raw, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        await this.persist();
      }
      if (this.storageHealth.status === 'initializing') this.storageHealth.status = 'healthy';
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = config.seedDemo ? seedData() : blankData();
      validateDataGraph(this.data);
      await this.persist();
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.data);
  }

  mutate(mutator) {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const draft = structuredClone(this.data);
      const result = await mutator(draft);
      if (Array.isArray(draft.audit) && draft.audit.length > AUDIT_RETENTION_LIMIT) {
        draft.audit = draft.audit.slice(0, AUDIT_RETENTION_LIMIT);
      }
      validateDataGraph(draft);
      try {
        await this.persist(draft);
      } catch (error) {
        this.markPersistenceFailure(error);
        throw error;
      }
      this.data = draft;
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  health() {
    return structuredClone(this.storageHealth);
  }

  async flush() {
    await this.queue.catch(() => undefined);
  }

  markPersistenceFailure(error) {
    this.storageHealth = {
      ...this.storageHealth,
      status: 'degraded',
      lastFailureAt: new Date().toISOString(),
      lastErrorCode: String(error?.code || error?.name || 'PERSISTENCE_ERROR'),
    };
  }

  markPersistenceSuccess() {
    this.storageHealth = {
      ...this.storageHealth,
      status: 'healthy',
      lastSuccessfulWriteAt: new Date().toISOString(),
      lastErrorCode: null,
    };
  }

  async persist(data = this.data) {
    validateDataGraph(data);
    const serialized = JSON.stringify(data, null, 2);
    const directory = path.dirname(this.file);
    const temp = path.join(directory, `.${path.basename(this.file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temp, this.file);
      this.markPersistenceSuccess();
    } catch (error) {
      this.markPersistenceFailure(error);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}
