import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createBackup } from './backup.js';
import { decryptSecret, encryptSecret } from './security.js';
import { JsonStore } from './store.js';

const lockFile = `${config.dataFile}.master-key-rotation.lock`;

async function acquireLock() {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fs.open(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0) throw error;
      let pid = 0;
      try {
        pid = Number.parseInt(await fs.readFile(lockFile, 'utf8'), 10);
      } catch {
        throw error;
      }
      if (!Number.isInteger(pid) || pid <= 0) throw error;
      try {
        process.kill(pid, 0);
        throw error;
      } catch (probeError) {
        if (probeError === error || !['ESRCH'].includes(probeError.code)) throw error;
        await fs.rm(lockFile, { force: true });
      }
    }
  }
  throw new Error('unable to acquire master-key rotation lock');
}

function rotateField(target, field) {
  if (!target?.[field]) return false;
  target[field] = encryptSecret(decryptSecret(target[field]));
  return true;
}

export async function rotateMasterKey({ store = new JsonStore(), backup = createBackup } = {}) {
  let lock;
  try {
    lock = await acquireLock();
    await lock.writeFile(`${process.pid}\n`, 'utf8');
    await lock.sync();
    await backup();
    await store.init();
    let rotated = 0;
    await store.mutate((data) => {
      for (const account of data.accounts) rotated += Number(rotateField(account, 'encryptedSecret'));
      rotated += Number(rotateField(data.settings, 'resendApiKeyEncrypted'));
      rotated += Number(rotateField(data.settings, 'feishuWebhookEncrypted'));
      rotated += Number(rotateField(data.proxyPool, 'subscriptionUrlEncrypted'));
      rotated += Number(rotateField(data.auth, 'totpSecretEncrypted'));
      rotated += Number(rotateField(data.auth, 'pendingTotpEncrypted'));
    });
    await store.flush();
    return { rotated, keyId: config.masterKeyId, dataFile: path.resolve(config.dataFile) };
  } finally {
    if (lock) {
      await lock.close().catch(() => undefined);
      await fs.rm(lockFile, { force: true }).catch(() => undefined);
    }
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedFile) {
  try {
    console.log(JSON.stringify(await rotateMasterKey()));
  } catch (error) {
    console.error(`[master-key] ${error.message}`);
    process.exitCode = 1;
  }
}
