import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parse } from 'yaml';

const digestPattern = /@sha256:[a-f0-9]{64}$/;

async function readYaml(file) {
  return parse(await fs.readFile(file, 'utf8'));
}

test('production containers do not publish the application or noVNC ports', async () => {
  const base = await readYaml('docker-compose.yml');
  const server = await readYaml('docker-compose.server.yml');
  const app = base.services['frosted-console'];

  assert.equal(app.ports, undefined);
  assert.equal(app.ipc, undefined);
  assert.equal(app.shm_size, '1gb');
  assert.deepEqual(app.cap_drop, ['ALL']);
  assert.deepEqual(app.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID', 'SYS_CHROOT']);
  assert.ok(app.security_opt.includes('no-new-privileges:true'));
  assert.deepEqual(server.services['frosted-console'].expose, ['8787', '6080']);
});

test('loopback application and noVNC ports exist only in the development override', async () => {
  const development = await readYaml('docker-compose.dev.yml');
  assert.deepEqual(development.services['frosted-console'].ports, [
    '127.0.0.1:${PORT:-8787}:8787',
    '127.0.0.1:${NOVNC_PORT:-6080}:6080',
  ]);
});

test('all production base images are pinned to sha256 digests', async () => {
  const dockerfile = await fs.readFile('Dockerfile', 'utf8');
  const fromImages = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  assert.ok(fromImages.length > 0);
  for (const image of fromImages) assert.match(image, digestPattern);

  const base = await readYaml('docker-compose.yml');
  const server = await readYaml('docker-compose.server.yml');
  assert.match(base.services.mihomo.image, digestPattern);
  assert.match(server.services.caddy.image, digestPattern);
});

test('the Linux deployment script is UTF-8 with LF line endings', async () => {
  const source = await fs.readFile('deploy-linux.sh');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  assert.equal(decoded.includes('\r'), false);
  assert.equal(decoded.includes('\uFFFD'), false);
});

test('GitHub Actions dependencies are pinned to full commit SHAs', async () => {
  const workflow = await fs.readFile('.github/workflows/security-regression.yml', 'utf8');
  const references = [...workflow.matchAll(/uses:\s*[^\s#]+@([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) assert.match(reference, /^[a-f0-9]{40}$/);
});
