import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, ProxyAgent } from 'undici';
import YAML from 'yaml';
import { config } from './config.js';
import { decryptSecret, encryptSecret } from './security.js';

const PROVIDER_NAME = 'frosted-subscription';
const PROVIDER_FILE = path.join('providers', 'subscription.txt');
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 12000;
const HEALTH_URL = 'https://www.gstatic.com/generate_204';

const blockedAddresses = new net.BlockList();
const fakeIpAddresses = new net.BlockList();
fakeIpAddresses.addSubnet('198.18.0.0', 15, 'ipv4');
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:2::', 48], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blockedAddresses.addSubnet(address, prefix, 'ipv6');

const routes = new Map();
const dispatchers = new Map();
const proxyContextStorage = new AsyncLocalStorage();
const activeLeases = new Map();
const requiredProxyUpstreams = new Set();
let configurationRelease = null;
let configurationDone = Promise.resolve();

function nodeId(name) {
  return crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 20);
}

function groupName(upstreamId) {
  return `FROSTED-${crypto.createHash('sha256').update(String(upstreamId)).digest('hex').slice(0, 12)}`;
}

function listenerName(upstreamId) {
  return `frosted-${crypto.createHash('sha256').update(String(upstreamId)).digest('hex').slice(0, 12)}`;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function errorWithStatus(message, statusCode = 400, code = 'PROXY_POOL_ERROR') {
  return Object.assign(new Error(message), { statusCode, code });
}

async function lookupWithDnsOverHttps(hostname) {
  const answers = await Promise.allSettled([1, 28].map(async (type) => {
    const endpoint = new URL('https://1.1.1.1/dns-query');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', String(type));
    const response = await fetch(endpoint, {
      redirect: 'error',
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new Error(`DoH ${response.status}`);
    const payload = await response.json();
    if (Number(payload?.Status) !== 0) return [];
    return (Array.isArray(payload?.Answer) ? payload.Answer : [])
      .filter((answer) => answer?.type === type && net.isIP(answer?.data))
      .map((answer) => ({ address: answer.data, family: type === 1 ? 4 : 6 }));
  }));
  const addresses = answers.flatMap((answer) => answer.status === 'fulfilled' ? answer.value : []);
  if (!addresses.length) throw new Error('DoH 未返回地址');
  return addresses;
}

function isFakeIpAddress(address) {
  return net.isIP(address) === 4 && fakeIpAddresses.check(address, 'ipv4');
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    return isPublicAddress(address.slice(address.lastIndexOf(':') + 1));
  }
  return !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function resolveSubscriptionUrl(value, lookup = dns.lookup, fallbackLookup) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw errorWithStatus('Clash 订阅地址无效');
  }
  if (url.protocol !== 'https:') throw errorWithStatus('Clash 订阅仅允许 HTTPS 地址');
  if (url.username || url.password) throw errorWithStatus('订阅地址不能在 URL 中携带用户名或密码');
  if (!url.hostname || url.hostname.toLowerCase() === 'localhost') throw errorWithStatus('订阅地址不能指向本机或内网');

  let resolved;
  try {
    resolved = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    if (fallbackLookup === null || (fallbackLookup === undefined && lookup !== dns.lookup)) {
      throw errorWithStatus('无法解析 Clash 订阅域名');
    }
    try {
      resolved = await (fallbackLookup || lookupWithDnsOverHttps)(url.hostname);
    } catch {
      throw errorWithStatus('无法解析 Clash 订阅域名');
    }
  }
  let addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.length && addresses.every((entry) => isFakeIpAddress(entry.address))) {
    if (fallbackLookup === null || (fallbackLookup === undefined && lookup !== dns.lookup)) {
      throw errorWithStatus('订阅地址解析到了本机、内网或保留地址');
    }
    try {
      const fallback = await (fallbackLookup || lookupWithDnsOverHttps)(url.hostname);
      addresses = Array.isArray(fallback) ? fallback : [fallback];
    } catch {
      throw errorWithStatus('Clash Fake-IP DNS 回退解析失败');
    }
  }
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw errorWithStatus('订阅地址解析到了本机、内网或保留地址');
  }
  return { url, addresses, connectionAddresses: addresses };
}

