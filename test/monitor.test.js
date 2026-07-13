import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JsonStore } from '../server/store.js';
import { Monitor } from '../server/monitor.js';

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
