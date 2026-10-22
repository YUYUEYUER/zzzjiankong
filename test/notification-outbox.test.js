import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore } from '../server/store.js';
import { Monitor } from '../server/monitor.js';
import { encryptSecret } from '../server/security.js';

async function preparedMonitor(notifier) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-outbox-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  await store.mutate((data) => {
    const account = data.accounts.find((item) => item.id === 'acct-us-backup');
    account.demo = false;
    account.thresholdLow = 20;
    account.encryptedSecret = encryptSecret({ accessToken: 'outbox-test-token' });
    data.incidents = data.incidents.filter((item) => item.accountId !== account.id);
  });
  const monitor = new Monitor(store, { collector: async () => ({ rawBalance: 1, metadata: {} }) });
  monitor.outbox.notifier = notifier;
  return { dir, store, monitor };
}

test('incident transition is persisted before notification dispatch and can resume after a lease expires', async () => {
  let calls = 0;
  const { dir, store, monitor } = await preparedMonitor(async () => {
    calls += 1;
    if (calls === 1) throw new Error('simulated crash before provider result');
    return { resend: { status: 'sent', attemptedAt: new Date().toISOString() }, feishu: { status: 'disabled', attemptedAt: null }, telegram: { status: 'disabled', attemptedAt: null } };
  });
  try {
    await monitor.poll('acct-us-backup');
    let event = store.snapshot().notificationOutbox[0];
    assert.equal(event.status, 'processing');
    assert.equal(store.snapshot().incidents.some((item) => item.state === 'open'), true);

    await store.mutate((data) => {
      data.notificationOutbox[0].leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
      data.notificationOutbox[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    });
    await monitor.outbox.drain();
    event = store.snapshot().notificationOutbox[0];
    assert.equal(event.status, 'completed');
    assert.equal(calls, 2);
    assert.equal(store.snapshot().incidents[0].notifications.opened.results.resend.status, 'sent');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('partial channel success only retries the failed channel', async () => {
  const seen = [];
  const { dir, store, monitor } = await preparedMonitor(async (_kind, _account, _incident, _settings, _secrets, options) => {
    seen.push(options.channels);
    if (seen.length === 1) return {
      resend: { status: 'sent', attemptedAt: new Date().toISOString(), externalId: 'resend-1' },
      feishu: { status: 'failed', retryable: true, attemptedAt: new Date().toISOString(), message: 'retry' },
      telegram: { status: 'disabled', attemptedAt: null },
    };
    return { feishu: { status: 'sent', attemptedAt: new Date().toISOString() } };
  });
  try {
    await monitor.poll('acct-us-backup');
    assert.deepEqual(seen[0].sort(), ['feishu', 'resend', 'telegram']);
    await store.mutate((data) => {
      data.notificationOutbox[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
      data.notificationOutbox[0].channels.feishu.nextAttemptAt = new Date(Date.now() - 1000).toISOString();
    });
    await monitor.outbox.drain();
    assert.deepEqual(seen[1], ['feishu']);
    const event = store.snapshot().notificationOutbox[0];
    assert.equal(event.status, 'completed');
    assert.equal(event.channels.resend.externalId, 'resend-1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
