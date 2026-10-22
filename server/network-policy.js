import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';

const DNS_LOOKUP_TIMEOUT_MS = 6_000;
const MAX_RESOLVED_ADDRESSES = 32;

const blockedAddresses = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(address, prefix, 'ipv4');

for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:2::', 48], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  // IPv4-compatible and deprecated site-local IPv6 ranges must not be used as
  // an alternate spelling of loopback/private destinations.
  ['::', 96], ['fec0::', 10],
  // NAT64 转换前缀可把流量导向任意 IPv4（含内网）；Teredo 隧道同理可达映射地址。
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2001::', 32],
]) blockedAddresses.addSubnet(address, prefix, 'ipv6');

function policyError(message, statusCode = 400, code = 'UPSTREAM_URL_BLOCKED') {
  return Object.assign(new Error(message), { statusCode, code });
}

export function isPublicNetworkAddress(address) {
  const value = String(address || '').trim();
  const family = net.isIP(value);
  if (!family) return false;
  if (family === 6 && value.toLowerCase().startsWith('::ffff:')) {
    // dns.lookup() may return an IPv4-mapped address in either dotted or
    // canonical hexadecimal form (for example ::ffff:7f00:1). Convert the
    // latter before applying the IPv4 policy so a private mapped address
    // cannot bypass the block list.
    const mapped = value.slice(value.indexOf(':ffff:') + 6);
    const parts = mapped.split(':');
    let ipv4 = '';
    if (parts.length === 1 && net.isIP(mapped) === 4) {
      ipv4 = mapped;
    } else if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
      const high = Number.parseInt(parts[0], 16);
      const low = Number.parseInt(parts[1], 16);
      ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    }
    return ipv4 ? isPublicNetworkAddress(ipv4) : false;
  }
  return !blockedAddresses.check(value, family === 4 ? 'ipv4' : 'ipv6');
}

function normalizeHostname(value) {
  return String(value || '').toLowerCase().replace(/\.$/, '');
}

function allowlisted(hostname, allowedHosts = []) {
  const candidate = normalizeHostname(hostname);
  return allowedHosts.some((entry) => normalizeHostname(entry) === candidate);
}

export function parseUpstreamUrl(value, {
  production = false,
  allowedHosts = [],
} = {}) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw policyError('上游地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw policyError('上游地址仅支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw policyError('上游地址不能在 URL 中携带用户名或密码');
  if (!url.hostname) throw policyError('上游地址缺少主机名');
  if (production && url.protocol !== 'https:' && !allowlisted(url.hostname, allowedHosts)) {
    throw policyError('生产环境的上游地址必须使用 HTTPS');
  }
  url.hash = '';
  return url;
}

export async function resolveUpstreamUrl(value, {
  lookup = dns.lookup,
  production = false,
  allowedHosts = [],
  allowPrivate = !production,
} = {}) {
  const url = parseUpstreamUrl(value, { production, allowedHosts });
  const hostAllowed = allowlisted(url.hostname, allowedHosts);
  let addresses;
  try {
    let timeout;
    addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS lookup timeout')), DNS_LOOKUP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
  } catch {
    throw policyError('无法解析上游域名', 502, 'UPSTREAM_DNS_FAILED');
  }
  addresses = Array.isArray(addresses) ? addresses : [addresses];
  if (!addresses.length || addresses.length > MAX_RESOLVED_ADDRESSES || addresses.some((entry) => !net.isIP(String(entry?.address || '').trim()))) {
    throw policyError('无法解析上游域名', 502, 'UPSTREAM_DNS_FAILED');
  }
  if (!allowPrivate && !hostAllowed && addresses.some((entry) => !isPublicNetworkAddress(entry.address))) {
    throw policyError('上游地址解析到了本机、内网或保留地址');
  }
  return {
    url,
    addresses: addresses.map((entry) => {
      const address = String(entry.address).trim();
      const detectedFamily = net.isIP(address);
      const family = Number(entry.family);
      return { address, family: family === 4 || family === 6 ? family : detectedFamily };
    }),
  };
}

export function createPinnedDispatcher({ url, addresses }) {
  const hostname = normalizeHostname(url.hostname);
  const pinned = (Array.isArray(addresses) ? addresses : [])
    .map((entry) => {
      const address = String(entry?.address || '').trim();
      const detectedFamily = net.isIP(address);
      const family = Number(entry?.family);
      return { address, family: family === 4 || family === 6 ? family : detectedFamily };
    })
    .filter((entry) => entry.family && net.isIP(entry.address) === entry.family);
  if (!hostname || !pinned.length) throw policyError('上游域名没有可用的已校验地址', 502);
  return new Agent({
    headersTimeout: 12_000,
    bodyTimeout: 12_000,
    connect: {
      lookup(requestedHostname, options, callback) {
        if (normalizeHostname(requestedHostname) !== hostname) {
          callback(policyError('上游连接尝试解析未校验的域名', 502));
          return;
        }
        const family = Number(options?.family || 0);
        const candidates = family ? pinned.filter((entry) => entry.family === family) : pinned;
        if (!candidates.length) {
          callback(policyError('上游域名没有匹配的已校验地址', 502));
          return;
        }
        if (options?.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      },
    },
  });
}

export async function readLimitedBody(response, maxBytes = 2 * 1024 * 1024) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw policyError('上游响应正文超过大小限制', 502, 'UPSTREAM_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw policyError('上游响应正文超过大小限制', 502, 'UPSTREAM_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
