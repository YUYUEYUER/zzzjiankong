const CHANNEL_IDS = ['resend', 'feishu', 'telegram'];
const SYNCED_STATUSES = new Set(['healthy', 'warning', 'critical']);

export function accountSetupSignature(account) {
  if (!account) return '';
  return JSON.stringify({
    id: account.id,
    type: account.type,
    baseUrl: account.baseUrl,
    formula: account.formula,
    rawUnit: account.rawUnit,
    thresholdLow: account.thresholdLow,
    thresholdRecover: account.thresholdRecover,
    pollIntervalMinutes: account.pollIntervalMinutes,
  });
}

export function isAccountSynced(account) {
  return Boolean(
    account
    && !account.demo
    && !account.deletedAt
    && account.enabled !== false
    && SYNCED_STATUSES.has(account.status)
    && !account.lastError
    && account.lastSyncAt
    && Number.isFinite(account.rawBalance)
    && Number.isFinite(account.convertedCny),
  );
}

export function getOnboardingState(dashboard = {}, preferences = {}) {
  const activeAccounts = (dashboard.accounts || []).filter((account) => !account.deletedAt && account.status !== 'deleted');
  const realAccounts = activeAccounts.filter((account) => !account.demo);
  const realUpstreamIds = new Set(realAccounts.map((account) => account.upstreamId));
  const demoUpstreamIds = new Set(activeAccounts.filter((account) => account.demo).map((account) => account.upstreamId));
  const realUpstreams = (dashboard.upstreams || []).filter((upstream) => {
    if (realUpstreamIds.has(upstream.id) || upstream.realAccountCount > 0) return true;
    return !upstream.demo && !demoUpstreamIds.has(upstream.id) && !(upstream.demoAccountCount > 0);
  });
  const account = realAccounts.find((item) => item.id === preferences.accountId)
    || realAccounts.find(isAccountSynced)
    || realAccounts[0]
    || null;
  const upstream = realUpstreams.find((item) => item.id === account?.upstreamId)
    || realUpstreams.find((item) => item.id === preferences.upstreamId)
    || realUpstreams[0]
    || null;
  const settings = dashboard.settings || {};
  const channels = CHANNEL_IDS.filter((channel) => (
    settings[`${channel}Enabled`] === true
    && settings[`${channel}Configured`] === true
    && account?.notifications?.[channel] === true
  ));
  const steps = [
    { id: 'upstream', complete: Boolean(upstream) },
    { id: 'account', complete: Boolean(account) },
    { id: 'balance', complete: isAccountSynced(account) && preferences.confirmedSignature === accountSetupSignature(account) },
    { id: 'notifications', complete: channels.length > 0 },
  ];
  const completedCount = steps.filter((step) => step.complete).length;
  const currentStepId = steps.find((step) => !step.complete)?.id || 'complete';

  return {
    realUpstreams,
    realAccounts,
    account,
    upstream,
    channels,
    steps,
    completedCount,
    currentStepId,
    complete: completedCount === steps.length,
  };
}
