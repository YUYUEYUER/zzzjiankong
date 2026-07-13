import { useMemo, useState } from 'react';
import { BellRinging, CheckCircle, EnvelopeSimple, Link, ShieldCheck, Wallet, PaperPlaneTilt } from '@phosphor-icons/react';
import { duration, money, relativeTime } from '../lib.js';
import { notificationResult, notificationStatus, notificationText, notificationTone } from '../notification-state.js';

const steps = [
  { id: 'trigger', icon: BellRinging, title: '低余额事件建立', tone: 'warning' },
  { id: 'opened', icon: EnvelopeSimple, title: '首次告警通知', tone: 'blue' },
  { id: 'recharge', icon: Wallet, title: '等待手动充值', tone: 'blue' },
  { id: 'recover', icon: CheckCircle, title: '连续检测恢复', tone: 'green' },
  { id: 'recovered', icon: PaperPlaneTilt, title: '恢复通知', tone: 'green' },
  { id: 'closed', icon: ShieldCheck, title: '自动结单', tone: 'green' },
];

function ResultLine({ incident, kind, channel, Icon }) {
  const result = notificationResult(incident, kind, channel);
  return <span className={`notification-line ${notificationTone(result)}`}><Icon size={13} /><b>{channel === 'resend' ? 'Resend' : '飞书'}</b><em>{notificationText(result, channel)}</em></span>;
}

function channelReadiness(account, settings, channel) {
  if (!settings[`${channel}Enabled`]) return { label: '全局未启用', tone: '' };
  if (account.notifications?.[channel] === false) return { label: '该账号已关闭', tone: '' };
  if (!settings[`${channel}Configured`]) return { label: '配置不完整', tone: 'error' };
  return { label: '链路已就绪', tone: 'on' };
}

