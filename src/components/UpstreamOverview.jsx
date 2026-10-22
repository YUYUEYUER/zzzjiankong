import {
  ArrowClockwise,
  ArrowRight,
  Eye,
  EyeSlash,
  PencilSimple,
  Plus,
  WarningCircle,
} from '@phosphor-icons/react';
import { hostname, money, platformLabel, relativeTime, statusLabels } from '../lib.js';

const statusOrder = { error: 6, offline: 5, critical: 4, warning: 3, pending: 2, healthy: 1, empty: 0 };

export function UpstreamOverview({
  upstreams,
  accounts,
  hasDemo,
  showDemo,
  setShowDemo,
  onOpen,
  onEdit,
  onAddAccount,
  onAddUpstream,
  onRefresh,
  busyUpstream,
}) {
  const sorted = [...upstreams].sort((a, b) => (
    Number(b.realAccountCount > 0) - Number(a.realAccountCount > 0)
    || Number(b.openIncidents || 0) - Number(a.openIncidents || 0)
    || (statusOrder[b.status] || 0) - (statusOrder[a.status] || 0)
    || a.name.localeCompare(b.name, 'zh-CN')
  ));
  const accountCount = sorted.reduce((sum, upstream) => sum + upstream.accountCount, 0);
  const totalCny = sorted.reduce((sum, upstream) => sum + Number(upstream.totalCny || 0), 0);
  const attention = sorted.filter((upstream) => ['warning', 'critical', 'offline', 'error'].includes(upstream.status)).length;
  const openIncidents = sorted.reduce((sum, upstream) => sum + Number(upstream.openIncidents || 0), 0);

  return (
    <main className="upstream-overview glass-surface">
      <section className="overview-summary" aria-label="上游监控摘要">
        <div><span>监控上游</span><strong>{sorted.length}</strong><small>{accountCount} 个账号</small></div>
        <div><span>人民币余额</span><strong>{money(totalCny)}</strong><small>按当前换算公式汇总</small></div>
        <div className={attention ? 'attention' : ''}><span>需要关注</span><strong>{attention}</strong><small>低余额或连接异常</small></div>
        <div className={openIncidents ? 'attention' : ''}><span>处理中事件</span><strong>{openIncidents}</strong><small>等待充值或恢复检测</small></div>
      </section>

      <header className="upstream-toolbar">
        <div>
          <h1>上游总览</h1>
          <span>{showDemo ? '包含演示数据' : '演示数据已隐藏'}</span>
        </div>
        <div className="upstream-toolbar-actions">
          {hasDemo && (
            <button className="secondary-button" onClick={() => setShowDemo(!showDemo)}>
              {showDemo ? <EyeSlash size={16} /> : <Eye size={16} />}
              {showDemo ? '隐藏演示数据' : '显示演示数据'}
            </button>
          )}
          <button className="primary-button" onClick={onAddUpstream}><Plus size={17} weight="bold" /> 添加上游</button>
        </div>
      </header>

      <div className="upstream-table-wrap">
        <table className="upstream-table">
          <thead>
            <tr>
              <th>上游名称</th>
              <th>平台与站点</th>
              <th>代理出口</th>
              <th>账号</th>
              <th>人民币余额</th>
              <th>状态</th>
              <th>待处理</th>
              <th>最近检测</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((upstream) => {
              const members = accounts.filter((account) => account.upstreamId === upstream.id);
              const primaryUrl = upstream.baseUrls[0];
              return (
                <tr key={upstream.id} className={upstream.realAccountCount ? 'real-upstream' : upstream.demoAccountCount > 0 ? 'demo-upstream' : 'empty-upstream'}>
                  <td data-label="上游名称">
                    <button className="upstream-name-button" onClick={() => onOpen(upstream.id)}>
                      <i className={`status-dot ${upstream.status}`} />
                      <span><strong>{upstream.name}</strong>{upstream.realAccountCount === 0 && upstream.demoAccountCount > 0 && <em>演示</em>}</span>
                    </button>
                  </td>
                  <td data-label="平台与站点">
                    <span className="platform-list">{upstream.platforms.length ? upstream.platforms.map(platformLabel).join(' / ') : '未配置'}</span>
                    <small>{primaryUrl ? hostname(primaryUrl) : '尚未添加站点'}</small>
                  </td>
                  <td data-label="代理出口">
                    {upstream.proxyMode === 'auto_sticky' ? (
                      <span className={`proxy-exit-cell ${upstream.proxyStatus || 'unchecked'}`}><i /><strong>{upstream.proxyNodeName || '等待分配'}</strong><small>{upstream.proxyLatencyMs == null ? '未检测' : `${upstream.proxyLatencyMs} ms · 固定`}</small></span>
                    ) : <span className="proxy-exit-cell direct"><i /><strong>直连</strong><small>服务器出口</small></span>}
                  </td>
                  <td data-label="账号"><strong className="tabular">{upstream.accountCount}</strong><small>{members.length ? members.map((account) => account.name).slice(0, 2).join('、') : '等待添加账号'}</small></td>
                  <td data-label="人民币余额" className="balance-cell">{money(upstream.totalCny)}{Number.isFinite(upstream.minEtaDays) && upstream.minEtaDays <= 14 && <small className="eta-note">最快约 {upstream.minEtaDays} 天耗尽</small>}</td>
                  <td data-label="状态"><span className={`state-badge upstream-state ${upstream.status}`}>{statusLabels[upstream.status] || upstream.status}</span></td>
                  <td data-label="待处理" className={upstream.openIncidents ? 'attention-count' : ''}>{upstream.openIncidents ? <><WarningCircle size={16} weight="fill" /> {upstream.openIncidents} 项</> : '—'}</td>
                  <td data-label="最近检测">{relativeTime(upstream.lastSyncAt)}</td>
                  <td data-label="操作">
                    <div className="row-actions">
                      {upstream.accountCount > 0 && <button className="icon-button" onClick={() => onRefresh(upstream.id)} disabled={busyUpstream === upstream.id} title="同步该上游"><ArrowClockwise size={17} className={busyUpstream === upstream.id ? 'spin' : ''} /></button>}
                      <button className="icon-button" onClick={() => onEdit(upstream)} title="编辑上游"><PencilSimple size={17} /></button>
                      <button className="secondary-button compact" onClick={() => upstream.accountCount ? onOpen(upstream.id) : onAddAccount(upstream.id)}>
                        {upstream.accountCount ? <>进入 <ArrowRight size={15} /></> : <><Plus size={15} /> 添加账号</>}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="upstream-empty">
            <h2>还没有真实上游</h2>
            <button className="primary-button" onClick={onAddUpstream}><Plus size={17} /> 添加第一个上游</button>
          </div>
        )}
      </div>
    </main>
  );
}
