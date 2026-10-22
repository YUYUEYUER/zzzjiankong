import crypto from 'node:crypto';
import { withAccountCredentialLock } from './account-lock.js';
import { config } from './config.js';
import { collectBalance, credentialExpiryMs, redactCredentialText } from './collectors.js';
import { evaluateFormula } from './converter.js';
import { attachCredentialCheckpoint, takeCredentialCheckpoint } from './credential-checkpoint.js';
import { computeDailyBurnRate, depletionEtaDays } from './burn-rate.js';
import { decryptSecret, encryptSecret } from './security.js';
import { createNotificationOutboxEvent, NotificationOutbox } from './notification-outbox.js';

const now = () => new Date().toISOString();

export function compactSnapshots(snapshots, current = Date.now()) {
  const retentionStart = current - 90 * 86400000;
  const detailedStart = current - 24 * 3600000;
  const hourlyStart = current - 30 * 86400000;
  const kept = [];
  const buckets = new Map();
  for (const snapshot of snapshots) {
    const captured = new Date(snapshot.capturedAt).getTime();
    if (!Number.isFinite(captured) || captured < retentionStart) continue;
    if (captured >= detailedStart) {
      kept.push(snapshot);
      continue;
    }
    const bucketSize = captured >= hourlyStart ? 3600000 : 86400000;
    const key = `${snapshot.accountId}:${bucketSize}:${Math.floor(captured / bucketSize)}`;
    const previous = buckets.get(key);
    if (!previous || new Date(previous.capturedAt).getTime() < captured) buckets.set(key, snapshot);
  }
  return [...kept, ...buckets.values()].sort((left, right) => (
    new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime()
  ));
}

function simulate(account, recharge = false) {
  if (recharge) {
    const targetCny = Math.max(account.thresholdRecover + 18, account.convertedCny + 48);
    const ratio = account.rawBalance ? account.convertedCny / account.rawBalance : 1;
    return { rawBalance: ratio ? targetCny / ratio : targetCny, metadata: { authSource: 'demo_recharge' } };
  }
  const ratio = account.rawBalance ? account.convertedCny / account.rawBalance : 1;
  const nextCny = Math.max(0, account.convertedCny - Math.max(0.04, account.convertedCny * 0.002));
  return { rawBalance: ratio ? nextCny / ratio : nextCny, metadata: { authSource: 'demo' } };
}

function secretTokens(secret = {}) {
  const values = [
    secret.accessToken,
    secret.apiToken,
    secret.refreshToken,
    secret.password,
    secret.sessionCookie,
    secret.cfAccessClientSecret,
  ];
  for (const list of [secret.accessTokens, secret.apiTokens]) {
    if (Array.isArray(list)) values.push(...list);
  }
  return values;
}

