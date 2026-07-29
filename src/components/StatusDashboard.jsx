import { useEffect, useMemo, useState } from 'react';
import {
  ArrowClockwise,
  Bell,
  CaretDown,
  CaretRight,
  CheckCircle,
  ClockCounterClockwise,
  Gear,
  PencilSimple,
  Plus,
  SignOut,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { compactNumber, hostname, money, platformLabel, relativeTime } from '../lib.js';

const STATUS_COPY = {
  healthy: '运行正常',
  warning: '余额偏低',
  critical: '余额严重不足',
  offline: '监控已停用',
  pending: '等待首次同步',
  error: '同步异常',
  empty: '尚未添加账号',
};

function statusCopy(status) {
  return STATUS_COPY[status] || '状态未知';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rateLabel(value, status) {
  const number = finiteNumber(value);
  if (number !== null) return `x ${compactNumber(number)}`;
  if (status === 'dynamic') return '动态倍率';
  if (status === 'needs_user_access') return '需用户令牌';
  if (status === 'challenge') return '验证后可读';
  return '暂未获取';
}

function normalizeKeyDetails(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.keys)) return payload.keys;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function KeyDetailRow({ item, account }) {
  const metadata = item.metadata || item;
  const available = item.status !== 'error' && item.ok !== false;
  const balance = item.convertedCny ?? item.balanceCny;
  const rawBalance = item.rawBalance ?? metadata.rawBalance;
  const used = metadata.totalUsed ?? metadata.quotaUsed ?? metadata.usedQuota ?? metadata.used ?? metadata.usage;
  return (
    <div className="key-detail-row">
      <div className="key-identity">
        <span className={`status-dot ${available ? 'healthy' : 'error'}`} />
        <div>
          <strong>{item.label || item.maskedToken || item.maskedKey || item.keyMask || `Key ${item.slot || item.index + 1 || 1}`}</strong>
          <small>{available ? '可用' : item.message || '读取失败'}</small>
        </div>
      </div>
      <div className="key-metric">
        <span>剩余额度</span>
        <strong>{finiteNumber(balance) !== null ? money(balance) : finiteNumber(rawBalance) !== null ? `${compactNumber(rawBalance)} ${account.rawUnit || ''}` : '暂未获取'}</strong>
      </div>
      <div className="key-metric">
        <span>已使用</span>
        <strong>{finiteNumber(used) !== null ? compactNumber(used) : '暂未获取'}</strong>
      </div>
      <div className="key-metric">
        <span>倍率</span>
        <strong>{rateLabel(metadata.rateMultiplier, metadata.rateMultiplierStatus)}</strong>
      </div>
      <div className="key-metric">
        <span>分组</span>
        <strong>{metadata.tokenGroup || metadata.group || '默认'}</strong>
      </div>
    </div>
  );
}

function AccountDetails({ account, state, onEdit }) {
  const keyDetails = normalizeKeyDetails(state?.data);
  const supportsKeyDetails = account.authMode === 'api_token' || (account.type === 'newapi' && account.authMode === 'access_token');
  if (state?.loading) {
    return <div className="account-detail-state"><SpinnerGap className="spin" size={18} />正在读取每个 Key 的用量与倍率...</div>;
  }

  if (supportsKeyDetails) {
    if (state?.error) {
      return <div className="account-detail-state error"><WarningCircle size={18} />{state.error}</div>;
    }
    if (keyDetails.length) {
      return <div className="key-detail-list">{keyDetails.map((item, index) => <KeyDetailRow key={`${item.slot || index}-${item.maskedToken || item.maskedKey || item.keyMask || ''}`} item={{ ...item, index }} account={account} />)}</div>;
    }
    if (state?.data) {
      return <div className="account-detail-state">{state.data.message || '该账号暂时没有可展示的 API Key'}</div>;
    }
  }

  const metadata = account.metadata || {};
  return (
    <div className="account-detail-summary">
      <div><span>原始余额</span><strong>{compactNumber(account.rawBalance)} {account.rawUnit}</strong></div>
      <div><span>人民币换算</span><strong>{account.formula || 'x'}</strong></div>
      <div><span>报警阈值</span><strong>{money(account.thresholdLow)}</strong></div>
      <div><span>当前倍率</span><strong>{account.authMode === 'api_token' ? rateLabel(metadata.rateMultiplier, metadata.rateMultiplierStatus) : '账户级余额'}</strong></div>
      <button className="text-command" type="button" onClick={() => onEdit(account)}><PencilSimple size={15} />高级编辑</button>
    </div>
  );
}

function AccountRow({ account, expanded, detailState, onToggle, onRefresh, onEdit, busy }) {
  return (
    <div className={`status-account ${expanded ? 'expanded' : ''}`}>
      <div className="status-account-main">
        <button className="status-account-toggle" type="button" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <CaretDown size={17} /> : <CaretRight size={17} />}
          <span className={`status-icon ${account.status}`}>
            {['healthy', 'warning'].includes(account.status) ? <CheckCircle size={21} weight="fill" /> : <WarningCircle size={21} weight="fill" />}
          </span>
          <span className="status-account-name">
            <strong>{account.name}</strong>
            <small>{platformLabel(account.type)} · {hostname(account.baseUrl)}{account.apiTokenCount > 1 ? ` · ${account.apiTokenCount} Keys` : ''}</small>
          </span>
          <span className="status-account-sync">{relativeTime(account.lastSyncAt)}</span>
          <span className="status-account-balance">{money(account.convertedCny)}</span>
          <span className={`status-label ${account.status}`}>{statusCopy(account.status)}</span>
        </button>
        <div className="status-account-actions">
          <button className="quiet-icon-button" type="button" onClick={() => onRefresh(account.id)} disabled={busy} title="立即同步" aria-label={`同步 ${account.name}`}>
            <ArrowClockwise className={busy ? 'spin' : ''} size={18} />
          </button>
          <button className="quiet-icon-button" type="button" onClick={() => onEdit(account)} title="编辑账号" aria-label={`编辑 ${account.name}`}>
            <PencilSimple size={18} />
          </button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            className="status-account-detail-motion"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="status-account-details"><AccountDetails account={account} state={detailState} onEdit={onEdit} /></div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IncidentHistory({ incidents, onAcknowledge }) {
  const visible = incidents.slice(0, 12);
  if (!visible.length) return <div className="history-empty">暂无告警记录</div>;
  return (
    <div className="history-list">
      {visible.map((incident) => (
        <div className="history-row" key={incident.id}>
          <span className={`status-dot ${incident.state === 'resolved' ? 'healthy' : 'warning'}`} />
          <div><strong>{incident.account?.name || '账号告警'}</strong><small>{incident.state === 'resolved' ? '余额恢复，系统已自动结单' : '余额低于阈值，等待充值恢复'} · {relativeTime(incident.openedAt || incident.createdAt)}</small></div>
          <span>{incident.state === 'resolved' ? '已结单' : incident.acknowledgedAt ? '已确认' : '处理中'}</span>
          {incident.state === 'open' && !incident.acknowledgedAt && <button type="button" className="text-command" onClick={() => onAcknowledge(incident.id)}>确认</button>}
        </div>
      ))}
    </div>
  );
}

export function StatusDashboard({
  dashboard,
  busyAccount,
  busyUpstream,
  onAddUpstream,
  onEditUpstream,
  onAddAccount,
  onEditAccount,
  onRefreshAccount,
  onRefreshUpstream,
  onSettings,
  onLogout,
  onAcknowledge,
  onLoadKeyDetails,
}) {
  const [expandedAccounts, setExpandedAccounts] = useState(() => new Set());
  const [detailStates, setDetailStates] = useState({});
  const [historyOpen, setHistoryOpen] = useState(false);

  const realAccounts = useMemo(() => dashboard.accounts.filter((account) => !account.demo), [dashboard.accounts]);
  const visibleAccounts = realAccounts.length ? realAccounts : dashboard.accounts;
  const visibleAccountIds = useMemo(() => new Set(visibleAccounts.map((account) => account.id)), [visibleAccounts]);
  const visibleIncidents = useMemo(() => dashboard.incidents.filter((incident) => visibleAccountIds.has(incident.accountId)), [dashboard.incidents, visibleAccountIds]);
  const visibleUpstreams = useMemo(() => dashboard.upstreams.filter((upstream) => (
    visibleAccounts.some((account) => account.upstreamId === upstream.id)
    || !realAccounts.length
    || (upstream.accountCount === 0 && upstream.demoAccountCount === 0)
  )), [dashboard.upstreams, visibleAccounts, realAccounts.length]);
  const attention = visibleAccounts.filter((account) => ['warning', 'critical', 'error', 'offline'].includes(account.status)).length;
  const allHealthy = visibleAccounts.length > 0 && visibleAccounts.every((account) => account.status === 'healthy');
  const lastSyncAt = visibleAccounts.map((account) => account.lastSyncAt).filter(Boolean).sort().at(-1) || null;
  const detailRevision = visibleAccounts.map((account) => `${account.id}:${account.updatedAt || ''}:${account.lastSyncAt || ''}:${account.apiTokenCount || 0}`).join('|');
  const expandedKeyIds = [...expandedAccounts].filter((id) => {
    const account = visibleAccounts.find((item) => item.id === id);
    return account && (account.authMode === 'api_token' || (account.type === 'newapi' && account.authMode === 'access_token'));
  }).sort().join('|');

  useEffect(() => {
    const ids = expandedKeyIds ? expandedKeyIds.split('|') : [];
    if (!ids.length) return undefined;
    let cancelled = false;
    for (const id of ids) {
      setDetailStates((current) => ({ ...current, [id]: { loading: true } }));
      onLoadKeyDetails(id).then((data) => {
        if (!cancelled) setDetailStates((current) => ({ ...current, [id]: { data } }));
      }).catch((error) => {
        if (!cancelled) setDetailStates((current) => ({ ...current, [id]: { error: error.message } }));
      });
    }
    return () => { cancelled = true; };
  }, [expandedKeyIds, detailRevision, onLoadKeyDetails]);

  const toggleAccount = (account) => {
    const nextExpanded = !expandedAccounts.has(account.id);
    const supportsKeyDetails = account.authMode === 'api_token'
      || (account.type === 'newapi' && account.authMode === 'access_token');
    if (nextExpanded && supportsKeyDetails) {
      setDetailStates((current) => ({ ...current, [account.id]: { loading: true } }));
    }
    setExpandedAccounts((current) => {
      const next = new Set(current);
      if (nextExpanded) next.add(account.id); else next.delete(account.id);
      return next;
    });
  };

  return (
    <main className="status-page">
      <div className="status-container">
        <header className="status-topbar">
          <div className="status-brand"><span className="status-brand-mark">上</span><div><strong>上游余额</strong><small>余额与告警监控</small></div></div>
          <div className="status-top-actions">
            <button className="quiet-icon-button large" type="button" onClick={onSettings} title="通知与安全设置" aria-label="通知与安全设置"><Gear size={20} /></button>
            <button className="quiet-icon-button large" type="button" onClick={onLogout} title="退出登录" aria-label="退出登录"><SignOut size={20} /></button>
            <button className="dark-command" type="button" onClick={onAddUpstream}><Plus size={18} weight="bold" />添加上游</button>
          </div>
        </header>

        <section className={`status-summary-banner ${allHealthy ? 'healthy' : attention ? 'warning' : 'pending'}`}>
          <div className="summary-title">
            {allHealthy ? <CheckCircle size={24} weight="fill" /> : <WarningCircle size={24} weight="fill" />}
            <strong>{allHealthy ? '所有上游运行正常' : attention ? `${attention} 个账号需要处理` : '等待添加监控账号'}</strong>
          </div>
          <p>{allHealthy ? `正在监控 ${visibleUpstreams.length} 个上游、${visibleAccounts.length} 个账号，当前没有未处理告警。` : attention ? '系统会持续检测余额；手动充值后，余额恢复将自动结单。' : '点击“添加上游”，再通过官方令牌接入账号。'}</p>
        </section>

        <section className="status-board" aria-label="上游状态">
          <header className="status-board-header">
            <div><h1>上游状态</h1><span>{visibleAccounts.length} 个账号</span></div>
            <span className="last-sync">最近同步 {relativeTime(lastSyncAt)}</span>
          </header>

          {visibleUpstreams.map((upstream) => {
            const accounts = visibleAccounts.filter((account) => account.upstreamId === upstream.id);
            const statusPriority = { error: 6, offline: 5, critical: 4, warning: 3, pending: 2, healthy: 1, empty: 0 };
            const upstreamStatus = accounts.length
              ? accounts.reduce((worst, account) => (statusPriority[account.status] > statusPriority[worst] ? account.status : worst), 'empty')
              : 'empty';
            const upstreamTotal = accounts.reduce((sum, account) => sum + Number(account.convertedCny || 0), 0);
            const upstreamPlatforms = [...new Set(accounts.map((account) => account.type))];
            return (
              <section className="status-upstream" key={upstream.id}>
                <header className="status-upstream-header">
                  <button className="status-upstream-banner" type="button" onClick={() => onEditUpstream(upstream)} title="编辑上游">
                    <span className={`status-icon ${upstreamStatus}`}>
                      {['healthy', 'empty'].includes(upstreamStatus) ? <CheckCircle size={22} weight="fill" /> : <WarningCircle size={22} weight="fill" />}
                    </span>
                    <span><strong>{upstream.name}</strong><small>{upstreamPlatforms.map(platformLabel).join(' / ') || '等待账号'} · {accounts.length} 个账号</small></span>
                    <span className="upstream-total">{money(upstreamTotal)}<small>人民币余额</small></span>
                    <span className={`status-label ${upstreamStatus}`}>{statusCopy(upstreamStatus)}</span>
                    <PencilSimple className="banner-edit-icon" size={17} />
                  </button>
                  <div className="status-upstream-actions">
                    <button className="quiet-icon-button" type="button" onClick={() => onRefreshUpstream(upstream.id)} disabled={busyUpstream === upstream.id || !accounts.length} title="同步该上游" aria-label={`同步 ${upstream.name}`}><ArrowClockwise className={busyUpstream === upstream.id ? 'spin' : ''} size={18} /></button>
                    <button className="quiet-icon-button add" type="button" onClick={() => onAddAccount(upstream.id)} title="添加账号" aria-label={`向 ${upstream.name} 添加账号`}><Plus size={19} weight="bold" /></button>
                  </div>
                </header>
                <div className="status-account-list">
                  {accounts.length ? accounts.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      expanded={expandedAccounts.has(account.id)}
                      detailState={detailStates[account.id]}
                      onToggle={() => toggleAccount(account)}
                      onRefresh={onRefreshAccount}
                      onEdit={onEditAccount}
                      busy={busyAccount === account.id}
                    />
                  )) : <button className="empty-account-row" type="button" onClick={() => onAddAccount(upstream.id)}><Plus size={17} />添加第一个监控账号</button>}
                </div>
              </section>
            );
          })}

          {!visibleUpstreams.length && <div className="status-empty"><h2>还没有上游</h2><p>先创建上游名称，再通过官方令牌添加监控账号。</p><button className="dark-command" type="button" onClick={onAddUpstream}><Plus size={18} />添加上游</button></div>}
        </section>

        <button className="history-toggle" type="button" onClick={() => setHistoryOpen((value) => !value)} aria-expanded={historyOpen}>
          <ClockCounterClockwise size={19} />{historyOpen ? '收起告警历史' : '查看告警历史'}
        </button>
        {historyOpen && <section className="history-panel"><header><div><Bell size={18} /><h2>告警与自动结单记录</h2></div><span>最近 {Math.min(12, visibleIncidents.length)} 条</span></header><IncidentHistory incidents={visibleIncidents} onAcknowledge={onAcknowledge} /></section>}

        <footer className="status-footer">余额统一换算为人民币。低于账号阈值时触发 Resend / 飞书通知，充值恢复后自动结单。</footer>
      </div>
    </main>
  );
}
