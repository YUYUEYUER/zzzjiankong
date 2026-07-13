import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore, migrateData } from '../server/store.js';

function v1Data() {
  return {
    version: 1,
    accounts: [
      { id: 'acct-real', name: 'NewCLI 真实账户', encryptedSecret: 'ciphertext.must.stay.identical', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 'acct-demo', name: '演示账号', encryptedSecret: '' },
    ],
    snapshots: [{ id: 'snap-1', accountId: 'acct-real' }],
    incidents: [{ id: 'inc-1', accountId: 'acct-real' }],
    settings: { recoveryConfirmations: 2 },
    audit: [{ id: 'audit-1', accountId: 'acct-real' }],
  };
}

test('v1 migration adds one upstream per account without touching credentials or history', () => {
  const ids = ['upstream-real', 'upstream-demo'];
  const source = v1Data();
  const result = migrateData(source, () => ids.shift());

  assert.equal(result.changed, true);
  assert.equal(result.data.version, 2);
  assert.deepEqual(result.data.upstreams.map((upstream) => upstream.id), ['upstream-real', 'upstream-demo']);
  assert.deepEqual(result.data.accounts.map((account) => account.upstreamId), ['upstream-real', 'upstream-demo']);
  assert.equal(result.data.accounts[0].encryptedSecret, source.accounts[0].encryptedSecret);
  assert.deepEqual(result.data.snapshots, source.snapshots);
  assert.deepEqual(result.data.incidents, source.incidents);
  assert.deepEqual(result.data.audit, source.audit);

  const second = migrateData(result.data);
  assert.equal(second.changed, false);
  assert.deepEqual(second.data, result.data);
});

test('JsonStore writes an exact v1 backup before persisting migration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-store-migration-'));
  const file = path.join(dir, 'db.json');
  const raw = JSON.stringify(v1Data(), null, 4);
  await fs.writeFile(file, raw, 'utf8');

  const store = await new JsonStore(file).init();
  const backup = await fs.readFile(`${file}.v1.bak`, 'utf8');
  assert.equal(backup, raw);
  assert.equal(store.snapshot().version, 2);
  assert.equal(store.snapshot().accounts[0].encryptedSecret, 'ciphertext.must.stay.identical');

  await fs.rm(dir, { recursive: true, force: true });
});

test('migration rejects unknown future versions', () => {
  assert.throws(() => migrateData({ ...v1Data(), version: 99 }), /高于当前支持版本/);
});
