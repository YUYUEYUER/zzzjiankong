import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicNetworkAddress,
  parseUpstreamUrl,
  readLimitedBody,
  resolveUpstreamUrl,
} from '../server/network-policy.js';

test('production upstream URLs require HTTPS and never accept URL credentials', () => {
  assert.equal(parseUpstreamUrl('https://api.example.com/path', { production: true }).origin, 'https://api.example.com');
  assert.throws(() => parseUpstreamUrl('http://api.example.com', { production: true }), /HTTPS/);
  assert.throws(() => parseUpstreamUrl('https://user:pass@api.example.com', { production: true }), /用户名或密码/);
  assert.equal(parseUpstreamUrl('http://internal.example', {
    production: true,
    allowedHosts: ['internal.example'],
  }).origin, 'http://internal.example');
});

test('upstream DNS policy rejects private, mapped, and reserved address families', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.1.2', '::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicNetworkAddress(address), false, address);
  }
  assert.equal(isPublicNetworkAddress('93.184.216.34'), true);
  assert.equal(isPublicNetworkAddress('2606:2800:220:1:248:1893:25c8:1946'), true);

  const privateLookup = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    resolveUpstreamUrl('https://metadata.example', { production: true, allowPrivate: false, lookup: privateLookup }),
    /本机、内网或保留地址/,
  );
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const resolved = await resolveUpstreamUrl('https://api.example.com', { production: true, allowPrivate: false, lookup: publicLookup });
  assert.deepEqual(resolved.addresses, [{ address: '93.184.216.34', family: 4 }]);
});

test('upstream response reader enforces declared and streamed body limits', async () => {
  await assert.rejects(
    readLimitedBody(new Response('small', { headers: { 'Content-Length': '999' } }), 8),
    /大小限制/,
  );
  await assert.rejects(readLimitedBody(new Response('0123456789'), 8), /大小限制/);
  assert.equal(await readLimitedBody(new Response('{"ok":true}'), 64), '{"ok":true}');
});
