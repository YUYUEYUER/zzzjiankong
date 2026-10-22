import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, EnvelopeSimple, Flask, GlobeHemisphereWest, PaperPlaneTilt, ShieldCheck, SpinnerGap, TelegramLogo, WarningCircle, WechatLogo } from '@phosphor-icons/react';
import { api } from '../api.js';
import { notificationText, notificationTone } from '../notification-state.js';
import { Modal } from './Modal.jsx';
import { SecurityPanel } from './SecurityPanel.jsx';
import { ProxyPoolPanel } from './ProxyPoolPanel.jsx';
import { SetupStepNote } from './OnboardingGuide.jsx';

const DEFAULT_REMINDER_MINUTES = 360;
const REMINDER_PRESETS = [180, 360, 720, 1440];
const DEFAULT_RECOVERY_CONFIRMATIONS = 2;
const RECOVERY_PRESETS = [1, 2, 3];
const DEPLETION_PRESETS = [0, 3, 7, 14];

function readiness(channel, form) {
  if (channel === 'resend') {
    const missing = [
      !(form.resendApiKey || form.hasResendApiKey) && 'API Key',
      !form.resendFrom?.trim() && '发件人',
      !form.resendTo?.trim() && '收件人',
    ].filter(Boolean);
    return { ready: missing.length === 0, missing };
  }
  if (channel === 'feishu') {
    const ready = Boolean(form.feishuWebhook || form.hasFeishuWebhook);
    return { ready, missing: ready ? [] : ['Webhook'] };
  }
  if (channel === 'telegram') {
    const missing = [
      !(form.telegramBotToken || form.hasTelegramBotToken) && 'Bot Token',
      !form.telegramChatId?.trim() && 'Chat ID',
    ].filter(Boolean);
    return { ready: missing.length === 0, missing };
  }
  const ready = Boolean(form.wecomWebhook || form.hasWecomWebhook);
  return { ready, missing: ready ? [] : ['Webhook'] };
}

function ChannelState({ enabled, ready, missing }) {
  const tone = !enabled ? 'muted' : ready ? 'success' : 'error';
  const label = !enabled ? '未启用' : ready ? '配置完整' : `缺少 ${missing.join('、')}`;
  return <span className={`channel-state ${tone}`}>{label}</span>;
}

function TestResult({ result, channel }) {
  if (!result) return null;
  const tone = notificationTone(result);
  const Icon = tone === 'success' ? CheckCircle : WarningCircle;
  return (
    <div className={`channel-test-result ${tone}`}>
      <Icon size={16} weight="fill" />
      <div><strong>{notificationText(result, channel)}</strong><small>{result.completedAt ? new Date(result.completedAt).toLocaleString('zh-CN') : ''}{result.durationMs != null ? ` · ${result.durationMs} ms` : ''}</small></div>
    </div>
  );
}