export function Inspector({ account, incidents, settings, onOpenIncidents }) {
  const [tab, setTab] = useState('connection');
  const incident = useMemo(() => {
    const matching = incidents.filter((item) => item.accountId === account?.id);
    return matching.find((item) => item.state === 'open') || matching[0];
  }, [account?.id, incidents]);

  const stepComplete = (id) => {
    if (!incident) return false;
    if (id === 'trigger') return true;
    if (id === 'opened') return ['resend', 'feishu'].some((channel) => notificationStatus(notificationResult(incident, 'opened', channel)) !== 'pending');
    if (id === 'recharge') return incident.state === 'resolved' || Number(incident.recoveryChecks || 0) > 0;
    if (id === 'recover') return incident.state === 'resolved';
    if (id === 'recovered') return ['resend', 'feishu'].some((channel) => notificationStatus(notificationResult(incident, 'recovered', channel)) !== 'pending');
    return incident.state === 'resolved';
  };

  const credentialSummary = account ? [
    account.hasApiToken ? `API 密钥${account.apiTokenCount > 1 ? ` × ${account.apiTokenCount}` : ''}` : null,
    account.hasAccessToken ? `用户访问令牌${account.accessTokenCount > 1 ? ` × ${account.accessTokenCount}` : ''}` : null,
    account.hasRefreshToken ? 'RT' : null,
    account.hasPassword ? '密码' : null,
  ].filter(Boolean).join(' · ') || '未配置' : '';

  const balanceScope = account?.metadata?.balanceScope === 'api_key' || account?.authMode === 'api_token'
    ? 'API 密钥额度'
    : '用户账户余额';

  return (
    <aside className="inspector glass-surface">
      <div className="inspector-tabs">
        {[['connection', '闭环'], ['conversion', '转换'], ['alert', '通知']].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === 'connection' && (
        <div className="inspector-content">
          <div className="inspector-heading"><h2>余额处理闭环</h2><span>{incident?.state === 'resolved' ? '已结单' : incident ? '处理中' : '待命'}</span></div>
          {!account && <p className="inspector-empty">选择账号后查看通知与恢复闭环。</p>}
          {account && <div className="token-status-card">
            <div className="token-status-row"><span>读取范围</span><strong>{balanceScope}</strong></div>
            <div className="token-status-row"><span>鉴权来源</span><strong>{account.metadata?.authSource || (account.hasApiToken ? 'api_key' : account.hasAccessToken ? 'user_access_token' : account.hasPassword ? 'password' : '—')}</strong></div>
            <div className="token-status-row"><span>凭据</span><strong>{credentialSummary}</strong></div>
            {account.type === 'newapi' && account.authMode === 'api_token' && <>
              <div className="token-status-row"><span>API 密钥调度</span><strong>{account.tokenStrategy === 'round_robin' ? '轮询' : '故障切换'} · 槽位 {account.metadata?.apiTokenSlot || 1}/{account.apiTokenCount || 1}</strong></div>
              <p className="token-status-note">免登录读取该 API 密钥的剩余额度，不代表整个用户钱包。无限额度密钥没有可监控的有限余额。</p>
            </>}
            {account.type === 'newapi' && account.authMode !== 'api_token' && account.accessTokenCount > 1 && <div className="token-status-row"><span>用户令牌调度</span><strong>{account.tokenStrategy === 'round_robin' ? '轮询' : '故障切换'} · 槽位 {account.metadata?.tokenSlot || 1}/{account.accessTokenCount}</strong></div>}
            {account.type === 'sub2api' && <><div className="token-status-row"><span>AT 状态</span><strong>{account.metadata?.refreshReason ? '已主动续期' : account.metadata?.accessTokenExpiresAt ? `到期 ${relativeTime(account.metadata.accessTokenExpiresAt)}` : '等待上游信息'}</strong></div><p className="token-status-note">Sub2API：AT 临期会用 RT 提前续期，旋转后的 RT 会自动加密回写。</p></>}
          </div>}
          {account && !incident && <div className="all-clear"><ShieldCheck size={30} /><h3>运行正常</h3><p>当前没有需要处理的余额事件。</p></div>}
          {account && incident && <div className="timeline">{steps.map((step) => {
            const complete = stepComplete(step.id);
            const Icon = step.icon;
            return <div className={`timeline-step ${complete ? 'complete' : ''}`} key={step.id}><div className={`timeline-icon ${complete ? step.tone : ''}`}><Icon size={17} weight={complete ? 'fill' : 'regular'} /></div><div className="timeline-copy"><div><strong>{step.title}</strong>{step.id === 'closed' && incident.state === 'resolved' && <em>已结单</em>}</div>
              {step.id === 'trigger' && <p>当前 {money(incident.currentBalance)}，告警阈值 {money(account.thresholdLow)}</p>}
              {step.id === 'opened' && <div className="notification-lines"><ResultLine incident={incident} kind="opened" channel="resend" Icon={EnvelopeSimple} /><ResultLine incident={incident} kind="opened" channel="feishu" Icon={PaperPlaneTilt} />{incident.notifications?.reminders?.length > 0 && <small>已重复提醒 {incident.notifications.reminders.length} 次，最近 {relativeTime(incident.lastReminderAt)}</small>}</div>}
              {step.id === 'recharge' && <p>{incident.state === 'resolved' || incident.recoveryChecks > 0 ? `检测到余额回升至 ${money(incident.currentBalance)}` : '等待你在上游完成充值；系统会按采集频率自动复查'}</p>}
              {step.id === 'recover' && <p>恢复确认 {incident.recoveryChecks || 0}/{settings.recoveryConfirmations || 2}，达到 {money(account.thresholdRecover)} 才累计</p>}
              {step.id === 'recovered' && <div className="notification-lines"><ResultLine incident={incident} kind="recovered" channel="resend" Icon={EnvelopeSimple} /><ResultLine incident={incident} kind="recovered" channel="feishu" Icon={PaperPlaneTilt} /></div>}
              {step.id === 'closed' && <p>{incident.resolvedAt ? `自动结单于 ${relativeTime(incident.resolvedAt)}` : '恢复确认完成后自动执行，无需手工结单'}</p>}
            </div></div>;
          })}</div>}
          {incident && <div className="incident-summary"><span>事件持续</span><strong>{duration(incident.openedAt, incident.resolvedAt)}</strong><small>事件号 {incident.id.slice(0, 8)}</small></div>}
        </div>
      )}

      {tab === 'conversion' && account && <div className="inspector-content inspector-detail"><h2>转换详情</h2><dl><div><dt>原始字段</dt><dd>{account.balancePath}</dd></div><div><dt>原始单位</dt><dd>{account.rawUnit}</dd></div><div><dt>原始余额</dt><dd>{account.rawBalance}</dd></div><div><dt>转换公式</dt><dd><code>{account.formula}</code></dd></div><div className="strong"><dt>人民币余额</dt><dd>{money(account.convertedCny)}</dd></div></dl><div className="formula-rule"><CheckCircle size={18} weight="fill" /><p>公式仅允许变量 x、数字、括号和四则运算。</p></div></div>}

      {tab === 'alert' && account && <div className="inspector-content inspector-detail"><h2>通知链路</h2><dl><div><dt>低余额阈值</dt><dd>{money(account.thresholdLow)}</dd></div><div><dt>恢复阈值</dt><dd>{money(account.thresholdRecover)}</dd></div><div><dt>恢复确认</dt><dd>连续 {settings.recoveryConfirmations || 2} 次</dd></div><div><dt>重复提醒</dt><dd>每 {settings.reminderHours || 6} 小时</dd></div></dl><div className="channel-list">{[['resend', EnvelopeSimple, 'Resend 邮件'], ['feishu', PaperPlaneTilt, '飞书机器人']].map(([channel, Icon, label]) => { const state = channelReadiness(account, settings, channel); return <div key={channel}><Icon size={18} /><span>{label}</span><b className={state.tone}>{state.label}</b></div>; })}</div><p className="channel-scope-note">渠道需要同时满足“全局启用、凭据完整、该账号启用”才会发送。</p></div>}
      <button className="inspector-history" onClick={onOpenIncidents}><Link size={16} /> 查看事件记录</button>
    </aside>
  );
}
