import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ProxyPoolManager,
  configureProxyRoutes,
  downloadSubscription,
  isPublicAddress,
  normalizeProviderNodes,
  validateSubscriptionContent,
  validateSubscriptionUrl,
  withUpstreamProxyContext,
} from '../server/proxy-pool.js';

class MemoryStore {
  constructor() {
    this.data = {
      version: 3,
      upstreams: [{
        id: 'upstream-1',
        name: '86GameStore',
        proxyMode: 'auto_sticky',
        proxyNodeName: '',
        proxyPort: null,
        proxyAssignedAt: null,
      }],
      accounts: [],
      snapshots: [],
      incidents: [],
      audit: [],
      settings: {},
      auth: { recoveryCodeHashes: [] },
      proxyPool: {
        subscriptionUrlEncrypted: '',
        subscriptionUpdatedAt: null,
        lastCheckedAt: null,
        lastError: '',
        nodes: [],
      },
    };
  }

  snapshot() { return structuredClone(this.data); }

  peek() { return this.data; }

  async mutate(mutator) { return mutator(this.data); }
}

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

async function withTemporaryDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-proxy-pool-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function assignmentSnapshot(upstream) {
  return {
    proxyMode: upstream.proxyMode,
    proxyNodeName: upstream.proxyNodeName,
    proxyPort: upstream.proxyPort,
    proxyAssignedAt: upstream.proxyAssignedAt,
    proxyStatus: upstream.proxyStatus,
    proxyLatencyMs: upstream.proxyLatencyMs,
    proxyLastCheckedAt: upstream.proxyLastCheckedAt,
  };
}

function holdUpstreamLease(upstreamId = 'upstream-1') {
  let release;
  const completed = withUpstreamProxyContext({ upstreamId }, () => new Promise((resolve) => {
    release = resolve;
  }));
  return {
    completed,
    release: () => release(),
  };
}

test('subscription URL policy accepts public HTTPS and rejects local/private destinations', async () => {
  assert.equal((await validateSubscriptionUrl('https://sub.example.com/clash?token=secret', publicLookup)).hostname, 'sub.example.com');
  await assert.rejects(() => validateSubscriptionUrl('http://sub.example.com/a', publicLookup), /HTTPS/);
  await assert.rejects(() => validateSubscriptionUrl('https://localhost/a', publicLookup), /本机或内网/);
  await assert.rejects(() => validateSubscriptionUrl('https://sub.example.com/a', async () => [{ address: '192.168.1.2', family: 4 }]), /内网或保留地址/);
  assert.equal(isPublicAddress('1.1.1.1'), true);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('203.0.113.8'), false);
  assert.equal(isPublicAddress('::1'), false);
  assert.equal(isPublicAddress('2001:db8::1'), false);
});

test('subscription downloader validates every redirect and enforces decoded size', async () => {
  let calls = 0;
  const content = await downloadSubscription('https://sub.example.com/start', {
    lookup: publicLookup,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/list' } });
      return new Response('ss://example-node', { status: 200 });
    },
  });
  assert.equal(content, 'ss://example-node');
  assert.equal(calls, 2);

  await assert.rejects(() => downloadSubscription('https://sub.example.com/large', {
    lookup: publicLookup,
    maxBytes: 8,
    fetchImpl: async () => new Response('0123456789', { status: 200 }),
  }), /大小限制/);
});

test('subscription downloader preserves actionable HTTP failure metadata', async () => {
  await assert.rejects(() => downloadSubscription('https://sub.example.com/expired', {
    lookup: publicLookup,
    fetchImpl: async () => new Response('expired', { status: 403 }),
  }), (error) => (
    error.code === 'PROXY_SUBSCRIPTION_HTTP_FAILED'
    && error.upstreamStatus === 403
    && error.retryable === false
    && /链接已过期/.test(error.message)
  ));
});