export class Monitor {
  constructor(store, { collector = collectBalance } = {}) {
    this.store = store;
    this.collector = collector;
    this.timer = null;
    this.running = new Set();
    this.outbox = new NotificationOutbox(store);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((error) => console.error('[monitor]', error)), config.monitorTickMs);
    this.timer.unref?.();
    this.outbox.start();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.outbox.stop();
  }

  async tick() {
    const data = this.store.snapshot();
    const current = Date.now();
    const reminderTransitions = await this.queueDueReminders(data, current);
    const due = data.accounts.filter((account) => {
      if (!account.enabled || this.running.has(account.id)) return false;
      const last = account.lastSyncAt ? new Date(account.lastSyncAt).getTime() : 0;
      return current - last >= Number(account.pollIntervalMinutes || 5) * 60000;
    });
    await Promise.allSettled([
      ...reminderTransitions.map((transition) => this.sendTransition(transition)),
      ...due.map((account) => this.poll(account.id)),
    ]);
  }

  reminderDue(incident, settings, current = Date.now()) {
    const previous = incident.lastReminderQueuedAt || incident.lastReminderAt || incident.lastNotificationAt || incident.openedAt;
    const previousTime = new Date(previous || 0).getTime();
    return current - previousTime >= Number(settings.reminderMinutes || 360) * 60000;
  }

  async queueDueReminders(snapshot, current = Date.now()) {
    const accountById = new Map(snapshot.accounts.map((account) => [account.id, account]));
    const hasDueReminder = snapshot.incidents.some((incident) => (
      incident.state === 'open'
      && accountById.get(incident.accountId)?.enabled
      && this.reminderDue(incident, snapshot.settings, current)
    ));
    if (!hasDueReminder) return [];

    return this.store.mutate((data) => {
      const transitions = [];
      const queuedAt = new Date(current).toISOString();
      for (const incident of data.incidents) {
        if (incident.state !== 'open') continue;
        const account = data.accounts.find((item) => item.id === incident.accountId);
        if (!account?.enabled || !this.reminderDue(incident, data.settings, current)) continue;
        incident.lastReminderQueuedAt = queuedAt;
        const event = createNotificationOutboxEvent('reminder', account, incident, current);
        data.notificationOutbox.push(event);
        transitions.push({ eventId: event.id });
      }
      return transitions;
    });
  }

  async poll(accountId, options = {}) {
    if (this.running.has(accountId)) throw new Error('该账号正在同步');
    this.running.add(accountId);
    try {
      return await withAccountCredentialLock(accountId, () => this.pollUnlocked(accountId, options));
    } finally {
      this.running.delete(accountId);
    }
  }

  async pollUnlocked(accountId, options = {}) {
    let result;
    let secret = {};
    try {
      const data = this.store.snapshot();
      const account = data.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error('账号不存在');
      secret = decryptSecret(account.encryptedSecret);
      result = account.demo ? simulate(account, options.recharge) : await this.collector(account, secret);
      const convertedCny = evaluateFormula(account.formula, result.rawBalance);
      const transition = await this.applySuccess(accountId, result, convertedCny);
      if (transition) await this.sendTransition(transition);
      return this.store.snapshot().accounts.find((item) => item.id === accountId);
    } catch (error) {
      if (result?.updatedSecret) attachCredentialCheckpoint(error, result.updatedSecret);
      const credentialCheckpoint = takeCredentialCheckpoint(error);
      await this.store.mutate((data) => {
        const account = data.accounts.find((item) => item.id === accountId);
        if (account) {
          if (credentialCheckpoint) {
            account.encryptedSecret = encryptSecret(credentialCheckpoint);
            data.audit.unshift({
              id: crypto.randomUUID(),
              type: 'account.credentials.checkpointed',
              accountId,
              upstreamId: account.upstreamId,
              at: now(),
              details: { reason: 'token_rotated_before_balance_failure' },
            });
            data.audit = data.audit.slice(0, 500);
          }
          account.status = 'error';
          account.recoveryChecks = 0;
          // A failed poll breaks the sequence of verified healthy readings.
          for (const incident of data.incidents) {
            if (incident.accountId === accountId && incident.state === 'open') incident.recoveryChecks = 0;
          }
          // 上游可控的错误文本先脱敏，避免其回显账号凭据并落入明文存储/界面。
          account.lastError = redactCredentialText(error.message, secretTokens(secret));
          account.lastSyncAt = now();
          account.updatedAt = now();
        }
      });
      throw error;
    }
  }

  async applySuccess(accountId, result, convertedCny) {
    return this.store.mutate((data) => {
      const account = data.accounts.find((item) => item.id === accountId);
      if (!account) return null;
      account.rawBalance = Number(result.rawBalance);
      account.convertedCny = convertedCny;
      account.status = convertedCny < account.thresholdLow ? 'warning' : 'healthy';
      account.lastError = '';
      account.lastSyncAt = now();
      account.updatedAt = now();
      account.metadata = result.metadata || {};
      if (result.updatedSecret) account.encryptedSecret = encryptSecret(result.updatedSecret);

      data.snapshots.push({ id: crypto.randomUUID(), accountId, rawBalance: account.rawBalance, convertedCny, capturedAt: now() });
      data.snapshots = compactSnapshots(data.snapshots);

      const dailyBurnRate = computeDailyBurnRate(data.snapshots.filter((item) => item.accountId === accountId));
      account.dailyBurnRate = Math.round(dailyBurnRate * 100) / 100;
      account.depletionEtaDays = depletionEtaDays(convertedCny, account.thresholdLow, dailyBurnRate);

      let incident = data.incidents.find((item) => item.accountId === accountId && item.state === 'open');
      // 耗尽预测告警：未处于低余额事件且 ETA 进入预警天数时，每天最多入队一条。
      let predictionEventId = null;
      const alertDays = Number(data.settings.depletionAlertDays || 0);
      if (
        !incident
        && !account.demo
        && alertDays > 0
        && account.depletionEtaDays != null
        && account.depletionEtaDays <= alertDays
        && convertedCny >= Number(account.thresholdLow || 0)
      ) {
        const preview = createNotificationOutboxEvent('prediction', account, null);
        if (!data.notificationOutbox.some((item) => item.dedupeKey === preview.dedupeKey)) {
          data.notificationOutbox.push(preview);
          predictionEventId = preview.id;
        }
      }
      // 凭据到期预警：上游给出的 AT/订阅到期时间进入 3 天窗口（或已过期）时每天提醒一次；
      // 与事件状态机解耦，进行中的低余额事件期间同样生效，未及时派发的由 outbox 兜底。
      const credentialExpiresAt = account.metadata?.accessTokenExpiresAt || account.metadata?.expiresAt || null;
      const credentialExpiresMs = credentialExpiryMs(credentialExpiresAt);
      if (!account.demo && Number.isFinite(credentialExpiresMs) && credentialExpiresMs <= Date.now() + 3 * 86400000) {
        const preview = createNotificationOutboxEvent('credential_expiry', account, null);
        if (!data.notificationOutbox.some((item) => item.dedupeKey === preview.dedupeKey)) {
          data.notificationOutbox.push(preview);
          predictionEventId ||= preview.id;
        }
      }
      if (convertedCny < account.thresholdLow) {
        account.recoveryChecks = 0;
        if (!incident) {
          incident = {
            id: crypto.randomUUID(), accountId, state: 'open', openedAt: now(), resolvedAt: null,
            acknowledgedAt: null, triggerBalance: convertedCny, currentBalance: convertedCny,
            channelResults: {}, notifications: { reminders: [] }, recoveryChecks: 0, recharges: [],
          };
          data.incidents.unshift(incident);
          const event = createNotificationOutboxEvent('opened', account, incident);
          data.notificationOutbox.push(event);
          return { eventId: event.id };
        }
        incident.currentBalance = convertedCny;
        incident.recoveryChecks = 0;
        if (this.reminderDue(incident, data.settings)) {
          incident.lastReminderQueuedAt = now();
          const event = createNotificationOutboxEvent('reminder', account, incident);
          data.notificationOutbox.push(event);
          return { eventId: event.id };
        }
        return null;
      }

      if (incident) {
        incident.currentBalance = convertedCny;
        // 核对充值记录：余额较记录时回升达到申报金额即标记已验证。
        for (const recharge of incident.recharges || []) {
          if (!recharge.verifiedAt && convertedCny >= Number(recharge.balanceAt || 0) + Number(recharge.amount || 0)) {
            recharge.verifiedAt = now();
            recharge.verifiedBalance = convertedCny;
          }
        }
        if (convertedCny >= account.thresholdRecover) {
          incident.recoveryChecks = Number(incident.recoveryChecks || 0) + 1;
          account.recoveryChecks = incident.recoveryChecks;
          if (incident.recoveryChecks >= Number(data.settings.recoveryConfirmations || 2)) {
            incident.state = 'resolved';
            incident.resolvedAt = now();
            account.recoveryChecks = 0;
            const event = createNotificationOutboxEvent('recovered', account, incident);
            data.notificationOutbox.push(event);
            return { eventId: event.id };
          }
        } else {
          incident.recoveryChecks = 0;
          account.recoveryChecks = 0;
        }
      }
      return predictionEventId ? { eventId: predictionEventId } : null;
    });
  }

  async sendTransition(transition) {
    if (!transition?.eventId) return;
    try {
      await this.outbox.dispatchEvent(transition.eventId);
    } catch (error) {
      console.error('[notification-outbox]', error);
    }
  }
}
