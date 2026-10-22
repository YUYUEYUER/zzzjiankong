const statusPriority = {
  error: 6,
  offline: 5,
  critical: 4,
  warning: 3,
  pending: 2,
  healthy: 1,
  empty: 0,
};

export function worstStatus(accounts) {
  if (!accounts.length) return 'empty';
  return accounts.reduce((worst, account) => (
    (statusPriority[account.status] || 0) > (statusPriority[worst] || 0) ? account.status : worst
  ), 'empty');
}

export function aggregateUpstreams(upstreams, accounts, incidents) {
  return upstreams.map((upstream) => {
    const members = accounts.filter((account) => account.upstreamId === upstream.id);
    const memberIds = new Set(members.map((account) => account.id));
    const relatedIncidents = incidents.filter((incident) => memberIds.has(incident.accountId));
    const lastSyncAt = members.map((account) => account.lastSyncAt).filter(Boolean).sort().at(-1) || null;
    const etaValues = members.map((account) => Number(account.depletionEtaDays)).filter(Number.isFinite);
    return {
      ...upstream,
      accountCount: members.length,
      realAccountCount: members.filter((account) => !account.demo).length,
      demoAccountCount: members.filter((account) => account.demo).length,
      totalCny: members.reduce((sum, account) => sum + Number(account.convertedCny || 0), 0),
      status: worstStatus(members),
      openIncidents: relatedIncidents.filter((incident) => incident.state === 'open').length,
      minEtaDays: etaValues.length ? Math.min(...etaValues) : null,
      lastSyncAt,
      platforms: [...new Set(members.map((account) => account.type))],
      baseUrls: [...new Set(members.map((account) => account.baseUrl).filter(Boolean))],
    };
  });
}