test('subscription content validation accepts YAML, base64 YAML, and common URI lists', () => {
  const yaml = 'proxies:\n  - {name: Tokyo, type: ss, server: proxy.example.com, port: 443, cipher: aes-128-gcm, password: test}';
  assert.equal(validateSubscriptionContent(yaml), yaml);
  const encoded = Buffer.from(yaml).toString('base64');
  assert.match(validateSubscriptionContent(encoded), /^proxies:/);
  assert.match(validateSubscriptionContent('ss://YWVzLTEyOC1nY206dGVzdA==@proxy.example.com:443#Tokyo'), /proxies:/);
  const httpsProxy = validateSubscriptionContent('https://user:pass@proxy.example.com:443#Secure%20HTTP');
  assert.match(httpsProxy, /type: http/);
  assert.match(httpsProxy, /tls: true/);
  const hysteria = validateSubscriptionContent('hy2://secret@proxy.example.com:8443?sni=edge.example.com&upmbps=50&downmbps=100#Fast');
  assert.match(hysteria, /type: hysteria2/);
  assert.match(hysteria, /up: 50 Mbps/);
  assert.match(hysteria, /down: 100 Mbps/);
});

test('subscription content validation explains expired HTML and malformed responses', () => {
  assert.throws(() => validateSubscriptionContent('<html><title>Login</title></html>'), (error) => (
    error.code === 'PROXY_SUBSCRIPTION_HTML' && error.retryable === false
  ));
  assert.throws(() => validateSubscriptionContent('not-a-clash-subscription'), (error) => (
    error.code === 'PROXY_SUBSCRIPTION_INVALID_FORMAT' && error.retryable === false
  ));
  assert.throws(() => validateSubscriptionContent('proxies: []'), (error) => error.code === 'PROXY_SUBSCRIPTION_NO_NODES');
  assert.throws(() => validateSubscriptionContent('proxies:\n  - null'), (error) => error.code === 'PROXY_SUBSCRIPTION_INVALID_FORMAT');
  assert.throws(() => validateSubscriptionContent('proxies:\n  - {name: Broken, type: unknown, server: proxy.example.com, port: 443}'), (error) => error.code === 'PROXY_SUBSCRIPTION_INVALID_FORMAT');
  assert.throws(() => validateSubscriptionContent('proxies:\n  - {name: Broken SS, type: ss, server: proxy.example.com, port: 443}'), (error) => error.code === 'PROXY_SUBSCRIPTION_INVALID_FORMAT');
  assert.throws(() => validateSubscriptionContent('ss://definitely-invalid'), (error) => error.code === 'PROXY_SUBSCRIPTION_INVALID_FORMAT');
});

test('provider readiness waits until every node has completed its health result', async () => {
  const store = new MemoryStore();
  let providerCalls = 0;
  const manager = new ProxyPoolManager(store, {
    fetchImpl: async (url) => {
      if (String(url).endsWith('/healthcheck')) return new Response(null, { status: 204 });
      providerCalls += 1;
      return Response.json({
        proxies: [
          { name: 'Tokyo', type: 'Shadowsocks', alive: true, history: [{ delay: 80 }] },
          { name: 'Osaka', type: 'Shadowsocks', alive: true, history: providerCalls === 1 ? [] : [{ delay: 95 }] },
        ],
      });
    },
    lookup: publicLookup,
    controllerUrl: 'http://mihomo.test:9090',
  });
  const nodes = await manager.probeNodes();
  assert.equal(providerCalls, 2);
  assert.deepEqual(nodes.map((node) => node.status), ['available', 'available']);
});

test('malformed subscription content is rejected before Mihomo is reloaded', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new MemoryStore();
    let controllerCalls = 0;
    const manager = new ProxyPoolManager(store, {
      fetchImpl: async (url) => {
        if (String(url).startsWith('https://sub.example.com/')) return new Response('<html><title>Expired</title></html>', { status: 200 });
        controllerCalls += 1;
        return new Response(null, { status: 204 });
      },
      lookup: publicLookup,
      sharedDir: directory,
      runtimePath: path.join(directory, 'config.yaml'),
      controllerUrl: 'http://mihomo.test:9090',
    });
    try {
      await assert.rejects(() => manager.importSubscription('https://sub.example.com/expired'), (error) => error.code === 'PROXY_SUBSCRIPTION_HTML');
      assert.equal(controllerCalls, 0, 'invalid content never reloads or contacts Mihomo');
      assert.equal(store.snapshot().proxyPool.subscriptionUrlEncrypted, '');
      await assert.rejects(() => fs.access(path.join(directory, 'providers', 'subscription.txt')), (error) => error.code === 'ENOENT');
    } finally {
      configureProxyRoutes([]);
    }
  });
});