export async function validateSubscriptionUrl(value, lookup = dns.lookup, fallbackLookup) {
  return (await resolveSubscriptionUrl(value, lookup, fallbackLookup)).url;
}

function pinnedDispatcherFactory({ url, addresses, connectionAddresses = addresses }) {
  const pinned = connectionAddresses.map((entry) => ({ address: entry.address, family: Number(entry.family) || net.isIP(entry.address) }));
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        const requestedHost = String(hostname).toLowerCase().replace(/\.$/, '');
        const validatedHost = url.hostname.toLowerCase().replace(/\.$/, '');
        if (requestedHost !== validatedHost) {
          callback(new Error('订阅连接尝试解析未校验的域名'));
          return;
        }
        const family = Number(options?.family || 0);
        const candidates = family ? pinned.filter((entry) => entry.family === family) : pinned;
        if (!candidates.length) {
          callback(new Error('订阅域名没有匹配的已校验地址'));
          return;
        }
        if (options?.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      },
    },
  });
}

export async function downloadSubscription(value, {
  fetchImpl = fetch,
  lookup = dns.lookup,
  fallbackLookup,
  dispatcherFactory = pinnedDispatcherFactory,
  maxBytes = config.proxyImportMaxBytes,
} = {}) {
  let current = String(value || '').trim();
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const resolved = await resolveSubscriptionUrl(current, lookup, fallbackLookup);
    const dispatcher = dispatcherFactory?.(resolved);
    try {
      const response = await fetchImpl(resolved.url, {
        redirect: 'manual',
        headers: { Accept: 'text/yaml,text/plain,application/yaml;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        ...(dispatcher ? { dispatcher } : {}),
      }).catch(() => { throw errorWithStatus('下载 Clash 订阅失败', 502); });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === MAX_REDIRECTS) throw errorWithStatus('Clash 订阅重定向次数过多', 502);
        const location = response.headers.get('location');
        if (!location) throw errorWithStatus('Clash 订阅返回了无效重定向', 502);
        await response.body?.cancel().catch(() => {});
        current = new URL(location, resolved.url).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw errorWithStatus(`Clash 订阅下载失败 (${response.status})`, 502);
      }

      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw errorWithStatus('Clash 订阅文件超过大小限制', 413);
      }
      const chunks = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw errorWithStatus('Clash 订阅响应为空', 502);
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw errorWithStatus('Clash 订阅文件超过大小限制', 413);
        }
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks).toString('utf8').trim();
      if (!content || content.includes('\0')) throw errorWithStatus('Clash 订阅内容为空或格式无效');
      return content;
    } finally {
      await dispatcher?.close?.().catch(() => {});
    }
  }
  throw errorWithStatus('Clash 订阅下载失败', 502);
}

export function configureProxyRoutes(upstreams = [], { ready = true } = {}) {
  const next = new Map();
  requiredProxyUpstreams.clear();
  for (const upstream of upstreams) {
    if (upstream.proxyMode !== 'auto_sticky') continue;
    requiredProxyUpstreams.add(upstream.id);
    if (!ready || !Number.isInteger(upstream.proxyPort)) continue;
    next.set(upstream.id, `http://${config.upstreamProxyHost}:${upstream.proxyPort}`);
  }
  for (const [upstreamId, dispatcher] of dispatchers) {
    if (next.get(upstreamId) === routes.get(upstreamId)) continue;
    dispatcher.close().catch(() => {});
    dispatchers.delete(upstreamId);
  }
  routes.clear();
  for (const [key, value] of next) routes.set(key, value);
}

export function getUpstreamProxyContext(accountOrUpstreamId) {
  const upstreamId = typeof accountOrUpstreamId === 'string'
    ? accountOrUpstreamId
    : accountOrUpstreamId?.upstreamId;
  const proxyUrl = routes.get(upstreamId);
  if (!proxyUrl) {
    if (requiredProxyUpstreams.has(upstreamId)) {
      throw errorWithStatus('该上游的固定代理出口尚未就绪', 503, 'UPSTREAM_PROXY_NOT_READY');
    }
    return null;
  }
  let dispatcher = dispatchers.get(upstreamId);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxyUrl);
    dispatchers.set(upstreamId, dispatcher);
  }
  return { proxyUrl, dispatcher, browserProxy: { server: proxyUrl } };
}

