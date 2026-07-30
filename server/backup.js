import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { migrateData } from './store.js';

async function syncBestEffort(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (!['EPERM', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
  }
}

async function copyAtomic(source, destination) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, 'r');
    try {
      await syncBestEffort(handle);
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, destination);
    const directory = await fs.open(path.dirname(destination), 'r');
    try {
      await syncBestEffort(directory);
    } finally {
      await directory.close();
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function createBackup({ source = config.dataFile, destination = config.backupDir, keep = 30 } = {}) {
  const retention = Math.max(1, Math.min(365, Number.isFinite(Number(keep)) ? Math.trunc(Number(keep)) : 30));
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.chmod(destination, 0o700);
  const sourceContent = await fs.readFile(source);
  migrateData(JSON.parse(sourceContent.toString('utf8')));
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const suffix = crypto.randomBytes(4).toString('hex');
  const target = path.join(destination, `frosted-console-${stamp}-${suffix}.json`);
  await copyAtomic(source, target);
  const digest = crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');
  await fs.writeFile(`${target}.sha256`, `${digest}  ${path.basename(target)}\n`, { mode: 0o600 });
  const entries = (await fs.readdir(destination)).filter((entry) => entry.endsWith('.json')).sort().reverse();
  for (const stale of entries.slice(retention)) {
    await fs.rm(path.join(destination, stale), { force: true });
    await fs.rm(path.join(destination, `${stale}.sha256`), { force: true });
  }
  return { file: target, sha256: digest };
}

export async function restoreBackup(source, { destination = config.dataFile } = {}) {
  if (!source) throw new Error('恢复备份时必须指定 .json 备份文件');
  const content = await fs.readFile(source);
  const digestFile = `${source}.sha256`;
  try {
    const expected = (await fs.readFile(digestFile, 'utf8')).trim().split(/\s+/)[0];
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (expected !== actual) throw new Error('备份校验和不匹配');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('备份缺少校验和文件');
    throw error;
  }
  migrateData(JSON.parse(content.toString('utf8')));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await copyAtomic(source, destination);
  return destination;
}

const invokedFile = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedFile) {
  const [command = 'create', file] = process.argv.slice(2);
  if (!['create', 'restore'].includes(command)) throw new Error(`未知备份命令: ${command}`);
  const result = command === 'restore' ? await restoreBackup(file) : await createBackup();
  console.log(JSON.stringify(result));
}
