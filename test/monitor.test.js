import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspect } from 'node:util';
import { JsonStore } from '../server/store.js';
import { compactSnapshots, Monitor } from '../server/monitor.js';
import { attachCredentialCheckpoint } from '../server/credential-checkpoint.js';
import { decryptSecret, encryptSecret } from '../server/security.js';

test('snapshot compaction keeps recent detail and bounded older history', () => {
  const current = Date.UTC(2026, 6, 30, 12);
  const snapshots = [];
  for (let minutes = 0; minutes < 90 * 24 * 60; minutes += 1) {
    snapshots.push({
      id: `snapshot-${minutes}`,
      accountId: 'account-1',
      capturedAt: new Date(current - minutes * 60000).toISOString(),
    });
  }
  snapshots.push({ id: 'expired', accountId: 'account-1', capturedAt: new Date(current - 91 * 86400000).toISOString() });
  const compacted = compactSnapshots(snapshots, current);
  assert.ok(compacted.length < 2300);
  assert.equal(compacted.some((item) => item.id === 'expired'), false);
  assert.equal(compacted.filter((item) => new Date(item.capturedAt).getTime() >= current - 24 * 3600000).length, 1441);
  assert.ok(compacted.some((item) => new Date(item.capturedAt).getTime() < current - 60 * 86400000));
});

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

test('a custom recovery count requires four consecutive readings at the recovery threshold', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-custom-recovery-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const readings = [20, 20, 19, 20, 20, 20, 20];
  const monitor = new Monitor(store, {
    collector: async () => ({ rawBalance: readings.shift(), metadata: {} }),
  });

  try {
    await store.mutate((data) => {
      data.settings.recoveryConfirmations = 4;
      data.settings.resendEnabled = false;
      data.settings.feishuEnabled = false;
      data.settings.telegramEnabled = false;
      const account = data.accounts.find((item) => item.id === 'acct-hk-backup');
      account.demo = false;
      account.formula = 'x';
      account.thresholdLow = 10;
      account.thresholdRecover = 20;
    });

    for (const expectedChecks of [1, 2, 0, 1, 2, 3]) {
      await monitor.poll('acct-hk-backup');
      const incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
      assert.equal(incident.state, 'open');
      assert.equal(incident.recoveryChecks, expectedChecks);
      assert.equal(incident.notifications?.recovered, undefined);
    }

    await monitor.poll('acct-hk-backup');
    const snapshot = store.snapshot();
    const incident = snapshot.incidents.find((item) => item.id === 'inc-hk');
    assert.equal(incident.state, 'resolved');
    assert.equal(incident.recoveryChecks, 4);
    assert.equal(snapshot.accounts.find((item) => item.id === 'acct-hk-backup').recoveryChecks, 0);
    assert.ok(incident.resolvedAt);
    assert.equal(incident.notifications.recovered.results.resend.status, 'disabled');
    assert.equal(incident.notifications.recovered.results.feishu.status, 'disabled');
    assert.equal(incident.notifications.recovered.results.telegram.status, 'disabled');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('failed collection breaks a custom recovery streak and requires four fresh healthy polls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-recovery-failure-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const readings = [20, 20, new Error('balance endpoint unavailable'), 20, 20, 20, 20];
  const monitor = new Monitor(store, {
    collector: async () => {
      const reading = readings.shift();
      if (reading instanceof Error) throw reading;
      return { rawBalance: reading, metadata: {} };
    },
  });

  try {
    await store.mutate((data) => {
      data.settings.recoveryConfirmations = 4;
      data.settings.resendEnabled = false;
      data.settings.feishuEnabled = false;
      data.settings.telegramEnabled = false;
      const account = data.accounts.find((item) => item.id === 'acct-hk-backup');
      account.demo = false;
      account.formula = 'x';
      account.thresholdLow = 10;
      account.thresholdRecover = 20;
    });

    await monitor.poll('acct-hk-backup');
    await monitor.poll('acct-hk-backup');
    assert.equal(store.snapshot().incidents.find((item) => item.id === 'inc-hk').recoveryChecks, 2);

    await assert.rejects(monitor.poll('acct-hk-backup'), /balance endpoint unavailable/);
    const failed = store.snapshot();
    const failedAccount = failed.accounts.find((item) => item.id === 'acct-hk-backup');
    assert.equal(failedAccount.status, 'error');
    assert.equal(failedAccount.recoveryChecks, 0);
    assert.equal(failed.incidents.find((item) => item.id === 'inc-hk').recoveryChecks, 0);

    for (const expectedChecks of [1, 2, 3]) {
      await monitor.poll('acct-hk-backup');
      const incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
      assert.equal(incident.state, 'open');
      assert.equal(incident.recoveryChecks, expectedChecks);
      assert.equal(incident.notifications?.recovered, undefined);
    }

    await monitor.poll('acct-hk-backup');
    const incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
    assert.equal(incident.state, 'resolved');
    assert.equal(incident.recoveryChecks, 4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an unresolved incident is reminded once per configured interval', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-reminder-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store);

  await store.mutate((data) => {
    data.settings.reminderMinutes = 1;
    const incident = data.incidents.find((item) => item.id === 'inc-hk');
    incident.openedAt = new Date(Date.now() - 2 * 60000).toISOString();
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

test('minute reminder interval triggers exactly at its configured boundary', () => {
  const monitor = new Monitor({});
  const current = Date.UTC(2026, 6, 30, 12, 0, 0);
  const incident = { openedAt: new Date(current - 7 * 60000).toISOString() };
  const settings = { reminderMinutes: 7 };

  assert.equal(monitor.reminderDue(incident, settings, current - 1), false);
  assert.equal(monitor.reminderDue(incident, settings, current), true);
});

test('tick sends due reminders without waiting for the next account poll', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-reminder-tick-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store);
  const current = Date.now();

  await store.mutate((data) => {
    data.settings.reminderMinutes = 1;
    for (const account of data.accounts) {
      account.lastSyncAt = new Date(current).toISOString();
      account.pollIntervalMinutes = 60;
    }
    for (const incident of data.incidents) {
      if (incident.id !== 'inc-hk') incident.state = 'resolved';
    }
    const incident = data.incidents.find((item) => item.id === 'inc-hk');
    incident.openedAt = new Date(current - 2 * 60000).toISOString();
    delete incident.lastNotificationAt;
    delete incident.lastReminderAt;
    delete incident.lastReminderQueuedAt;
  });

  const snapshotsBefore = store.snapshot().snapshots.length;
  await monitor.tick();
  await monitor.tick();

  const incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
  assert.equal(store.snapshot().snapshots.length, snapshotsBefore);
  assert.equal(incident.notifications.reminders.length, 1);
  assert.ok(incident.lastReminderAt);

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
