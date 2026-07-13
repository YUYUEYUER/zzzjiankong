import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { collectBalance } from '../server/collectors.js';
import { configureProxyRoutes } from '../server/proxy-pool.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('an upstream collector uses its assigned HTTP proxy route', async () => {
  const upstream = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: { balance: 42.5 } }));
  });
  const upstreamAddress = await listen(upstream);

  let tunnels = 0;
  const proxy = http.createServer();
  proxy.on('connect', (request, clientSocket, head) => {
    tunnels += 1;
    const [host, port] = request.url.split(':');
    const target = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      target.pipe(clientSocket);
      clientSocket.pipe(target);
    });
    target.on('error', () => clientSocket.destroy());
  });
  const proxyAddress = await listen(proxy);

  configureProxyRoutes([{
    id: 'upstream-proxied',
    proxyMode: 'auto_sticky',
    proxyPort: proxyAddress.port,
  }]);

  try {
    const result = await collectBalance({
      upstreamId: 'upstream-proxied',
      type: 'generic',
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      profilePath: '/profile',
      balancePath: 'data.balance',
      tokenPrefix: 'bearer',
    }, {});
    assert.equal(result.rawBalance, 42.5);
    assert.ok(tunnels > 0);
  } finally {
    configureProxyRoutes([]);
    await close(proxy);
    await close(upstream);
  }
});

test('an auto-sticky upstream never falls back to a direct request while Mihomo is not ready', async () => {
  let requests = 0;
  const upstream = http.createServer((request, response) => {
    requests += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: { balance: 42.5 } }));
  });
  const upstreamAddress = await listen(upstream);
  configureProxyRoutes([{
    id: 'upstream-not-ready',
    proxyMode: 'auto_sticky',
    proxyPort: 17890,
  }], { ready: false });

  try {
    await assert.rejects(() => collectBalance({
      upstreamId: 'upstream-not-ready',
      type: 'generic',
      baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      profilePath: '/profile',
      balancePath: 'data.balance',
      tokenPrefix: 'bearer',
    }, {}), (error) => error?.code === 'UPSTREAM_PROXY_NOT_READY');
    assert.equal(requests, 0);
  } finally {
    configureProxyRoutes([]);
    await close(upstream);
  }
});
