import { ArrowClockwise, CaretLeft, CaretRight, Check, EnvelopeSimple, Eye, PaperPlaneTilt } from '@phosphor-icons/react';
import { duration, money } from '../lib.js';
import { notificationResult, notificationStatus, notificationText } from '../notification-state.js';

export function IncidentQueue({ incidents, filter, setFilter, onAcknowledge, onSelectAccount, onRefresh }) {
  const shown = incidents
    .filter((incident) => filter === 'all' || (filter === 'open' ? incident.state === 'open' : incident.state === 'resolved'))
    .slice(0, 8);
  const open = incidents.filter((incident) => incident.state === 'open').length;
  const resolved = incidents.filter((incident) => incident.state === 'resolved').length;

  return (
    <section className="incident-queue glass-surface">
      <header className="queue-header">
        <div className="queue-title"><h2>事件队列</h2><div className="queue-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 <span>{incidents.length}</span></button>
          <button className={filter === 'open' ? 'active warning' : ''} onClick={() => setFilter('open')}>告警中 <span>{open}</span></button>
          <button className={filter === 'resolved' ? 'active success' : ''} onClick={() => setFilter('resolved')}>已结单 <span>{resolved}</span></button>
        </div></div>
        <div className="queue-actions"><button onClick={onRefresh}><ArrowClockwise size={15} /> 刷新</button></div>
      </header>
      <div className="queue-table-wrap">
        <table>
          <thead><tr><th>状态</th><th>上游 / 账号</th><th>平台</th><th>地区</th><th>人民币余额</th><th>触发时间</th><th>持续时长</th><th>通知渠道</th><th>恢复状态</th><th>操作</th></tr></thead>
          <tbody>
            {shown.map((incident) => (
              <tr key={incident.id}>
                <td><span className={`state-badge ${incident.state}`}>{incident.state === 'open' ? '告警中' : '已结单'}</span></td>
                <td><button className="table-link upstream-incident-link" onClick={() => onSelectAccount(incident.accountId)}><strong>{incident.upstream?.name || '已删除上游'}</strong><small>{incident.account?.name || '已删除账号'}</small></button></td>
                <td>{incident.account?.type === 'newapi' ? 'New API' : incident.account?.type === 'sub2api' ? 'Sub2API' : '自定义'}</td>
                <td>{incident.account?.region || '-'}</td>
                <td className={incident.state === 'open' ? 'money-warning' : 'money-success'}>{money(incident.currentBalance)}</td>
                <td>{new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(incident.openedAt))}</td>
                <td className={incident.state === 'open' ? 'duration-open' : ''}>{duration(incident.openedAt, incident.resolvedAt)}</td>
                <td><span className="channel-icons">{[['resend', EnvelopeSimple], ['feishu', PaperPlaneTilt]].map(([channel, Icon]) => { const result = notificationResult(incident, 'opened', channel); const status = notificationStatus(result); return <Icon key={channel} className={status} title={notificationText(result, channel)} size={16} weight={status === 'sent' ? 'fill' : 'regular'} />; })}</span></td>
                <td>{incident.state === 'resolved' ? `已恢复 (${incident.recoveryChecks}/2)` : `未恢复 (${incident.recoveryChecks || 0}/2)`}</td>
                <td>{incident.state === 'open' && !incident.acknowledgedAt ? <button className="table-action" onClick={() => onAcknowledge(incident.id)}><Check size={14} /> 确认</button> : <button className="table-action" onClick={() => onSelectAccount(incident.accountId)}><Eye size={14} /> 查看</button>}</td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan="10" className="empty-table">当前筛选下没有事件</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className="queue-footer"><span>每页 10 条</span><div><button disabled aria-label="上一页"><CaretLeft size={13} /></button><button className="active">1</button><button disabled aria-label="下一页"><CaretRight size={13} /></button></div></footer>
    </section>
  );
}
