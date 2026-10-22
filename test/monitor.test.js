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

test('a recorded recharge verifies once the balance rises by the declared amount', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-recharge-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const readings = [60, 75, 75];
  const monitor = new Monitor(store, {
    collector: async () => ({ rawBalance: readings.shift(), metadata: {} }),
  });

  try {
    await store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === 'acct-hk-backup');
      account.demo = false;
      account.formula = 'x';
      account.thresholdLow = 10;
      account.thresholdRecover = 70;
      const incident = data.incidents.find((item) => item.id === 'inc-hk');
      incident.recharges = [{
        id: 'recharge-1', amount: 50, at: new Date().toISOString(),
        balanceAt: 8, verifiedAt: null, verifiedBalance: null,
      }];
    });

    // 8 + 50 = 58；第一次回升到 60 已达标 → 标记已核对
    await monitor.poll('acct-hk-backup');
    let incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
    assert.ok(incident.recharges[0].verifiedAt);
    assert.equal(incident.recharges[0].verifiedBalance, 60);
    assert.equal(incident.state, 'open');
    assert.equal(incident.recoveryChecks, 0);

    await monitor.poll('acct-hk-backup');
    incident = store.snapshot().incidents.find((item) => item.id === 'inc-hk');
    assert.equal(incident.recoveryChecks, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('depletion prediction enqueues at most one event per day per account', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-prediction-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store, {
    collector: async () => ({ rawBalance: 30, metadata: {} }),
  });

  try {
    const now = Date.now();
    await store.mutate((data) => {
      data.settings.depletionAlertDays = 10;
      const account = data.accounts.find((item) => item.id === 'acct-jp-prod');
      account.demo = false;
      account.formula = 'x';
      account.thresholdLow = 10;
      // 余额高于阈值、不在事件中 → 走预测分支
      for (const incident of data.incidents) incident.state = 'resolved';
      // 4 个点、每天消耗 4 元：当前 30，阈值 10 → ETA = (30-10)/4 = 5 天 ≤ 10 → 应入队
      data.snapshots = [0, 1, 2, 3].map((index) => ({
        id: `pred-${index}`, accountId: 'acct-jp-prod', rawBalance: 30 + index * 4,
        convertedCny: 30 + index * 4, capturedAt: new Date(now - index * 86400000).toISOString(),
      }));
    });

    await monitor.poll('acct-jp-prod');
    let events = store.snapshot().notificationOutbox.filter((item) => item.kind === 'prediction' && item.accountId === 'acct-jp-prod');
    assert.equal(events.length, 1);
    assert.match(events[0].dedupeKey, /^account:acct-jp-prod:prediction:/);

    // 同一天再次 poll 不得重复入队
    await monitor.poll('acct-jp-prod');
    events = store.snapshot().notificationOutbox.filter((item) => item.kind === 'prediction' && item.accountId === 'acct-jp-prod');
    assert.equal(events.length, 1);

    const account = store.snapshot().accounts.find((item) => item.id === 'acct-jp-prod');
    assert.ok(account.dailyBurnRate > 3.5 && account.dailyBurnRate < 4.5);
    assert.ok(Number.isFinite(account.depletionEtaDays));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('depletion prediction is suppressed while an incident is open', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-prediction-open-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store, {
    collector: async () => ({ rawBalance: 5, metadata: {} }),
  });

  try {
    const now = Date.now();
    await store.mutate((data) => {
      data.settings.depletionAlertDays = 10;
      const account = data.accounts.find((item) => item.id === 'acct-hk-backup');
      account.demo = false;
      account.formula = 'x';
      account.thresholdLow = 10;
      data.snapshots = [0, 1, 2].map((index) => ({
        id: `open-${index}`, accountId: 'acct-hk-backup', rawBalance: 12 + index * 4,
        convertedCny: 12 + index * 4, capturedAt: new Date(now - index * 86400000).toISOString(),
      }));
    });

    await monitor.poll('acct-hk-backup'); // 5 < 10 → 维持/建立事件
    const events = store.snapshot().notificationOutbox.filter((item) => item.kind === 'prediction');
    assert.equal(events.length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credential expiry warning enqueues once per day when AT enters the three-day window', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-credential-expiry-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store, {
    collector: async () => ({
      rawBalance: 100,
      metadata: { accessTokenExpiresAt: new Date(Date.now() + 2 * 86400000).toISOString() },
    }),
  });

  try {
    await store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === 'acct-us-backup');
      account.demo = false;
      account.formula = 'x';
      account.encryptedSecret = encryptSecret({ accessToken: 'cred-expiry-test' });
      for (const incident of data.incidents) incident.state = 'resolved';
      data.snapshots = [];
    });

    await monitor.poll('acct-us-backup');
    let events = store.snapshot().notificationOutbox.filter((item) => item.kind === 'credential_expiry' && item.accountId === 'acct-us-backup');
    assert.equal(events.length, 1);
    assert.match(events[0].dedupeKey, /^account:acct-us-backup:credential_expiry:/);

    await monitor.poll('acct-us-backup');
    events = store.snapshot().notificationOutbox.filter((item) => item.kind === 'credential_expiry' && item.accountId === 'acct-us-backup');
    assert.equal(events.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('credential expiry warning still enqueues during an active low-balance incident', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frosted-credential-incident-'));
  const store = await new JsonStore(path.join(dir, 'db.json')).init();
  const monitor = new Monitor(store, {
    collector: async () => ({
      rawBalance: 100,
      metadata: { accessTokenExpiresAt: new Date(Date.now() + 2 * 86400000).toISOString() },
    }),
  });

  try {
    await store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === 'acct-us-backup');
      account.demo = false;
      account.formula = 'x';
      account.thresholdLow = 200;
      account.encryptedSecret = encryptSecret({ accessToken: 'cred-expiry-incident' });
      for (const incident of data.incidents) incident.state = 'resolved';
      data.snapshots = [];
    });

    await monitor.poll('acct-us-backup');
    const data = store.snapshot();
    assert.ok(data.incidents.some((item) => item.accountId === 'acct-us-backup' && item.state === 'open'));
    const events = data.notificationOutbox.filter((item) => item.kind === 'credential_expiry' && item.accountId === 'acct-us-backup');
    assert.equal(events.length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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
