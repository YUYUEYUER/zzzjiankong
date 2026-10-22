import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  assert.equal(app.mem_limit, '${APP_MEMORY_LIMIT:-4g}');
  assert.equal(app.pids_limit, '${APP_PIDS_LIMIT:-512}');
  assert.equal(base.services.mihomo.mem_limit, '${MIHOMO_MEMORY_LIMIT:-512m}');
  assert.equal(app.ports, undefined);
  assert.equal(app.ipc, undefined);
  assert.equal(app.shm_size, '1gb');
  assert.deepEqual(app.cap_drop, ['ALL']);
  assert.deepEqual(app.cap_add, ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID', 'SYS_CHROOT']);
  assert.ok(app.security_opt.includes('no-new-privileges:true'));
  assert.deepEqual(server.services['frosted-console'].expose, ['8787']);
});

test('the desktop data path is terminated by the authenticated application gateway', async () => {
  const entrypoint = await fs.readFile('server/docker-entrypoint.sh', 'utf8');
  const caddyfile = await fs.readFile('docker/Caddyfile', 'utf8');
  const server = await readYaml('docker-compose.server.yml');

  // websockify 只绑容器回环；noVNC 静态资源由应用（8787）认证托管
  assert.match(entrypoint, /websockify --web=\/usr\/share\/novnc "\$novnc_bind:6080"/);
  assert.doesNotMatch(entrypoint, /websockify --web=\S+ 0\.0\.0\.0/);
  // Caddy 不再剥 /browser 前缀，也不再直连 6080
  assert.match(caddyfile, /handle \/browser\/websockify\* \{/);
  assert.match(caddyfile, /handle \/browser\/\* \{/);
  assert.doesNotMatch(caddyfile, /handle_path \/browser/);
  assert.doesNotMatch(caddyfile, /6080/);
  assert.deepEqual(server.services['frosted-console'].expose, ['8787']);
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

test('production dependencies exclude frontend build tools and the runtime image removes npm', async () => {
  const packageLock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
  const root = packageLock.packages[''];
  const buildOnly = [
    '@fontsource-variable/inter',
    '@marsidev/react-turnstile',
    '@phosphor-icons/react',
    '@vitejs/plugin-react',
    'chart.js',
    'chartjs-plugin-annotation',
    'motion',
    'react',
    'react-chartjs-2',
    'react-dom',
    'vite',
  ];
  for (const dependency of buildOnly) {
    assert.equal(root.dependencies?.[dependency], undefined);
    assert.ok(root.devDependencies?.[dependency]);
  }

  const dockerfile = await fs.readFile('Dockerfile', 'utf8');
  assert.match(dockerfile, /rm -rf "\$npm_global_root\/npm"/);
  assert.match(dockerfile, /rm -f \/usr\/bin\/npm \/usr\/bin\/npx/);
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
  assert.match(script, /memory_kb < 6 \* 1024 \* 1024/);
  assert.match(script, /upsert_env TURNSTILE_BROWSER_CONCURRENCY "1"/);
  assert.match(script, /upsert_env UPSTREAM_BROWSER_MAX_ACTIVE "1"/);
});

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function runPrepareFixture({ memoryKb, swapKb, existing = {} }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-deploy-'));
  const bin = path.join(directory, 'bin');
  await fs.mkdir(bin);
  await Promise.all([
    fs.copyFile('deploy-linux.sh', path.join(directory, 'deploy-linux.sh')),
    fs.copyFile('.env.example', path.join(directory, '.env.example')),
  ]);
  await fs.writeFile(path.join(directory, 'meminfo'), `MemTotal:       ${memoryKb} kB\nSwapTotal:      ${swapKb} kB\n`);
  await fs.writeFile(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'openssl'), '#!/usr/bin/env bash\nprintf %064d 0\n', { mode: 0o755 });
  if (Object.keys(existing).length) {
    const source = await fs.readFile('.env.example', 'utf8');
    const configured = source.split(/\r?\n/).map((line) => {
      const separator = line.indexOf('=');
      const key = separator > 0 ? line.slice(0, separator) : '';
      return key in existing ? `${key}=${existing[key]}` : line;
    }).join('\n');
    await fs.writeFile(path.join(directory, '.env'), configured);
  }

  const output = await new Promise((resolve, reject) => {
    const child = spawn('bash', ['deploy-linux.sh', 'panel.example.com', '--build'], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FROSTED_MEMINFO_FILE: path.join(directory, 'meminfo'),
        FROSTED_PREPARE_ONLY: 'true',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${stdout}\n${stderr}`)));
  });
  const env = parseEnv(await fs.readFile(path.join(directory, '.env'), 'utf8'));
  await fs.rm(directory, { recursive: true, force: true });
  return { env, ...output };
}

test('low-memory deployment profile is applied only to a newly created environment', { skip: process.platform !== 'linux' }, async () => {
  const low = await runPrepareFixture({ memoryKb: 4 * 1024 * 1024, swapKb: 0 });
  assert.equal(low.env.APP_MEMORY_LIMIT, '2560m');
  assert.equal(low.env.MIHOMO_MEMORY_LIMIT, '256m');
  assert.equal(low.env.TURNSTILE_BROWSER_CONCURRENCY, '1');
  assert.equal(low.env.UPSTREAM_BROWSER_MAX_ACTIVE, '1');
  assert.match(low.stdout, /最多同时运行 2 个浏览器/);
  assert.match(low.stderr, /建议配置 2 GB Swap/);

  const high = await runPrepareFixture({ memoryKb: 8 * 1024 * 1024, swapKb: 2 * 1024 * 1024 });
  assert.equal(high.env.APP_MEMORY_LIMIT, '4g');
  assert.equal(high.env.TURNSTILE_BROWSER_CONCURRENCY, '2');

  const existing = await runPrepareFixture({
    memoryKb: 4 * 1024 * 1024,
    swapKb: 0,
    existing: { APP_MEMORY_LIMIT: '3500m', TURNSTILE_BROWSER_CONCURRENCY: '3' },
  });
  assert.equal(existing.env.APP_MEMORY_LIMIT, '3500m');
  assert.equal(existing.env.TURNSTILE_BROWSER_CONCURRENCY, '3');
  assert.doesNotMatch(existing.stdout, /最多同时运行 2 个浏览器/);
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
