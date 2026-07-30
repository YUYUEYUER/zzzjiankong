import crypto from 'node:crypto';
import { config } from './config.js';
import { decryptSecret } from './security.js';
import { notify } from './notifications.js';

const TERMINAL_CHANNEL_STATES = new Set(['sent', 'disabled', 'account_disabled', 'missing_config', 'dead']);

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function pendingChannels(event) {
  return Object.entries(event.channels || {})
    .filter(([, state]) => !TERMINAL_CHANNEL_STATES.has(state.status))
    .map(([channel]) => channel);
}

function backoffMs(attempts) {
  const base = Math.min(6 * 3600000, 30_000 * (2 ** Math.max(0, attempts - 1)));
  return base + Math.floor(Math.random() * Math.max(1000, base * 0.2));
}

function trimOutbox(events, current = Date.now()) {
  const completedCutoff = current - 30 * 86400000;
  const active = events.filter((event) => !['completed', 'dead', 'cancelled'].includes(event.status));
  const finished = events
    .filter((event) => ['completed', 'dead', 'cancelled'].includes(event.status))
    .filter((event) => new Date(event.completedAt || event.cancelledAt || event.updatedAt || event.createdAt).getTime() >= completedCutoff)
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
    .slice(0, 500);
  return [...active, ...finished];
}

export function createNotificationOutboxEvent(kind, account, incident, current = Date.now()) {
  const createdAt = iso(current);
  const reminderWindow = kind === 'reminder' ? `:${Math.floor(current / 60000)}` : '';
  return {
    id: crypto.randomUUID(),
    dedupeKey: `incident:${incident.id}:${kind}${reminderWindow}`,
    kind,
    accountId: account.id,
    upstreamId: account.upstreamId,
    incidentId: incident.id,
    status: 'pending',
    channels: {
      resend: { status: 'pending', attempts: 0 },
      feishu: { status: 'pending', attempts: 0 },
    },
    createdAt,
    updatedAt: createdAt,
    nextAttemptAt: createdAt,
    leaseId: '',
    leaseExpiresAt: null,
  };
}

export class NotificationOutbox {
  constructor(store, { notifier = notify } = {}) {
    this.store = store;
    this.notifier = notifier;
    this.timer = null;
    this.draining = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain().catch((error) => console.error('[notification-outbox]', error)), config.notificationOutboxTickMs);
    this.timer.unref?.();
    this.drain().catch((error) => console.error('[notification-outbox]', error));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async claim(eventId, current = Date.now()) {
    const leaseId = crypto.randomUUID();
    return this.store.mutate((data) => {
      const event = data.notificationOutbox.find((item) => item.id === eventId);
      if (!event || ['completed', 'dead', 'cancelled'].includes(event.status)) return null;
      if (new Date(event.nextAttemptAt || 0).getTime() > current) return null;
      const leaseExpires = new Date(event.leaseExpiresAt || 0).getTime();
      if (event.status === 'processing' && Number.isFinite(leaseExpires) && leaseExpires > current) return null;
      event.status = 'processing';
      event.leaseId = leaseId;
      event.leaseExpiresAt = iso(current + config.notificationOutboxLeaseMs);
      event.updatedAt = iso(current);
      return structuredClone(event);
    });
  }

  async dispatchEvent(eventId) {
    const event = await this.claim(eventId);
    if (!event) return null;
    const data = this.store.snapshot();
    const account = data.accounts.find((item) => item.id === event.accountId);
    const incident = data.incidents.find((item) => item.id === event.incidentId);
    const upstream = data.upstreams.find((item) => item.id === event.upstreamId);
    if (!account || !incident || account.deletedAt) {
      await this.store.mutate((state) => {
        const current = state.notificationOutbox.find((item) => item.id === event.id && item.leaseId === event.leaseId);
        if (!current) return;
        current.status = 'cancelled';
        current.cancelledAt = iso();
        current.updatedAt = current.cancelledAt;
        current.leaseId = '';
        current.leaseExpiresAt = null;
      });
      return { cancelled: true };
    }

    const channels = pendingChannels(event);
    if (!channels.length) return this.finish(event, {});
    const settings = data.settings;
    const secrets = {
      resendApiKey: decryptSecret(settings.resendApiKeyEncrypted).value,
      feishuWebhook: decryptSecret(settings.feishuWebhookEncrypted).value,
    };
    const results = await this.notifier(
      event.kind,
      { ...account, upstreamName: upstream?.name || '' },
      incident,
      settings,
      secrets,
      { channels, idempotencyKey: event.dedupeKey },
    );
    return this.finish(event, results);
  }