test('provider nodes are ranked by availability and recent median latency', () => {
  const checkedAt = '2026-07-14T00:00:00.000Z';
  const nodes = normalizeProviderNodes({
    proxies: [
      { name: 'slow', type: 'Trojan', alive: true, history: [{ delay: 1500 }] },
      { name: 'fast', type: 'VLESS', alive: true, history: [{ delay: 90 }, { delay: 110 }, { delay: 100 }] },
      { name: 'dead', type: 'SS', alive: false, history: [] },
    ],
  }, checkedAt);
  assert.deepEqual(nodes.map((node) => node.name), ['fast', 'slow', 'dead']);
  assert.equal(nodes[0].latencyMs, 100);
  assert.equal(nodes[1].status, 'slow');
  assert.equal(nodes[2].status, 'unavailable');
});

test('import stores the secret URL encrypted, reloads Mihomo, checks nodes, and pins an upstream', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-proxy-pool-'));
  const store = new MemoryStore();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body || '' });
    if (String(url).startsWith('https://sub.example.com/')) {
      return new Response('proxies:\n  - {name: Tokyo, type: ss, server: proxy.example.com, port: 443, cipher: aes-128-gcm, password: test}', { status: 200 });
    }
    if (String(url).endsWith('/healthcheck')) return new Response(null, { status: 204 });
    if (String(url).includes('/providers/proxies/frosted-subscription')) {
      return Response.json({ proxies: [{ name: 'Tokyo', type: 'Shadowsocks', alive: true, history: [{ delay: 128 }] }] });
    }
    return new Response(null, { status: 204 });
  };
  const manager = new ProxyPoolManager(store, {
    fetchImpl,
    lookup: publicLookup,
    sharedDir: directory,
    runtimePath: path.join(directory, 'config.yaml'),
    controllerUrl: 'http://mihomo.test:9090',
    controllerSecret: 'controller-secret',
  });

  const result = await manager.importSubscription('https://sub.example.com/list?token=top-secret');
  const snapshot = store.snapshot();
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.assigned, 1);
  assert.equal(snapshot.upstreams[0].proxyNodeName, 'Tokyo');
  assert.equal(Number.isInteger(snapshot.upstreams[0].proxyPort), true);
  assert.ok(snapshot.proxyPool.subscriptionUrlEncrypted);
  assert.doesNotMatch(snapshot.proxyPool.subscriptionUrlEncrypted, /top-secret/);
  assert.equal((await fs.readFile(path.join(directory, 'providers', 'subscription.txt'), 'utf8')).startsWith('proxies:'), true);
  const runtime = await fs.readFile(path.join(directory, 'config.yaml'), 'utf8');
  assert.match(runtime, /frosted-subscription/);
  assert.doesNotMatch(runtime, /sub\.example\.com|top-secret/);
  assert.ok(calls.some((call) => call.method === 'PUT' && call.url.includes('/configs')));
  assert.ok(calls.some((call) => call.method === 'PUT' && call.url.includes('/proxies/FROSTED-')));
  await fs.rm(directory, { recursive: true, force: true });
});

test('subscription downloader pins every redirect hop to the DNS addresses that passed validation', async () => {
  const lookupCalls = [];
  const dispatcherCalls = [];
  const dispatchers = new Map([
    ['sub.example.com', { id: 'pinned-subscription-dispatcher' }],
    ['cdn.example.com', { id: 'pinned-cdn-dispatcher' }],
  ]);
  const lookup = async (hostname) => {
    lookupCalls.push(hostname);
    return hostname === 'sub.example.com'
      ? [{ address: '8.8.8.8', family: 4 }]
      : [{ address: '1.1.1.1', family: 4 }];
  };
  const dispatcherFactory = ({ url, addresses }) => {
    dispatcherCalls.push({
      hostname: url.hostname,
      addresses: structuredClone(addresses),
    });
    return dispatchers.get(url.hostname);
  };

  const content = await downloadSubscription('https://sub.example.com/start', {
    lookup,
    dispatcherFactory,
    fetchImpl: async (url, options) => {
      const hostname = new URL(url).hostname;
      assert.equal(options.dispatcher, dispatchers.get(hostname));
      if (hostname === 'sub.example.com') {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/list' } });
      }
      return new Response('ss://pinned-node', { status: 200 });
    },
  });

  assert.equal(content, 'ss://pinned-node');
  assert.deepEqual(lookupCalls, ['sub.example.com', 'cdn.example.com']);
  assert.deepEqual(dispatcherCalls, [
    { hostname: 'sub.example.com', addresses: [{ address: '8.8.8.8', family: 4 }] },
    { hostname: 'cdn.example.com', addresses: [{ address: '1.1.1.1', family: 4 }] },
  ]);
});

