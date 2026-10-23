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
  // 单遍分组：账号与事件先按上游建索引，避免每个上游各做一次全量过滤。
  const membersByUpstream = new Map();
  const upstreamOfAccount = new Map();
  for (const account of accounts) {
    upstreamOfAccount.set(account.id, account.upstreamId);
    let list = membersByUpstream.get(account.upstreamId);
    if (!list) membersByUpstream.set(account.upstreamId, (list = []));
    list.push(account);
  }
  const openIncidentsByUpstream = new Map();
  for (const incident of incidents) {
    if (incident.state !== 'open') continue;
    const upstreamId = upstreamOfAccount.get(incident.accountId);
    if (upstreamId) openIncidentsByUpstream.set(upstreamId, (openIncidentsByUpstream.get(upstreamId) || 0) + 1);
  }
  return upstreams.map((upstream) => {
    const members = membersByUpstream.get(upstream.id) || [];
    let totalCny = 0;
    let realAccountCount = 0;
    let demoAccountCount = 0;
    let minEtaDays = null;
    let lastSyncAt = null;
    let status = 'empty';
    const platforms = new Set();
    const baseUrls = new Set();
    for (const account of members) {
      totalCny += Number(account.convertedCny || 0);
      if (account.demo) demoAccountCount += 1;
      else realAccountCount += 1;
      // depletionEtaDays 为 null 时表示无消耗速率，Number(null)=0 会污染最小值，必须显式判空。
      if (account.depletionEtaDays != null) {
        const eta = Number(account.depletionEtaDays);
        if (Number.isFinite(eta) && (minEtaDays === null || eta < minEtaDays)) minEtaDays = eta;
      }
      // ISO 8601 同格式字符串的字典序即时间序。
      if (account.lastSyncAt && (!lastSyncAt || account.lastSyncAt > lastSyncAt)) lastSyncAt = account.lastSyncAt;
      if ((statusPriority[account.status] || 0) > (statusPriority[status] || 0)) status = account.status;
      platforms.add(account.type);
      if (account.baseUrl) baseUrls.add(account.baseUrl);
    }
    return {
      ...upstream,
      accountCount: members.length,
      realAccountCount,
      demoAccountCount,
      totalCny,
      status,
      openIncidents: openIncidentsByUpstream.get(upstream.id) || 0,
      minEtaDays,
      lastSyncAt,
      platforms: [...platforms],
      baseUrls: [...baseUrls],
    };
  });
}
