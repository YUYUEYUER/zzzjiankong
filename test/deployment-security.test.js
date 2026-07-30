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

  assert.equal(app.image, '${FROSTED_CONSOLE_IMAGE:-ghcr.io/yuyueyuer/frosted-console:latest}');
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

test('one-click Linux deployment generates secrets, builds, and waits for health', async () => {
  const script = await fs.readFile('deploy-linux.sh', 'utf8');
  for (const secret of ['MASTER_KEY', 'SESSION_SECRET', 'MIHOMO_SECRET', 'BOOTSTRAP_TOKEN']) {
    assert.match(script, new RegExp(`ensure_secret ${secret}`));
  }
  assert.match(script, /up -d --build --force-recreate --remove-orphans/);
  assert.match(script, /pull frosted-console/);
  assert.match(script, /up -d --no-build --force-recreate --remove-orphans/);
  assert.match(script, /\.State\.Health/);
  assert.match(script, /app_health.*healthy/);
});

test('GitHub Actions dependencies are pinned to full commit SHAs', async () => {
  const files = await fs.readdir('.github/workflows');
  const workflows = await Promise.all(
    files.filter((file) => /\.ya?ml$/i.test(file)).map((file) => fs.readFile(`.github/workflows/${file}`, 'utf8')),
  );
  const references = workflows.flatMap((workflow) =>
    [...workflow.matchAll(/uses:\s*[^\s#]+@([^\s#]+)/g)].map((match) => match[1]),
  );
  assert.ok(references.length > 0);
  for (const reference of references) assert.match(reference, /^[a-f0-9]{40}$/);
});

test('GHCR publishing uses the repository token and immutable revision tags', async () => {
  const source = await fs.readFile('.github/workflows/security-regression.yml', 'utf8');
  const workflow = await readYaml('.github/workflows/security-regression.yml');
  const publish = workflow.jobs['publish-ghcr'];

  assert.deepEqual(publish.needs, ['verify', 'sbom']);
  assert.equal(publish.permissions.contents, 'read');
  assert.equal(publish.permissions.packages, 'write');
  assert.equal(publish.env.IMAGE_NAME, 'ghcr.io/yuyueyuer/frosted-console');
  assert.match(source, /secrets\.GITHUB_TOKEN/);
  assert.match(source, /--platform linux\/amd64/);
  assert.match(source, /immutable_tag=.*sha-\$\{revision\}/);
  assert.match(source, /if ! docker pull "\$immutable_tag"/);
  assert.doesNotMatch(source, /ghp_[A-Za-z0-9]+/);
});