  async finish(claimed, results, current = Date.now()) {
    return this.store.mutate((data) => {
      const event = data.notificationOutbox.find((item) => item.id === claimed.id && item.leaseId === claimed.leaseId);
      if (!event) return null;
      let nextAttemptAt = Number.POSITIVE_INFINITY;
      let hasPending = false;
      let hasDead = false;
      for (const [channel, result] of Object.entries(results)) {
        const previous = event.channels[channel] || { status: 'pending', attempts: 0 };
        const attempts = Number(previous.attempts || 0) + (result.attemptedAt ? 1 : 0);
        if (result.status === 'failed' && result.retryable && attempts < config.notificationOutboxMaxAttempts) {
          const retryAt = current + Math.max(Number(result.retryAfterMs || 0), backoffMs(attempts));
          event.channels[channel] = { ...result, status: 'pending', attempts, nextAttemptAt: iso(retryAt) };
          nextAttemptAt = Math.min(nextAttemptAt, retryAt);
          hasPending = true;
        } else if (result.status === 'failed') {
          event.channels[channel] = { ...result, status: 'dead', attempts };
          hasDead = true;
        } else {
          event.channels[channel] = { ...result, attempts };
        }
      }
      for (const state of Object.values(event.channels)) {
        if (!TERMINAL_CHANNEL_STATES.has(state.status)) {
          hasPending = true;
          const retryAt = new Date(state.nextAttemptAt || current).getTime();
          if (Number.isFinite(retryAt)) nextAttemptAt = Math.min(nextAttemptAt, retryAt);
        }
        if (state.status === 'dead') hasDead = true;
      }
      event.status = hasPending ? 'pending' : hasDead ? 'dead' : 'completed';
      event.nextAttemptAt = hasPending ? iso(Number.isFinite(nextAttemptAt) ? nextAttemptAt : current) : null;
      event.updatedAt = iso(current);
      event.completedAt = hasPending ? null : event.updatedAt;
      event.leaseId = '';
      event.leaseExpiresAt = null;

      const incident = data.incidents.find((item) => item.id === event.incidentId);
      if (incident) {
        const folded = Object.fromEntries(Object.entries(event.channels).map(([channel, state]) => [channel, state]));
        incident.notifications ||= { reminders: [] };
        incident.notifications.reminders ||= [];
        if (event.kind === 'reminder') {
          const existing = incident.notifications.reminders.find((item) => item.eventId === event.id);
          const record = { eventId: event.id, at: event.updatedAt, results: folded };
          if (existing) Object.assign(existing, record);
          else incident.notifications.reminders.push(record);
          incident.notifications.reminders = incident.notifications.reminders.slice(-20);
          incident.lastReminderAt = event.updatedAt;
        } else {
          incident.notifications[event.kind] = { eventId: event.id, at: event.updatedAt, results: folded };
        }
        incident.lastNotificationAt = event.updatedAt;
        incident.channelResults = Object.fromEntries(Object.entries(folded).map(([channel, state]) => [channel, state.status]));
      }
      data.audit.unshift({
        id: crypto.randomUUID(),
        type: `incident.${event.kind}`,
        accountId: event.accountId,
        upstreamId: event.upstreamId,
        at: event.updatedAt,
        details: { outboxEventId: event.id, status: event.status, results },
      });
      data.audit = data.audit.slice(0, 500);
      data.notificationOutbox = trimOutbox(data.notificationOutbox, current);
      return structuredClone(event);
    });
  }

  async drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const current = Date.now();
      const due = this.store.snapshot().notificationOutbox
        .filter((event) => !['completed', 'dead', 'cancelled'].includes(event.status))
        .filter((event) => new Date(event.nextAttemptAt || 0).getTime() <= current)
        .slice(0, 20);
      for (const event of due) await this.dispatchEvent(event.id);
      return due.length;
    })();
    try {
      return await this.draining;
    } finally {
      this.draining = null;
    }
  }
}
