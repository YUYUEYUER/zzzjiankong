import crypto from 'node:crypto';
import { withAccountCredentialLock } from './account-lock.js';
import { config } from './config.js';
import { collectBalance } from './collectors.js';
import { evaluateFormula } from './converter.js';
import { attachCredentialCheckpoint, takeCredentialCheckpoint } from './credential-checkpoint.js';
import { decryptSecret, encryptSecret } from './security.js';
import { notify } from './notifications.js';

const now = () => new Date().toISOString();

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

export class Monitor {
  constructor(store, { collector = collectBalance } = {}) {
    this.store = store;
    this.collector = collector;
    this.timer = null;
    this.running = new Set();
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((error) => console.error('[monitor]', error)), config.monitorTickMs);
    this.timer.unref?.();
  }

  async tick() {
    const data = this.store.snapshot();
    const current = Date.now();
    const due = data.accounts.filter((account) => {
      if (!account.enabled || this.running.has(account.id)) return false;
      const last = account.lastSyncAt ? new Date(account.lastSyncAt).getTime() : 0;
      return current - last >= Number(account.pollIntervalMinutes || 5) * 60000;
    });
    await Promise.allSettled(due.map((account) => this.poll(account.id)));
  }

  reminderDue(incident, settings, current = Date.now()) {
    const previous = incident.lastReminderAt || incident.lastNotificationAt || incident.openedAt;
    const previousTime = new Date(previous || 0).getTime();
    return current - previousTime >= Number(settings.reminderHours || 6) * 3600000;
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
    try {
      const data = this.store.snapshot();
      const account = data.accounts.find((item) => item.id === accountId);
      if (!account) throw new Error('账号不存在');
      const secret = decryptSecret(account.encryptedSecret);
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
          account.lastError = error.message;
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
      data.snapshots = data.snapshots.filter((snapshot) => Date.now() - new Date(snapshot.capturedAt).getTime() < 90 * 86400000);

      let incident = data.incidents.find((item) => item.accountId === accountId && item.state === 'open');
      if (convertedCny < account.thresholdLow) {
        account.recoveryChecks = 0;
        if (!incident) {
          incident = {
            id: crypto.randomUUID(), accountId, state: 'open', openedAt: now(), resolvedAt: null,
            acknowledgedAt: null, triggerBalance: convertedCny, currentBalance: convertedCny,
            channelResults: {}, notifications: { reminders: [] }, recoveryChecks: 0,
          };
          data.incidents.unshift(incident);
          return { kind: 'opened', account: structuredClone(account), incident: structuredClone(incident) };
        }
        incident.currentBalance = convertedCny;
        incident.recoveryChecks = 0;
        if (this.reminderDue(incident, data.settings)) {
          return { kind: 'reminder', account: structuredClone(account), incident: structuredClone(incident) };
        }
        return null;
      }

      if (incident) {
        incident.currentBalance = convertedCny;
        if (convertedCny >= account.thresholdRecover) {
          incident.recoveryChecks = Number(incident.recoveryChecks || 0) + 1;
          account.recoveryChecks = incident.recoveryChecks;
          if (incident.recoveryChecks >= Number(data.settings.recoveryConfirmations || 2)) {
            incident.state = 'resolved';
            incident.resolvedAt = now();
            account.recoveryChecks = 0;
            return { kind: 'recovered', account: structuredClone(account), incident: structuredClone(incident) };
          }
        } else {
          incident.recoveryChecks = 0;
          account.recoveryChecks = 0;
        }
      }
      return null;
    });
  }

  async sendTransition(transition) {
    const data = this.store.snapshot();
    const settings = data.settings;
    const upstream = data.upstreams.find((item) => item.id === transition.account.upstreamId);
    const account = { ...transition.account, upstreamName: upstream?.name || '' };
    const secrets = {
      resendApiKey: decryptSecret(settings.resendApiKeyEncrypted).value,
      feishuWebhook: decryptSecret(settings.feishuWebhookEncrypted).value,
    };
    const kind = ['opened', 'reminder', 'recovered'].includes(transition.kind) ? transition.kind : 'opened';
    const results = await notify(kind, account, transition.incident, settings, secrets);
    await this.store.mutate((state) => {
      const incident = state.incidents.find((item) => item.id === transition.incident.id);
      const recordedAt = now();
      if (incident) {
        incident.notifications ||= { reminders: [] };
        incident.notifications.reminders ||= [];
        if (kind === 'reminder') {
          incident.notifications.reminders.push({ at: recordedAt, results });
          incident.notifications.reminders = incident.notifications.reminders.slice(-20);
          incident.lastReminderAt = recordedAt;
        } else {
          incident.notifications[kind] = { at: recordedAt, results };
        }
        incident.lastNotificationAt = recordedAt;
        incident.channelResults = Object.fromEntries(Object.entries(results).map(([channel, result]) => [channel, result.status]));
      }
      state.audit.unshift({ id: crypto.randomUUID(), type: `incident.${kind}`, accountId: transition.account.id, upstreamId: transition.account.upstreamId, at: recordedAt, details: results });
      state.audit = state.audit.slice(0, 500);
    });
  }
}