export function currentUpstreamProxyContext() {
  return proxyContextStorage.getStore() || null;
}

export function isUpstreamProxyInUse(upstreamId) {
  return Number(activeLeases.get(upstreamId) || 0) > 0;
}

export async function withUpstreamProxyContext(account, task) {
  const upstreamId = account?.upstreamId || '';
  while (configurationRelease) await configurationDone;
  const context = getUpstreamProxyContext(upstreamId);
  if (!upstreamId) return proxyContextStorage.run(context, task);
  activeLeases.set(upstreamId, Number(activeLeases.get(upstreamId) || 0) + 1);
  try {
    return await proxyContextStorage.run(context, task);
  } finally {
    const remaining = Number(activeLeases.get(upstreamId) || 1) - 1;
    if (remaining > 0) activeLeases.set(upstreamId, remaining);
    else activeLeases.delete(upstreamId);
  }
}

function beginConfigurationChange() {
  if (configurationRelease) {
    throw errorWithStatus('代理配置正在更新，请稍后重试', 409, 'PROXY_UPDATE_IN_PROGRESS');
  }
  if (activeLeases.size) {
    throw errorWithStatus('上游正在采集，完成后再更新代理配置', 409, 'PROXY_LEASE_ACTIVE');
  }
  let resolve;
  configurationDone = new Promise((done) => { resolve = done; });
  configurationRelease = () => {
    configurationRelease = null;
    resolve();
  };
  return configurationRelease;
}

const UPSTREAM_PROXY_FIELDS = [
  'proxyMode', 'proxyNodeName', 'proxyPort', 'proxyAssignedAt',
  'proxyStatus', 'proxyLatencyMs', 'proxyLastCheckedAt',
];