test('Clash fake-IP DNS falls back to trusted public resolution before pinning', async () => {
  const dispatcher = { id: 'doh-pinned-dispatcher' };
  let pinnedAddresses = [];
  let connectionAddresses = [];
  const content = await downloadSubscription('https://sub.example.com/list', {
    lookup: async () => [{ address: '198.18.7.9', family: 4 }],
    fallbackLookup: async () => [{ address: '1.1.1.1', family: 4 }],
    dispatcherFactory: ({ addresses, connectionAddresses: connections }) => {
      pinnedAddresses = structuredClone(addresses);
      connectionAddresses = structuredClone(connections);
      return dispatcher;
    },
    fetchImpl: async (url, options) => {
      assert.equal(options.dispatcher, dispatcher);
      return new Response('ss://doh-node', { status: 200 });
    },
  });
  assert.equal(content, 'ss://doh-node');
  assert.deepEqual(pinnedAddresses, [{ address: '1.1.1.1', family: 4 }]);
  assert.deepEqual(connectionAddresses, [{ address: '1.1.1.1', family: 4 }]);
});

test('subscription import is rejected before download while the upstream has an active lease', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new MemoryStore();
    let fetchCalls = 0;
    const manager = new ProxyPoolManager(store, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('network access must not start while a lease is active');
      },
      lookup: publicLookup,
      sharedDir: directory,
      runtimePath: path.join(directory, 'config.yaml'),
      controllerUrl: 'http://mihomo.test:9090',
    });
    const lease = holdUpstreamLease();
    try {
      await assert.rejects(
        () => manager.importSubscription('https://sub.example.com/list'),
        (error) => error?.code === 'PROXY_LEASE_ACTIVE' && error?.statusCode === 409,
      );
      assert.equal(fetchCalls, 0);
    } finally {
      lease.release();
      await lease.completed;
    }
  });
});

test('sync refuses to switch a directly collecting upstream to proxy mode while its lease is active', async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new MemoryStore();
    store.data.upstreams[0].proxyMode = 'direct';
    store.data.proxyPool.subscriptionUrlEncrypted = 'existing-encrypted-subscription';
    const providerPath = path.join(directory, 'providers', 'subscription.txt');
    await fs.mkdir(path.dirname(providerPath), { recursive: true });
    await fs.writeFile(providerPath, 'ss://existing-node', 'utf8');
    const manager = new ProxyPoolManager(store, {
      fetchImpl: async () => {
        throw new Error('controller access must not start while a lease is active');
      },
      lookup: publicLookup,
      sharedDir: directory,
      runtimePath: path.join(directory, 'config.yaml'),
      controllerUrl: 'http://mihomo.test:9090',
    });
    const lease = holdUpstreamLease();
    store.data.upstreams[0].proxyMode = 'auto_sticky';
    try {
      await assert.rejects(
        () => manager.sync(),
        (error) => error?.code === 'PROXY_LEASE_ACTIVE' && error?.statusCode === 409,
      );
    } finally {
      lease.release();
      await lease.completed;
    }
  });
});

test('manual reassignment is rejected while the upstream has an active lease', async () => {
  const store = new MemoryStore();
  store.data.proxyPool.nodes = [
    { id: 'node-a', name: 'Node A', type: 'SS', status: 'available', latencyMs: 80, lastCheckedAt: '2026-07-14T00:00:00.000Z' },
    { id: 'node-b', name: 'Node B', type: 'SS', status: 'available', latencyMs: 90, lastCheckedAt: '2026-07-14T00:00:00.000Z' },
  ];
  store.data.upstreams[0].proxyNodeName = 'Node A';
  const manager = new ProxyPoolManager(store, {
    fetchImpl: async () => new Response(null, { status: 204 }),
    lookup: publicLookup,
    controllerUrl: 'http://mihomo.test:9090',
  });
  const lease = holdUpstreamLease();
  try {
    await assert.rejects(
      () => manager.reassign('upstream-1'),
      (error) => error?.code === 'PROXY_LEASE_ACTIVE' && error?.statusCode === 409,
    );
    assert.equal(store.snapshot().upstreams[0].proxyNodeName, 'Node A');
  } finally {
    lease.release();
    await lease.completed;
  }
});

