import { useEffect, useState } from 'react';
import { ArrowRight, Bell, Check, CheckCircle, GlobeHemisphereWest, SlidersHorizontal, SpinnerGap, WarningCircle } from '@phosphor-icons/react';
import { accountSetupSignature, getOnboardingState, isAccountSynced } from '../onboarding.js';
import { compactNumber, money, relativeTime } from '../lib.js';
import { CHANNEL_NAMES } from '../notification-state.js';
import '../onboarding.css';

const STEP_COPY = [
  { id: 'upstream', title: '创建上游', hint: '给要监控的站点起个名字' },
  { id: 'account', title: '接入账号', hint: '连接你在该站点的账号' },
  { id: 'balance', title: '核对余额', hint: '确认人民币换算与阈值' },
  { id: 'notifications', title: '设置提醒', hint: '选择接收告警的地方' },
];

function readPreferences(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function SetupStepNote({ step, children }) {
  return <div className="setup-step-note"><span>首次设置 · {step}/4</span><p>{children}</p></div>;
}

export function OnboardingGuide({ dashboard, username, requested, onOpenChange, onAction, busyAccount }) {
  const storageKey = `frosted:first-use:v1:${encodeURIComponent(username || 'local')}`;
  const [preferences, setPreferences] = useState(() => readPreferences(storageKey));
  const [selectedStep, setSelectedStep] = useState(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const state = getOnboardingState(dashboard, preferences);
  const hasPreviousAccounts = state.realAccounts.length > 0 || dashboard.deletedAccounts?.some((account) => !account.demo);
  const visible = requested ?? (!preferences.dismissed && (preferences.started || !hasPreviousAccounts));
  const activeStep = selectedStep || state.currentStepId;
  const account = state.account;
  const synced = isAccountSynced(account);
  const isBusy = Boolean(account && busyAccount === account.id);
  const needsAccountChannels = account && !state.channels.length
    && ['resend', 'feishu', 'telegram'].some((channel) => dashboard.settings?.[`${channel}Enabled`] && dashboard.settings?.[`${channel}Configured`]);

  useEffect(() => {
    if (visible && !preferences.started) setPreferences((value) => ({ ...value, started: true }));
  }, [visible, preferences.started]);

  useEffect(() => {
    if (requested === true) setPreferences((value) => ({ ...value, started: true, dismissed: false }));
  }, [requested]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
      setStorageUnavailable(false);
    } catch { setStorageUnavailable(true); }
  }, [storageKey, preferences]);

  const update = (values) => setPreferences((value) => ({ ...value, ...values }));
  const close = () => {
    update({ dismissed: true });
    setSelectedStep(null);
    onOpenChange(false);
  };
  const action = (type, target) => {
    update({ dismissed: false, started: true });
    setSelectedStep(null);
    onAction(type, target);
  };
  const selectStep = (id) => {
    update({ dismissed: false, started: true });
    setSelectedStep(id);
  };

  if (!visible) return null;

  return <section className="onboarding-guide" aria-labelledby="onboarding-title">
    <header className="onboarding-heading">
      <div><span className="onboarding-eyebrow">首次设置</span><h1 id="onboarding-title">{state.complete ? '第一个监控，准备好了' : '从一个上游开始'}</h1><p>接入账号，核对余额，让下一次低余额有提醒。</p></div>
      <div className="onboarding-progress"><strong>{state.completedCount}<span> / 4</span></strong><small>已完成</small></div>
    </header>
    <div className="onboarding-meter" role="progressbar" aria-label="首次设置进度" aria-valuemin={0} aria-valuemax={4} aria-valuenow={state.completedCount}><i style={{ width: `${state.completedCount * 25}%` }} /></div>
    <div className="onboarding-body">
      <ol className="onboarding-steps" aria-label="设置步骤">
        {STEP_COPY.map((step, index) => {
          const completed = state.steps[index].complete;
          const unavailable = index === 1 ? !state.upstream : index >= 2 ? !account : false;
          return <li key={step.id}><button type="button" disabled={unavailable} className={`${activeStep === step.id ? 'active' : ''} ${completed ? 'complete' : ''}`} aria-current={activeStep === step.id ? 'step' : undefined} onClick={() => selectStep(step.id)}>
            <span className="onboarding-step-number">{completed ? <Check size={15} weight="bold" aria-label="已完成" /> : index + 1}</span><span><strong>{step.title}</strong><small>{step.hint}</small></span>
          </button></li>;
        })}
      </ol>
      <div className="onboarding-content">
        {state.complete && !selectedStep ? <div className="onboarding-complete">
          <CheckCircle size={32} weight="fill" /><h2>余额监控与提醒已配置</h2>
          <p>「{account?.name}」每 {account?.pollIntervalMinutes || 5} 分钟同步一次，低于 {money(account?.thresholdLow)} 时通过 {state.channels.map((channel) => CHANNEL_NAMES[channel]).join('、')} 提醒你。</p>
          <p className="onboarding-note">充值后，连续 {dashboard.settings?.recoveryConfirmations || 2} 次达到 {money(account?.thresholdRecover)} 会自动结单。可以在通知设置中手动发送测试，确认能够收到。</p>
          <div className="onboarding-actions"><button type="button" className="primary-button" onClick={close}>开始监控 <ArrowRight size={16} /></button><button type="button" className="text-command" onClick={() => action('notifications')}>查看通知设置</button></div>
        </div> : <>
          {activeStep === 'upstream' && <>
            <GlobeHemisphereWest className="onboarding-content-icon" size={25} /><h2>{state.upstream ? '上游已创建' : '你想监控哪个站点？'}</h2>
            <p>“上游”就是你使用的中转站。同一站点下的主账号、备用账号，都归到这个上游。</p>
            {state.upstream && <div className="onboarding-saved"><CheckCircle size={18} />{state.upstream.name}</div>}
            <div className="onboarding-actions"><button className="primary-button" type="button" onClick={() => state.upstream ? selectStep('account') : action('upstream')}>{state.upstream ? '继续接入账号' : '创建第一个上游'}<ArrowRight size={16} /></button></div>
            <p className="onboarding-note">先填一个便于识别的名称即可。默认直连，代理出口可以稍后设置。</p>
          </>}
          {activeStep === 'account' && <>
            <h2>{account ? '账号已保存' : '连接你的第一个账号'}</h2>
            <p>New API 使用个人资料中的访问令牌和 User ID；Sub2API 可以使用 API Key，也可以通过浏览器登录。</p>
            {state.realUpstreams.length > 1 && !account && <label className="onboarding-select"><span>所属上游</span><select value={state.upstream?.id || ''} onChange={(event) => update({ upstreamId: event.target.value })}>{state.realUpstreams.map((upstream) => <option key={upstream.id} value={upstream.id}>{upstream.name}</option>)}</select></label>}
            <div className="onboarding-saved"><GlobeHemisphereWest size={18} />{state.upstream?.name}{account ? ` / ${account.name}` : ''}</div>
            <div className="onboarding-actions"><button type="button" className="primary-button" onClick={() => account ? selectStep('balance') : action('account', state.upstream?.id)}>{account ? '核对余额与阈值' : '添加监控账号'}<ArrowRight size={16} /></button></div>
            <p className="onboarding-note">账号添加后会立即尝试同步。凭据加密保存，不会在引导中回显。</p>
          </>}
          {activeStep === 'balance' && account && <>
            <h2>确认读到的是你要监控的余额</h2>
            {state.realAccounts.length > 1 && <label className="onboarding-select"><span>本次设置的账号</span><select value={account.id} onChange={(event) => update({ accountId: event.target.value })}>{state.realAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
            {synced ? <>
              <p>对照上游页面核对换算结果，再确认什么余额需要提醒你。</p>
              <div className="onboarding-balance"><div><span>原始余额</span><strong>{compactNumber(account.rawBalance)} <small>{account.rawUnit}</small></strong></div><ArrowRight size={19} aria-hidden="true" /><div><span>人民币余额</span><strong>{money(account.convertedCny)}</strong></div><code>换算公式：{account.formula}</code></div>
              <dl className="onboarding-thresholds"><div><dt>低于此值提醒</dt><dd>{money(account.thresholdLow)}</dd></div><div><dt>达到此值恢复</dt><dd>{money(account.thresholdRecover)}</dd></div><div><dt>检测频率</dt><dd>每 {account.pollIntervalMinutes} 分钟</dd></div></dl>
              {['warning', 'critical'].includes(account.status) && <p className="onboarding-warning"><WarningCircle size={17} />已成功读取，当前余额低于告警阈值。你可以充值，或调整阈值。</p>}
              <div className="onboarding-actions"><button type="button" className="primary-button" onClick={() => { update({ accountId: account.id, confirmedSignature: accountSetupSignature(account), dismissed: false }); setSelectedStep(null); }}>{state.steps[2].complete ? '核对完成，继续' : '余额与阈值无误，继续'}<ArrowRight size={16} /></button><button type="button" className="text-command" onClick={() => action('balance', account)}><SlidersHorizontal size={16} />调整换算与阈值</button></div>
              <p className="onboarding-note">最近同步 {relativeTime(account.lastSyncAt)} · 修改换算或阈值后，需要重新核对。</p>
            </> : <>
              <div className="onboarding-warning" role="status"><WarningCircle size={20} /><div><strong>{account.enabled === false ? '这个账号尚未启用监控' : account.lastError ? '首次同步还没有成功' : '等待首次同步'}</strong><p>{account.lastError || (account.enabled === false ? '在账号设置中启用监控后，再同步余额。' : '同步成功后，这里会显示原始余额、换算结果和告警阈值。')}</p></div></div>
              <div className="onboarding-actions">{account.enabled !== false && <button type="button" className="primary-button" disabled={isBusy} onClick={() => action('sync', account.id)}>{isBusy && <SpinnerGap className="spin" />}{isBusy ? '正在同步…' : '重新同步余额'}</button>}<button type="button" className="secondary-button" onClick={() => action('balance', account)}>检查账号设置</button></div>
            </>}
          </>}
          {activeStep === 'notifications' && <>
            <Bell className="onboarding-content-icon" size={25} /><h2>{state.channels.length ? '提醒渠道已配置' : '低余额时，在哪里提醒你？'}</h2>
            <p>选择邮件、飞书或 Telegram 中至少一个渠道。没有配置通知时，霜镜仍会检测余额，但你需要打开面板查看。</p>
            {state.channels.length ? <div className="onboarding-saved"><CheckCircle size={18} />{state.channels.map((channel) => CHANNEL_NAMES[channel]).join('、')} 已启用</div> : needsAccountChannels ? <div className="onboarding-warning"><WarningCircle size={18} /><span>全局渠道已就绪，请在「{account.name}」的账号设置中勾选要使用的通知渠道。</span></div> : <div className="onboarding-channel-options"><span>Resend 邮件</span><span>飞书机器人</span><span>Telegram</span></div>}
            <div className="onboarding-actions"><button type="button" className="primary-button" onClick={() => state.channels.length ? setSelectedStep(null) : needsAccountChannels ? action('balance', account) : action('notifications')}>{state.channels.length ? '查看完成状态' : needsAccountChannels ? '启用账号通知' : '配置提醒渠道'}<ArrowRight size={16} /></button>{state.channels.length > 0 && <button type="button" className="text-command" onClick={() => action('notifications')}>查看通知设置</button>}</div>
            <p className="onboarding-note">设置里的“测试”会发送一条真实消息，由你手动触发。配置完成后记得保存。</p>
          </>}
        </>}
      </div>
    </div>
    <footer className="onboarding-footer"><span>{storageUnavailable ? '浏览器未允许保存引导进度，账号设置仍会正常保存。' : '可随时暂停，从右上角「首次设置」继续。'}</span><button className="text-command" type="button" onClick={close}>{state.complete ? '收起引导' : '稍后设置'}</button></footer>
  </section>;
}