function captureProxyState(data) {
  return {
    proxyPool: structuredClone(data.proxyPool),
    upstreams: new Map(data.upstreams.map((upstream) => [
      upstream.id,
      Object.fromEntries(UPSTREAM_PROXY_FIELDS.map((field) => [field, structuredClone(upstream[field])])),
    ])),
  };
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

export function normalizeProviderNodes(payload, checkedAt = new Date().toISOString()) {
  const provider = payload?.proxies ? payload : payload?.providers?.[PROVIDER_NAME];
  const source = Array.isArray(provider?.proxies) ? provider.proxies : [];
  return source
    .filter((node) => node?.name && !['DIRECT', 'REJECT', 'COMPATIBLE'].includes(node.name))
    .map((node) => {
      const delays = (Array.isArray(node.history) ? node.history : [])
        .slice(-5)
        .map((entry) => Number(entry?.delay))
        .filter((delay) => Number.isFinite(delay) && delay > 0);
      const latencyMs = median(delays);
      const available = node.alive !== false && latencyMs != null;
      return {
        id: nodeId(node.name),
        name: String(node.name),
        type: String(node.type || 'unknown'),
        status: available ? (latencyMs > 1200 ? 'slow' : 'available') : node.alive === false ? 'unavailable' : 'unchecked',
        latencyMs,
        lastCheckedAt: checkedAt,
      };
    })
    .sort((left, right) => {
      const rank = { available: 0, slow: 1, unchecked: 2, unavailable: 3 };
      return (rank[left.status] - rank[right.status])
        || ((left.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.latencyMs ?? Number.MAX_SAFE_INTEGER))
        || left.name.localeCompare(right.name, 'zh-CN');
    });
}

export class ProxyPoolManager {
  constructor(store, {
    fetchImpl = fetch,
    lookup = dns.lookup,
    sharedDir = config.mihomoSharedDir,
    runtimePath = config.mihomoRuntimePath,
    controllerUrl = config.mihomoControllerUrl,
    controllerSecret = config.mihomoSecret,
  } = {}) {
    this.store = store;
    this.fetch = fetchImpl;
    this.lookup = lookup;
    this.sharedDir = sharedDir;
    this.runtimePath = runtimePath;
    this.controllerUrl = controllerUrl.replace(/\/$/, '');
    this.controllerSecret = controllerSecret;
    this.retryTimer = null;
    this.retryDelayMs = 1000;
  }

  providerPath() {
    return path.join(this.sharedDir, PROVIDER_FILE);
  }

  async ensurePorts() {
    await this.store.mutate((data) => {
      const used = new Set(data.upstreams.map((upstream) => Number(upstream.proxyPort)).filter(Number.isInteger));
      let candidate = config.proxyBasePort;
      for (const upstream of data.upstreams) {
        if (upstream.proxyMode !== 'auto_sticky' || Number.isInteger(upstream.proxyPort)) continue;
        while (used.has(candidate)) candidate += 1;
        if (candidate > 65000) throw errorWithStatus('可用代理监听端口已耗尽', 500);
        upstream.proxyPort = candidate;
        used.add(candidate);
        candidate += 1;
      }
    });
  }

  runtimeConfig({ providerFile = PROVIDER_FILE, includeProvider = true } = {}) {
    const data = this.store.snapshot();
    const enabled = includeProvider
      ? data.upstreams.filter((upstream) => upstream.proxyMode === 'auto_sticky' && Number.isInteger(upstream.proxyPort))
      : [];
    const groups = enabled.map((upstream) => ({
      name: groupName(upstream.id),
      type: 'select',
      use: [PROVIDER_NAME],
    }));
    const listeners = enabled.map((upstream) => ({
      name: listenerName(upstream.id),
      type: 'http',
      listen: config.mihomoBindAddress,
      port: upstream.proxyPort,
      proxy: groupName(upstream.id),
    }));
    const runtime = {
      'allow-lan': !['127.0.0.1', '::1', 'localhost'].includes(config.mihomoBindAddress),
      'bind-address': config.mihomoBindAddress,
      mode: 'rule',
      'log-level': 'warning',
      'external-controller': `${config.mihomoControllerBindAddress}:9090`,
      secret: this.controllerSecret,
      profile: { 'store-selected': true },
      'proxy-groups': groups,
      listeners,
      rules: ['MATCH,DIRECT'],
    };
    if (includeProvider) {
      runtime['proxy-providers'] = {
        [PROVIDER_NAME]: {
          type: 'file',
          path: `./${providerFile.replaceAll('\\', '/')}`,
          'health-check': {
            enable: true,
            url: HEALTH_URL,
            interval: 300,
            timeout: 6000,
            lazy: false,
            'expected-status': '200/204',
          },
        },
      };
    }
    return runtime;
  }

  async writeRuntimeConfig(options = {}) {
    await fs.mkdir(path.dirname(this.providerPath()), { recursive: true });
    await fs.mkdir(path.dirname(this.runtimePath), { recursive: true });
    const temporary = `${this.runtimePath}.tmp`;
    await fs.writeFile(temporary, YAML.stringify(this.runtimeConfig(options)), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.runtimePath);
  }

  async controllerRequest(endpoint, options = {}) {
    const response = await this.fetch(`${this.controllerUrl}${endpoint}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.controllerSecret ? { Authorization: `Bearer ${this.controllerSecret}` } : {}),
        ...(options.headers || {}),
      },
      signal: options.signal || AbortSignal.timeout(10000),
    }).catch(() => { throw errorWithStatus('Mihomo 服务不可用，请检查代理服务是否启动', 503, 'MIHOMO_UNAVAILABLE'); });
    if (!response.ok) throw errorWithStatus(`Mihomo 控制接口失败 (${response.status})`, 502, 'MIHOMO_CONTROL_FAILED');
    if (response.status === 204) return {};
    return response.json().catch(() => ({}));
  }

  async reload() {
    await this.controllerRequest('/configs?force=true', {
      method: 'PUT',
      body: JSON.stringify({ path: this.runtimePath }),
    });
  }

  async withConfigurationChange(task) {
    const release = beginConfigurationChange();
    try {
      return await task();
    } finally {
      release();
    }
  }

  async restoreProxyState(state, lastError = '') {
    await this.store.mutate((data) => {
      data.proxyPool = { ...structuredClone(state.proxyPool), lastError };
      for (const upstream of data.upstreams) {
        const previous = state.upstreams.get(upstream.id);
        if (!previous) continue;
        for (const field of UPSTREAM_PROXY_FIELDS) upstream[field] = structuredClone(previous[field]);
      }
    });
  }

  planAssignments(nodes, forceUpstreamId = '') {
    const candidates = nodes.filter((node) => ['available', 'slow'].includes(node.status));
    if (!candidates.length) throw errorWithStatus('代理订阅中没有可用节点', 502, 'NO_HEALTHY_PROXY');
    const selected = [];
    let cursor = 0;
    for (const upstream of this.store.snapshot().upstreams.filter((item) => item.proxyMode === 'auto_sticky')) {
      const existing = candidates.find((node) => node.name === upstream.proxyNodeName);
      let choices = candidates;
      if (upstream.id === forceUpstreamId && candidates.length > 1) {
        choices = candidates.filter((node) => node.name !== upstream.proxyNodeName);
      }
      const node = upstream.id !== forceUpstreamId && existing
        ? existing
        : choices[cursor++ % choices.length];
      selected.push({
        upstreamId: upstream.id,
        group: groupName(upstream.id),
        node: node.name,
        previousNode: upstream.proxyNodeName || '',
        status: node.status,
        latencyMs: node.latencyMs,
        lastCheckedAt: node.lastCheckedAt,
      });
    }
    return selected;
  }

  async applyAssignments(selected, { persist = true } = {}) {
    const applied = [];
    try {
      for (const assignment of selected) {
        await this.controllerRequest(`/proxies/${encodeURIComponent(assignment.group)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: assignment.node }),
        });
        applied.push(assignment);
      }
    } catch (error) {
      for (const assignment of applied.reverse()) {
        if (!assignment.previousNode || assignment.previousNode === assignment.node) continue;
        await this.controllerRequest(`/proxies/${encodeURIComponent(assignment.group)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: assignment.previousNode }),
        }).catch(() => {});
      }
      throw error;
    }
    if (persist) await this.persistAssignments(selected);
    return selected;
  }

  async persistAssignments(selected) {
    const assignedAt = new Date().toISOString();
    await this.store.mutate((data) => {
      this.assignmentsToData(data, selected, assignedAt);
    });
  }

  assignmentsToData(data, selected, assignedAt = new Date().toISOString()) {
    for (const assignment of selected) {
      const upstream = data.upstreams.find((item) => item.id === assignment.upstreamId);
      if (!upstream || upstream.proxyMode !== 'auto_sticky') continue;
      upstream.proxyNodeName = assignment.node;
      upstream.proxyAssignedAt = assignedAt;
      upstream.proxyStatus = assignment.status;
      upstream.proxyLatencyMs = assignment.latencyMs;
      upstream.proxyLastCheckedAt = assignment.lastCheckedAt;
    }
  }

  async rollbackAssignments(selected) {
    for (const assignment of [...selected].reverse()) {
      if (!assignment.previousNode || assignment.previousNode === assignment.node) continue;
      await this.controllerRequest(`/proxies/${encodeURIComponent(assignment.group)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: assignment.previousNode }),
      }).catch(() => {});
    }
  }

  async selectAssignments(nodes, forceUpstreamId = '', options = {}) {
    const selected = this.planAssignments(nodes, forceUpstreamId);
    await this.applyAssignments(selected, options);
    if (options.persist !== false) configureProxyRoutes(this.store.snapshot().upstreams, { ready: true });
    return selected;
  }

  async probeNodes(checkedAt = new Date().toISOString()) {
    await this.controllerRequest(`/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}/healthcheck`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const payload = await this.controllerRequest(`/providers/proxies/${encodeURIComponent(PROVIDER_NAME)}`);
    const nodes = normalizeProviderNodes(payload, checkedAt);
    if (!nodes.length) throw errorWithStatus('Mihomo 未从订阅中加载到代理节点', 502, 'EMPTY_PROXY_POOL');
    return nodes;
  }

  async checkUnlocked({ forceUpstreamId = '' } = {}) {
    const checkedAt = new Date().toISOString();
    const before = captureProxyState(this.store.snapshot());
    let selected = [];
    try {
      const nodes = await this.probeNodes(checkedAt);
      selected = await this.selectAssignments(nodes, forceUpstreamId, { persist: false });
      await this.store.mutate((data) => {
        data.proxyPool.nodes = nodes;
        data.proxyPool.lastCheckedAt = checkedAt;
        data.proxyPool.lastError = '';
        this.assignmentsToData(data, selected);
      });
      configureProxyRoutes(this.store.snapshot().upstreams, { ready: true });
      return this.publicState();
    } catch (error) {
      await this.rollbackAssignments(selected);
      await this.restoreProxyState(before, error.message);
      throw error;
    }
  }

  async check(options = {}) {
    return this.withConfigurationChange(() => this.checkUnlocked(options));
  }

  async importSubscription(url) {
    return this.withConfigurationChange(async () => {
      const before = captureProxyState(this.store.snapshot());
      const oldProvider = await readOptionalFile(this.providerPath());
      const oldRuntime = await readOptionalFile(this.runtimePath);
      const candidateFile = path.join('providers', `subscription.${crypto.randomUUID()}.candidate`);
      const candidatePath = path.join(this.sharedDir, candidateFile);
      let rollbackReady = false;
      try {
        const content = await downloadSubscription(url, { fetchImpl: this.fetch, lookup: this.lookup });
        await replaceFile(candidatePath, content);
        await this.ensurePorts();

        await this.writeRuntimeConfig({ providerFile: candidateFile });
        await this.reload();
        const candidateNodes = await this.probeNodes();
        await this.selectAssignments(candidateNodes, '', { persist: false });

        await replaceFile(this.providerPath(), content);
        await this.writeRuntimeConfig();
        await this.reload();
        const checkedAt = new Date().toISOString();
        const nodes = await this.probeNodes(checkedAt);
        const selected = await this.selectAssignments(nodes, '', { persist: false });
        const updatedAt = new Date().toISOString();
        await this.store.mutate((data) => {
          data.proxyPool.subscriptionUrlEncrypted = encryptSecret({ value: String(url).trim() });
          data.proxyPool.subscriptionUpdatedAt = updatedAt;
          data.proxyPool.lastCheckedAt = checkedAt;
          data.proxyPool.lastError = '';
          data.proxyPool.nodes = nodes;
          this.assignmentsToData(data, selected, updatedAt);
        });
        configureProxyRoutes(this.store.snapshot().upstreams, { ready: true });
        this.stopSyncRetry();
        return this.publicState();
      } catch (error) {
        let providerRestored = false;
        try {
          if (oldProvider == null) await fs.rm(this.providerPath(), { force: true });
          else await replaceFile(this.providerPath(), oldProvider);
          providerRestored = true;
        } catch {
          await fs.rm(this.providerPath(), { force: true }).catch(() => {});
        }
        await this.restoreProxyState(before, error.message);
        try {
          if (oldRuntime == null) {
            await this.writeRuntimeConfig({ includeProvider: oldProvider != null && Boolean(before.proxyPool.subscriptionUrlEncrypted) });
          } else {
            await replaceFile(this.runtimePath, oldRuntime);
          }
          await this.reload();
          if (before.proxyPool.subscriptionUrlEncrypted && oldProvider != null) {
            const previousAssignments = this.store.snapshot().upstreams
              .filter((upstream) => upstream.proxyMode === 'auto_sticky' && upstream.proxyNodeName)
              .map((upstream) => ({
                upstreamId: upstream.id,
                group: groupName(upstream.id),
                node: upstream.proxyNodeName,
                previousNode: '',
              }));
            await this.applyAssignments(previousAssignments, { persist: false });
          }
          rollbackReady = Boolean(providerRestored && before.proxyPool.subscriptionUrlEncrypted && oldProvider != null);
        } catch {
          rollbackReady = false;
        }
        configureProxyRoutes(this.store.snapshot().upstreams, { ready: rollbackReady });
        if (!rollbackReady && before.proxyPool.subscriptionUrlEncrypted) this.startSyncRetry();
        throw error;
      } finally {
        await fs.rm(candidatePath, { force: true }).catch(() => {});
      }
    });
  }

  async syncUnlocked() {
    configureProxyRoutes(this.store.snapshot().upstreams, { ready: false });
    await this.ensurePorts();
    const snapshot = this.store.snapshot();
    configureProxyRoutes(snapshot.upstreams, { ready: false });
    if (!snapshot.proxyPool.subscriptionUrlEncrypted) return this.publicState();
    try {
      await fs.access(this.providerPath());
      await this.writeRuntimeConfig();
      await this.reload();
      const result = await this.checkUnlocked();
      this.stopSyncRetry();
      return result;
    } catch (error) {
      configureProxyRoutes(this.store.snapshot().upstreams, { ready: false });
      await this.store.mutate((data) => { data.proxyPool.lastError = error.message; });
      throw error;
    }
  }

  async sync() {
    try {
      return await this.withConfigurationChange(() => this.syncUnlocked());
    } catch (error) {
      if (!['PROXY_LEASE_ACTIVE', 'PROXY_UPDATE_IN_PROGRESS'].includes(error?.code)) this.startSyncRetry();
      throw error;
    }
  }

  startSyncRetry() {
    if (this.retryTimer || !this.store.snapshot().proxyPool.subscriptionUrlEncrypted) return;
    const delay = this.retryDelayMs;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        await this.withConfigurationChange(() => this.syncUnlocked());
        this.retryDelayMs = 1000;
      } catch (error) {
        console.warn(`[proxy] Mihomo 同步重试失败：${error.message}`);
        this.retryDelayMs = Math.min(30000, delay * 2);
        this.startSyncRetry();
      }
    }, delay);
    this.retryTimer.unref?.();
  }

  stopSyncRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDelayMs = 1000;
  }

  async refreshSubscription() {
    const encrypted = this.store.snapshot().proxyPool.subscriptionUrlEncrypted;
    if (!encrypted) throw errorWithStatus('尚未导入 Clash 订阅');
    let url;
    try {
      url = decryptSecret(encrypted).value;
    } catch {
      throw errorWithStatus('Clash 订阅密钥无法解密，请重新导入', 400);
    }
    return this.importSubscription(url);
  }

  async reassign(upstreamId) {
    return this.withConfigurationChange(async () => {
      const upstream = this.store.snapshot().upstreams.find((item) => item.id === upstreamId);
      if (!upstream) throw errorWithStatus('上游不存在', 404);
      if (upstream.proxyMode !== 'auto_sticky') throw errorWithStatus('该上游当前使用直连');
      const nodes = this.store.snapshot().proxyPool.nodes;
      if (!nodes.length) return this.checkUnlocked({ forceUpstreamId: upstreamId });
      await this.selectAssignments(nodes, upstreamId);
      return this.publicState();
    });
  }

  publicState() {
    const data = this.store.snapshot();
    const assignmentCounts = new Map();
    for (const upstream of data.upstreams) {
      if (!upstream.proxyNodeName) continue;
      assignmentCounts.set(upstream.proxyNodeName, (assignmentCounts.get(upstream.proxyNodeName) || 0) + 1);
    }
    const nodes = data.proxyPool.nodes.map((node) => ({
      ...node,
      assignedUpstreamCount: assignmentCounts.get(node.name) || 0,
    }));
    const available = nodes.filter((node) => ['available', 'slow'].includes(node.status)).length;
    return {
      subscription: {
        configured: Boolean(data.proxyPool.subscriptionUrlEncrypted),
        updatedAt: data.proxyPool.subscriptionUpdatedAt,
        lastError: data.proxyPool.lastError || '',
      },
      summary: {
        total: nodes.length,
        available,
        assigned: data.upstreams.filter((upstream) => upstream.proxyMode === 'auto_sticky' && upstream.proxyNodeName).length,
        lastCheckedAt: data.proxyPool.lastCheckedAt,
      },
      nodes,
    };
  }
}