for (const failureStage of ['reload', 'check']) {
  test(`failed ${failureStage} restores the previous provider, subscription, nodes, and assignments`, async () => {
    await withTemporaryDirectory(async (directory) => {
      const store = new MemoryStore();
      const oldCheckedAt = '2026-07-13T08:00:00.000Z';
      const oldProvider = 'ss://previous-provider-content';
      const oldNode = {
        id: 'old-node',
        name: 'Previous Node',
        type: 'Shadowsocks',
        status: 'available',
        latencyMs: 72,
        lastCheckedAt: oldCheckedAt,
      };
      Object.assign(store.data.proxyPool, {
        subscriptionUrlEncrypted: 'previous-encrypted-subscription',
        subscriptionUpdatedAt: '2026-07-13T07:00:00.000Z',
        lastCheckedAt: oldCheckedAt,
        lastError: '',
        nodes: [oldNode],
      });
      Object.assign(store.data.upstreams[0], {
        proxyNodeName: oldNode.name,
        proxyPort: 32110,
        proxyAssignedAt: '2026-07-13T07:30:00.000Z',
        proxyStatus: oldNode.status,
        proxyLatencyMs: oldNode.latencyMs,
        proxyLastCheckedAt: oldNode.lastCheckedAt,
      });
      const before = store.snapshot();
      const providerPath = path.join(directory, 'providers', 'subscription.txt');
      await fs.mkdir(path.dirname(providerPath), { recursive: true });
      await fs.writeFile(providerPath, oldProvider, 'utf8');

      const manager = new ProxyPoolManager(store, {
        lookup: publicLookup,
        sharedDir: directory,
        runtimePath: path.join(directory, 'config.yaml'),
        controllerUrl: 'http://mihomo.test:9090',
        fetchImpl: async (url, options = {}) => {
          const requestUrl = String(url);
          const method = options.method || 'GET';
          if (requestUrl.startsWith('https://sub.example.com/')) {
            return new Response('proxies:\n  - {name: Replacement, type: ss, server: proxy.example.com, port: 443, cipher: aes-128-gcm, password: fixture-password}', { status: 200 });
          }
          if (requestUrl.includes('/configs?force=true')) {
            return failureStage === 'reload'
              ? new Response(null, { status: 500 })
              : new Response(null, { status: 204 });
          }
          if (requestUrl.endsWith('/healthcheck')) return new Response(null, { status: 204 });
          if (requestUrl.includes('/providers/proxies/frosted-subscription')) {
            return Response.json({
              proxies: [{ name: 'Replacement', type: 'Shadowsocks', alive: true, history: [{ delay: 55 }] }],
            });
          }
          if (method === 'PUT' && requestUrl.includes('/proxies/FROSTED-')) {
            return new Response(null, { status: 500 });
          }
          return new Response(null, { status: 204 });
        },
      });
      let retryScheduled = 0;
      manager.startSyncRetry = () => { retryScheduled += 1; };

      await assert.rejects(() => manager.importSubscription('https://sub.example.com/new?token=replacement'));

      const after = store.snapshot();
      assert.equal(await fs.readFile(providerPath, 'utf8'), oldProvider);
      assert.equal(after.proxyPool.subscriptionUrlEncrypted, before.proxyPool.subscriptionUrlEncrypted);
      assert.equal(after.proxyPool.subscriptionUpdatedAt, before.proxyPool.subscriptionUpdatedAt);
      assert.deepEqual(after.proxyPool.nodes, before.proxyPool.nodes);
      assert.deepEqual(assignmentSnapshot(after.upstreams[0]), assignmentSnapshot(before.upstreams[0]));
      assert.equal(retryScheduled, 1);
    });
  });
}
