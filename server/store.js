import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const iso = (offsetMinutes = 0) => new Date(Date.now() + offsetMinutes * 60000).toISOString();
const STORE_VERSION = 2;

function defaultSettings() {
  return {
    resendEnabled: false,
    resendFrom: "霜镜告警 <alerts@example.com>",
    resendTo: "",
    resendApiKeyEncrypted: "",
    feishuEnabled: false,
    feishuWebhookEncrypted: "",
    recoveryConfirmations: 2,
    reminderHours: 6,
  };
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
    notifications: { resend: true, feishu: true },
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
  return {
    id,
    name,
    createdAt: iso(-10080),
    updatedAt: iso(-2),
  };
}

export function deriveInitialUpstream(account, idFactory = () => crypto.randomUUID()) {
  const timestamp = account.createdAt || new Date().toISOString();
  return {
    id: idFactory(),
    name: String(account.name || '未命名上游').trim() || '未命名上游',
    createdAt: timestamp,
    updatedAt: account.updatedAt || timestamp,
  };
}

function assertDataShape(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据文件格式无效');
  if (!Array.isArray(data.accounts)) throw new Error('数据文件缺少 accounts 数组');
  for (const key of ['snapshots', 'incidents', 'audit']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  if (!data.settings || typeof data.settings !== 'object') data.settings = defaultSettings();
  if (!data.auth || typeof data.auth !== 'object') data.auth = defaultAuth();
  data.auth = { ...defaultAuth(), ...data.auth };
  if (!Array.isArray(data.auth.recoveryCodeHashes)) data.auth.recoveryCodeHashes = [];
}

export function migrateData(source, idFactory = () => crypto.randomUUID()) {
  const data = structuredClone(source);
  assertDataShape(data);
  const version = Number(data.version || 1);
  if (!Number.isInteger(version) || version < 1) throw new Error(`不支持的数据版本 ${data.version}`);
  if (version > STORE_VERSION) throw new Error(`数据版本 ${version} 高于当前支持版本 ${STORE_VERSION}`);

  if (version === STORE_VERSION) {
    if (!Array.isArray(data.upstreams)) throw new Error('版本 2 数据缺少 upstreams 数组');
    const upstreamIds = new Set(data.upstreams.map((upstream) => upstream.id));
    const invalid = data.accounts.find((account) => !account.upstreamId || !upstreamIds.has(account.upstreamId));
    if (invalid) throw new Error(`账号 ${invalid.id || invalid.name || 'unknown'} 未关联有效上游`);
    return { data, changed: false, fromVersion: version };
  }

  data.upstreams = [];
  for (const account of data.accounts) {
    const upstream = deriveInitialUpstream(account, idFactory);
    data.upstreams.push(upstream);
    account.upstreamId = upstream.id;
  }
  data.version = STORE_VERSION;
  return { data, changed: true, fromVersion: version };
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
    auth: defaultAuth(),
    audit: [],
  };
}

function blankData() {
  return { version: STORE_VERSION, upstreams: [], accounts: [], snapshots: [], incidents: [], settings: defaultSettings(), auth: defaultAuth(), audit: [] };
}

export class JsonStore {
  constructor(file = config.dataFile) {
    this.file = file;
    this.data = null;
    this.queue = Promise.resolve();
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
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = config.seedDemo ? seedData() : blankData();
      await this.persist();
    }
    return this;
  }

  snapshot() {
    return structuredClone(this.data);
  }

  async mutate(mutator) {
    let result;
    this.queue = this.queue.then(async () => {
      result = await mutator(this.data);
      await this.persist();
    });
    await this.queue;
    return result;
  }

  async persist() {
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.data, null, 2), "utf8");
    await fs.rename(temp, this.file);
  }
}
