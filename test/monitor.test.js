import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import { JsonStore } from '../server/store.js';
import { Monitor } from '../server/monitor.js';
import { attachCredentialCheckpoint } from '../server/credential-checkpoint.js';
import { decryptSecret, encryptSecret } from '../server/security.js';

test('manual recharge closes an incident after two healthy polls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-console-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store);

  const before = store.snapshot().incidents.find((incident) => incident.accountId === 'acct-hk-backup' && incident.state === 'open');
  assert.ok(before);

  await monitor.poll('acct-hk-backup', { recharge: true });
  let halfway = store.snapshot().incidents.find((incident) => incident.id === before.id);
  assert.equal(halfway.state, 'open');
  assert.equal(halfway.recoveryChecks, 1);

  await monitor.poll('acct-hk-backup', { recharge: true });
  const after = store.snapshot().incidents.find((incident) => incident.id === before.id);
  assert.equal(after.state, 'resolved');
  assert.equal(after.recoveryChecks, 2);
  assert.equal(after.notifications.recovered.results.resend.status, 'disabled');
  assert.equal(after.notifications.recovered.results.feishu.status, 'disabled');

  await fs.rm(dir, { recursive: true, force: true });
});

test('an unresolved incident is reminded once per configured interval', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-reminder-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store);

  await store.mutate((data) => {
    data.settings.reminderHours = 1;
    const incident = data.incidents.find((item) => item.id === 'inc-hk');
    incident.openedAt = new Date(Date.now() - 2 * 3600000).toISOString();
    delete incident.lastNotificationAt;
    delete incident.lastReminderAt;
  });

  await monitor.poll('acct-hk-backup');
  let incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
  assert.equal(incident.notifications.reminders.length, 1);
  assert.ok(incident.lastReminderAt);

  await monitor.poll('acct-hk-backup');
  incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
  assert.equal(incident.notifications.reminders.length, 1);

  await fs.rm(dir, { recursive: true, force: true });
});

test('rotated credentials are checkpointed when balance collection fails afterward', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-checkpoint-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const rotatedSecret = {
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  };
  const collector = async () => {
    const error = new Error('profile endpoint unavailable after refresh');
    throw attachCredentialCheckpoint(error, rotatedSecret);
  };
  const monitor = new Monitor(store, { collector });

  try {
    await store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === 'acct-hk-backup');
      account.demo = false;
      account.encryptedSecret = encryptSecret({ accessToken: 'old-access-token' });
    });

    await assert.rejects(monitor.poll('acct-hk-backup'), /profile endpoint unavailable/);
    const snapshot = store.snapshot();
    const account = snapshot.accounts.find((item) => item.id === 'acct-hk-backup');
    assert.deepEqual(decryptSecret(account.encryptedSecret), rotatedSecret);
    assert.equal(account.status, 'error');
    assert.ok(snapshot.audit.some((entry) => (
      entry.type === 'account.credentials.checkpointed'
      && entry.accountId === 'acct-hk-backup'
    )));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credential checkpoints are not enumerable or printable on Error objects', () => {
  const error = attachCredentialCheckpoint(new Error('profile failed'), {
    password: 'must-not-appear',
    accessToken: 'must-not-appear-either',
  });
  const rendered = inspect(error);
  assert.doesNotMatch(rendered, /must-not-appear/);
  assert.deepEqual(Object.keys(error), []);
});

test('rotated credentials survive a conversion failure after collection succeeds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-formula-checkpoint-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const rotatedSecret = { accessToken: 'formula-new-at', refreshToken: 'formula-new-rt' };
  const monitor = new Monitor(store, {
    collector: async () => ({ rawBalance: 5, updatedSecret: rotatedSecret, metadata: {} }),
  });
  try {
    await store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === 'acct-hk-backup');
      account.demo = false;
      account.formula = 'x / (x - x)';
      account.encryptedSecret = encryptSecret({ accessToken: 'formula-old-at' });
    });
    await assert.rejects(monitor.poll('acct-hk-backup'), /转换结果无效/);
    const account = store.snapshot().accounts.find((item) => item.id === 'acct-hk-backup');
    assert.deepEqual(decryptSecret(account.encryptedSecret), rotatedSecret);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