export function SettingsModal({ open, onboarding = false, settings, proxyPool, initialTab = 'notifications', session, onSessionChanged, onClose, onSaved, onProxyPoolChanged, pushToast }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState('');
  const [tests, setTests] = useState({});
  const [tab, setTab] = useState('notifications');
  const [reminderMode, setReminderMode] = useState('360');
  const [customReminderMinutes, setCustomReminderMinutes] = useState(DEFAULT_REMINDER_MINUTES);
  const [recoveryMode, setRecoveryMode] = useState(String(DEFAULT_RECOVERY_CONFIRMATIONS));
  const [customRecoveryConfirmations, setCustomRecoveryConfirmations] = useState(DEFAULT_RECOVERY_CONFIRMATIONS);
  const [depletionMode, setDepletionMode] = useState('0');
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const reminderMinutes = Number(settings?.reminderMinutes) || DEFAULT_REMINDER_MINUTES;
      const recoveryConfirmations = Number(settings?.recoveryConfirmations) || DEFAULT_RECOVERY_CONFIRMATIONS;
      setForm({ ...settings, reminderMinutes, recoveryConfirmations, resendApiKey: '', feishuWebhook: '', telegramBotToken: '', wecomWebhook: '' });
      setReminderMode(REMINDER_PRESETS.includes(reminderMinutes) ? String(reminderMinutes) : 'custom');
      setCustomReminderMinutes(reminderMinutes);
      setRecoveryMode(RECOVERY_PRESETS.includes(recoveryConfirmations) ? String(recoveryConfirmations) : 'custom');
      setCustomRecoveryConfirmations(recoveryConfirmations);
      const depletionAlertDays = Number(settings?.depletionAlertDays) || 0;
      setDepletionMode(DEPLETION_PRESETS.includes(depletionAlertDays) ? String(depletionAlertDays) : 'custom');
      setTests({});
    }
    wasOpen.current = open;
  }, [open, settings]);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const resendState = useMemo(() => readiness('resend', form), [form]);
  const feishuState = useMemo(() => readiness('feishu', form), [form]);
  const telegramState = useMemo(() => readiness('telegram', form), [form]);
  const wecomState = useMemo(() => readiness('wecom', form), [form]);
  const proxyNeedsAttention = Boolean(proxyPool?.subscription?.lastError)
    || Boolean(proxyPool?.subscription?.configured && !proxyPool?.summary?.available);
  const proxyReady = Boolean(proxyPool?.subscription?.configured && proxyPool?.summary?.available > 0 && !proxyPool?.subscription?.lastError);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const changeReminderMode = (value) => {
    if (reminderMode === 'custom') {
      const currentMinutes = Number(form.reminderMinutes);
      if (Number.isInteger(currentMinutes) && currentMinutes >= 1 && currentMinutes <= 10080) {
        setCustomReminderMinutes(currentMinutes);
      }
    }
    setReminderMode(value);
    set('reminderMinutes', value === 'custom' ? customReminderMinutes : Number(value));
  };
  const changeCustomReminder = (value) => {
    const minutes = value === '' ? '' : Number(value);
    setCustomReminderMinutes(minutes);
    set('reminderMinutes', minutes);
  };
  const changeRecoveryMode = (value) => {
    setRecoveryMode(value);
    set('recoveryConfirmations', value === 'custom' ? customRecoveryConfirmations : Number(value));
  };
  const changeCustomRecovery = (value) => {
    const confirmations = value === '' ? '' : Number(value);
    setCustomRecoveryConfirmations(confirmations);
    set('recoveryConfirmations', confirmations);
  };
  const changeDepletionMode = (value) => {
    setDepletionMode(value);
    set('depletionAlertDays', value === 'custom' ? Math.min(90, Math.max(1, Number(form.depletionAlertDays) || 7)) : Number(value));
  };

  const save = async (event) => {
    event.preventDefault();
    if (!Number.isInteger(form.recoveryConfirmations) || form.recoveryConfirmations < 1 || form.recoveryConfirmations > 100) {
      pushToast('恢复确认次数请输入 1–100 之间的整数', 'error');
      return;
    }
    setBusy('save');
    try {
      const result = await api.saveSettings(form);
      onSaved(result.settings);
      pushToast('通知链路与恢复策略已保存', 'success');
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally { setBusy(''); }
  };

  const test = async (channel) => {
    setBusy(channel);
    try {
      const response = await api.testNotification(channel, form);
      setTests((current) => ({ ...current, [channel]: response.result }));
      const tone = notificationTone(response.result);
      pushToast(notificationText(response.result, channel), tone === 'success' ? 'success' : 'error');
    } catch (error) {
      pushToast(error.message, 'error');
    } finally { setBusy(''); }
  };

  return (
    <Modal open={open} onClose={onClose} dismissible={!busy} title="系统设置" subtitle="通知、安全与代理出口。" width={820}>
      <div className="settings-tabs"><button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}><EnvelopeSimple size={16} /> 通知与结单</button><button className={tab === 'proxy' ? 'active' : ''} onClick={() => setTab('proxy')}><GlobeHemisphereWest size={16} /> 代理池{(proxyReady || proxyNeedsAttention) && <i className={proxyNeedsAttention ? 'attention' : ''} />}</button><button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}><ShieldCheck size={16} /> 账户安全{session?.twoFactorEnabled && <i />}</button></div>
      {tab === 'notifications' ? (
      <form className="settings-form" onSubmit={save}>
        {onboarding && <SetupStepNote step={4}>选择至少一个渠道，填写接收信息并启用。你可以手动发送测试消息；最后点击保存，才会用于后续告警。</SetupStepNote>}
        <section className="notification-section">
          <header>
            <EnvelopeSimple size={21} />
            <div><h3>Resend 邮件链路</h3><p>低余额告警、未恢复提醒、恢复结单邮件。</p></div>
            <div className="channel-header-actions"><ChannelState enabled={form.resendEnabled} {...resendState} /><label className="switch"><input aria-label="启用 Resend 邮件通知" type="checkbox" checked={Boolean(form.resendEnabled)} onChange={(event) => set('resendEnabled', event.target.checked)} /><span /></label></div>
          </header>
          <div className="form-grid two"><label><span>发件人</span><input value={form.resendFrom || ''} onChange={(event) => set('resendFrom', event.target.value)} placeholder="告警中心 <alerts@你的域名>" /></label><label><span>收件人</span><input value={form.resendTo || ''} onChange={(event) => set('resendTo', event.target.value)} placeholder="多个邮箱用逗号分隔" /></label></div>
          <label><span>Resend API Key</span><input type="password" value={form.resendApiKey || ''} onChange={(event) => set('resendApiKey', event.target.value)} placeholder={form.hasResendApiKey ? '已配置，留空保持不变' : 're_...'} /></label>
          <div className="channel-test-row"><span>测试使用当前输入，不会自动保存。</span><button type="button" className="secondary-button" onClick={() => test('resend')} disabled={Boolean(busy)}>{busy === 'resend' ? <SpinnerGap className="spin" /> : <Flask size={15} />} 测试 Resend</button></div>
          <TestResult result={tests.resend} channel="resend" />
        </section>

        <section className="notification-section">
          <header>
            <PaperPlaneTilt size={21} />
            <div><h3>飞书机器人链路</h3><p>机器人明确返回成功码后，才记为已确认。</p></div>
            <div className="channel-header-actions"><ChannelState enabled={form.feishuEnabled} {...feishuState} /><label className="switch"><input aria-label="启用飞书通知" type="checkbox" checked={Boolean(form.feishuEnabled)} onChange={(event) => set('feishuEnabled', event.target.checked)} /><span /></label></div>
          </header>
          <label><span>群机器人 Webhook</span><input type="password" value={form.feishuWebhook || ''} onChange={(event) => set('feishuWebhook', event.target.value)} placeholder={form.hasFeishuWebhook ? '已配置，留空保持不变' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} /></label>
          <div className="channel-test-row"><span>测试使用当前输入，不会自动保存。</span><button type="button" className="secondary-button" onClick={() => test('feishu')} disabled={Boolean(busy)}>{busy === 'feishu' ? <SpinnerGap className="spin" /> : <Flask size={15} />} 测试飞书</button></div>
          <TestResult result={tests.feishu} channel="feishu" />
        </section>

        <section className="notification-section">
          <header>
            <TelegramLogo size={21} />
            <div><h3>Telegram 机器人链路</h3><p>通过 Bot API 推送到私聊、群组或频道。</p></div>
            <div className="channel-header-actions"><ChannelState enabled={form.telegramEnabled} {...telegramState} /><label className="switch"><input aria-label="启用 Telegram 通知" type="checkbox" checked={Boolean(form.telegramEnabled)} onChange={(event) => set('telegramEnabled', event.target.checked)} /><span /></label></div>
          </header>
          <div className="form-grid two"><label><span>Chat ID</span><input value={form.telegramChatId || ''} onChange={(event) => set('telegramChatId', event.target.value)} placeholder="个人数字 ID、-100 群组 ID 或 @频道名" /></label><label><span>Bot Token</span><input type="password" value={form.telegramBotToken || ''} onChange={(event) => set('telegramBotToken', event.target.value)} placeholder={form.hasTelegramBotToken ? '已配置，留空保持不变' : '123456789:AAF...'} /></label></div>
          <div className="channel-test-row"><span>测试使用当前输入，不会自动保存。</span><button type="button" className="secondary-button" onClick={() => test('telegram')} disabled={Boolean(busy)}>{busy === 'telegram' ? <SpinnerGap className="spin" /> : <Flask size={15} />} 测试 Telegram</button></div>
          <TestResult result={tests.telegram} channel="telegram" />
        </section>

        <section className="notification-section">
          <header>
            <WechatLogo size={21} />
            <div><h3>企业微信机器人链路</h3><p>群机器人 Markdown 消息推送到企业微信群。</p></div>
            <div className="channel-header-actions"><ChannelState enabled={form.wecomEnabled} {...wecomState} /><label className="switch"><input aria-label="启用企业微信通知" type="checkbox" checked={Boolean(form.wecomEnabled)} onChange={(event) => set('wecomEnabled', event.target.checked)} /><span /></label></div>
          </header>
          <label><span>群机器人 Webhook</span><input type="password" value={form.wecomWebhook || ''} onChange={(event) => set('wecomWebhook', event.target.value)} placeholder={form.hasWecomWebhook ? '已配置，留空保持不变' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'} /></label>
          <div className="channel-test-row"><span>测试使用当前输入，不会自动保存。</span><button type="button" className="secondary-button" onClick={() => test('wecom')} disabled={Boolean(busy)}>{busy === 'wecom' ? <SpinnerGap className="spin" /> : <Flask size={15} />} 测试企业微信</button></div>
          <TestResult result={tests.wecom} channel="wecom" />
        </section>

        <section className="notification-section compact">
          <header><CheckCircle size={21} /><div><h3>提醒与恢复闭环</h3><p id="recovery-confirmations-help">余额连续达到恢复阈值指定次数后才结单；余额回落或检测失败会重新计数。</p></div></header>
          <div className="form-grid two">
            <div className="reminder-field">
              <span className="field-label">恢复确认次数</span>
              <div className={`reminder-interval-control ${recoveryMode === 'custom' ? 'custom' : ''}`}>
                <select aria-label="恢复确认次数" aria-describedby="recovery-confirmations-help" value={recoveryMode} onChange={(event) => changeRecoveryMode(event.target.value)}>
                  <option value="1">连续 1 次</option>
                  <option value="2">连续 2 次</option>
                  <option value="3">连续 3 次</option>
                  <option value="custom">自定义次数</option>
                </select>
                {recoveryMode === 'custom' && <div className="reminder-custom-input"><input aria-label="自定义恢复确认次数（次）" aria-describedby="recovery-confirmations-help" type="number" min="1" max="100" step="1" required placeholder="1–100" value={form.recoveryConfirmations ?? ''} onChange={(event) => changeCustomRecovery(event.target.value)} /><span aria-hidden="true">次</span></div>}
              </div>
            </div>
            <div className="reminder-field"><span className="field-label">未恢复重复提醒</span><div className={`reminder-interval-control ${reminderMode === 'custom' ? 'custom' : ''}`}><select aria-label="未恢复重复提醒周期" value={reminderMode} onChange={(event) => changeReminderMode(event.target.value)}><option value="180">每 3 小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每 24 小时</option><option value="custom">自定义分钟</option></select>{reminderMode === 'custom' && <div className="reminder-custom-input"><input aria-label="自定义提醒周期，单位分钟，范围 1 到 10080" type="number" min="1" max="10080" step="1" required value={form.reminderMinutes ?? ''} onChange={(event) => changeCustomReminder(event.target.value)} /><span aria-hidden="true">分钟</span></div>}</div></div>
            <div className="reminder-field">
              <span className="field-label">余额耗尽预警</span>
              <div className={`reminder-interval-control ${depletionMode === 'custom' ? 'custom' : ''}`}>
                <select aria-label="余额耗尽预警天数" value={depletionMode} onChange={(event) => changeDepletionMode(event.target.value)}>
                  <option value="0">关闭</option>
                  <option value="3">预计 3 天内耗尽时提醒</option>
                  <option value="7">预计 7 天内耗尽时提醒</option>
                  <option value="14">预计 14 天内耗尽时提醒</option>
                  <option value="custom">自定义天数</option>
                </select>
                {depletionMode === 'custom' && <div className="reminder-custom-input"><input aria-label="自定义耗尽预警天数，范围 1 到 90" type="number" min="1" max="90" step="1" required value={form.depletionAlertDays ?? ''} onChange={(event) => set('depletionAlertDays', Math.min(90, Math.max(1, Number(event.target.value) || 1)))} /><span aria-hidden="true">天</span></div>}
              </div>
            </div>
          </div>
          <div className="closure-flow"><span>低于阈值</span><i>→</i><span>已启用渠道提醒</span><i>→</i><span>手动充值</span><i>→</i><span>连续检测恢复</span><i>→</i><span>恢复通知并结单</span></div>
        </section>
        <footer className="modal-actions"><span className="settings-save-note">启用渠道前建议先完成单独测试。</span><div><button type="button" className="ghost-button" disabled={Boolean(busy)} onClick={onClose}>取消</button><button className="primary-button" disabled={Boolean(busy)}>{busy === 'save' && <SpinnerGap className="spin" />} 保存设置</button></div></footer>
      </form>
      ) : tab === 'proxy' ? <ProxyPoolPanel initialPool={proxyPool} onChanged={onProxyPoolChanged} pushToast={pushToast} /> : <SecurityPanel onClose={onClose} onSessionChanged={onSessionChanged} pushToast={pushToast} />}
    </Modal>
  );
}
