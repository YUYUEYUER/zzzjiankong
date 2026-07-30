import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBackup, restoreBackup } from '../server/backup.js';
import { decryptSecret, encryptSecret } from '../server/security.js';

function legacyCiphertext(value, masterKey) {
  const key = crypto.createHash('sha256').update(masterKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString('base64url')).join('.');
}

test('rotated master keys read legacy ciphertext and write versioned ciphertext', () => {
  const value = { accessToken: 'old-token' };
  const payload = legacyCiphertext(value, 'legacy-master-key');
  const script = `
    import { decryptSecret, encryptSecret } from './server/security.js';
    const result = decryptSecret(${JSON.stringify(payload)});
    const current = encryptSecret({ accessToken: 'new-token' });
    console.log(JSON.stringify({ result, parts: current.split('.').length }));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      MASTER_KEY: 'current-master-key',
      MASTER_KEY_ID: 'current',
      PREVIOUS_MASTER_KEYS: 'legacy:legacy-master-key',
      TURNSTILE_SOLVER: 'none',
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(output.result, value);
  assert.equal(output.parts, 4);
  assert.equal(encryptSecret({ ok: true }).split('.').length, 4);
});

test('duplicate encryption key ids are rejected during startup', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import './server/security.js'"], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      MASTER_KEY: 'current-master-key',
      MASTER_KEY_ID: 'current',
      PREVIOUS_MASTER_KEYS: 'current:legacy-master-key',
      TURNSTILE_SOLVER: 'none',
    },
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /duplicated/i);
});

test('backups are checksummed, restored atomically, and tampering is rejected', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-backup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.json');
  const backupDir = path.join(directory, 'backups');
  const restored = path.join(directory, 'restored.json');
  const data = JSON.stringify({
    version: 3,
    upstreams: [],
    accounts: [],
    snapshots: [],
    incidents: [],
    settings: {},
    proxyPool: { nodes: [] },
    auth: {},
    audit: [],
    notificationOutbox: [],
  });
  await fs.writeFile(source, data, { mode: 0o600 });

  const backup = await createBackup({ source, destination: backupDir, keep: 1 });
  assert.equal(await fs.readFile(backup.file, 'utf8'), data);
  assert.match(await fs.readFile(`${backup.file}.sha256`, 'utf8'), new RegExp(backup.sha256));
  await restoreBackup(backup.file, { destination: restored });
  assert.equal(await fs.readFile(restored, 'utf8'), data);

  await fs.writeFile(backup.file, `${data}x`);
  await assert.rejects(restoreBackup(backup.file, { destination: restored }), /校验|checksum|匹配/i);
  assert.equal(await fs.readFile(restored, 'utf8'), data);
});
