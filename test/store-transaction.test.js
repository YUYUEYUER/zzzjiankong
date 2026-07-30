import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';

function fixtureData() {
  return {
    version: 3,
    upstreams: [{ id: 'upstream-1', name: 'Primary' }],
    accounts: [{ id: 'account-1', upstreamId: 'upstream-1', name: 'Account' }],
    snapshots: [{ id: 'snapshot-1', accountId: 'account-1' }],
    incidents: [{ id: 'incident-1', accountId: 'account-1', state: 'open' }],
    settings: { reminderHours: 6 },
    proxyPool: { nodes: [] },
    auth: { recoveryCodeHashes: [] },
    audit: [],
  };
}

async function createStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-store-transaction-'));
  const file = path.join(directory, 'db.json');
  await fs.writeFile(file, JSON.stringify(fixtureData(), null, 2), 'utf8');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file, store: await new JsonStore(file).init() };
}

test('a failed mutator leaves live state untouched and does not poison later writes', async (t) => {
  const { file, store } = await createStore(t);
  const before = store.snapshot();
  const diskBefore = await fs.readFile(file, 'utf8');

  await assert.rejects(store.mutate((data) => {
    data.settings.reminderHours = 99;
    throw new Error('business rule failed');
  }), /business rule failed/);

  assert.deepEqual(store.snapshot(), before);
  assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
  assert.equal(store.health().status, 'healthy');

  await store.mutate((data) => {
    data.settings.reminderHours = 12;
  });
  assert.equal(store.snapshot().settings.reminderHours, 12);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).settings.reminderHours, 12);
});

test('a persistence failure keeps memory and disk at the previous commit and can recover', async (t) => {
  const { file, store } = await createStore(t);
  const before = store.snapshot();
  const diskBefore = await fs.readFile(file, 'utf8');
  const originalPersist = store.persist.bind(store);
  const persistenceError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  store.persist = async () => { throw persistenceError; };

  await assert.rejects(store.mutate((data) => {
    data.settings.reminderHours = 24;
  }), (error) => error === persistenceError);
  await store.flush();

  assert.deepEqual(store.snapshot(), before);
  assert.equal(await fs.readFile(file, 'utf8'), diskBefore);
  const degraded = store.health();
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.lastSuccessfulWriteAt, null);
  assert.equal(degraded.lastErrorCode, 'ENOSPC');
  assert.ok(degraded.lastFailureAt);

  store.persist = originalPersist;
  await store.mutate((data) => {
    data.settings.reminderHours = 48;
  });
  assert.equal(store.snapshot().settings.reminderHours, 48);
  assert.equal(store.health().status, 'healthy');
  assert.ok(store.health().lastSuccessfulWriteAt);
});

test('concurrent mutations remain ordered, flush waits, and the committed file can reopen', async (t) => {
  const { file, store } = await createStore(t);
  const order = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = store.mutate(async (data) => {
    order.push('first:start');
    markFirstStarted();
    await firstGate;
    data.audit.push({ id: 'audit-first' });
    order.push('first:end');
  });
  await firstStarted;
  const second = store.mutate((data) => {
    order.push('second:start');
    assert.ok(data.audit.some((entry) => entry.id === 'audit-first'));
    data.audit.push({ id: 'audit-second' });
    order.push('second:end');
  });
  const flushed = store.flush();
  releaseFirst();

  await Promise.all([first, second, flushed]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.deepEqual(store.snapshot().audit.map((entry) => entry.id), ['audit-first', 'audit-second']);

  const reopened = await new JsonStore(file).init();
  assert.deepEqual(reopened.snapshot().audit.map((entry) => entry.id), ['audit-first', 'audit-second']);
});

test('graph validation rejects duplicate IDs and every orphan relation without poisoning the queue', async (t) => {
  const { store } = await createStore(t);
  assert.deepEqual(store.snapshot().notificationOutbox, []);
  const invalidMutations = [
    [(data) => data.upstreams.push({ ...data.upstreams[0] }), /上游 id 重复/],
    [(data) => { data.accounts[0].upstreamId = 'missing-upstream'; }, /账号 account-1 未关联有效上游/],
    [(data) => data.snapshots.push({ id: 'orphan-snapshot', accountId: 'missing-account' }), /快照 orphan-snapshot 未关联有效账号/],
    [(data) => data.incidents.push({ id: 'orphan-incident', accountId: 'missing-account' }), /事件 orphan-incident 未关联有效账号/],
    [(data) => data.notificationOutbox.push({ id: 'orphan-notification', accountId: 'missing-account' }), /通知事件 orphan-notification 未关联有效账号/],
  ];

  for (const [mutation, expected] of invalidMutations) {
    const before = store.snapshot();
    await assert.rejects(store.mutate(mutation), expected);
    assert.deepEqual(store.snapshot(), before);
  }

  await store.mutate((data) => data.audit.push({ id: 'audit-after-validation-errors' }));
  assert.ok(store.snapshot().audit.some((entry) => entry.id === 'audit-after-validation-errors'));
});

test('atomic persistence uses a private replacement file and removes temporary files', async (t) => {
  const { directory, file, store } = await createStore(t);
  await store.mutate((data) => data.audit.push({ id: 'audit-private-file' }));

  const names = await fs.readdir(directory);
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), []);
  if (process.platform !== 'win32') {
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
  }
});
