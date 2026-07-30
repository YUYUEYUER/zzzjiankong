import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, EnvelopeSimple, Flask, GlobeHemisphereWest, PaperPlaneTilt, ShieldCheck, SpinnerGap, WarningCircle } from '@phosphor-icons/react';
import { api } from '../api.js';
import { notificationText, notificationTone } from '../notification-state.js';
import { Modal } from './Modal.jsx';
import { SecurityPanel } from './SecurityPanel.jsx';
import { ProxyPoolPanel } from './ProxyPoolPanel.jsx';

const DEFAULT_REMINDER_MINUTES = 360;
const REMINDER_PRESETS = [180, 360, 720, 1440];

function readiness(channel, form) {
  if (channel === 'resend') {
    const missing = [
      !(form.resendApiKey || form.hasResendApiKey) && 'API Key',
      !form.resendFrom?.trim() && '发件人',
      !form.resendTo?.trim() && '收件人',
    ].filter(Boolean);
    return { ready: missing.length === 0, missing };
  }
  const ready = Boolean(form.feishuWebhook || form.hasFeishuWebhook);
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

export function SettingsModal({ open, settings, proxyPool, initialTab = 'notifications', session, onSessionChanged, onClose, onSaved, onProxyPoolChanged, pushToast }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState('');
  const [tests, setTests] = useState({});
  const [tab, setTab] = useState('notifications');
  const [reminderMode, setReminderMode] = useState('360');
  const [customReminderMinutes, setCustomReminderMinutes] = useState(DEFAULT_REMINDER_MINUTES);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      const reminderMinutes = Number(settings?.reminderMinutes) || DEFAULT_REMINDER_MINUTES;
      setForm({ ...settings, reminderMinutes, resendApiKey: '', feishuWebhook: '' });
      setReminderMode(REMINDER_PRESETS.includes(reminderMinutes) ? String(reminderMinutes) : 'custom');
      setCustomReminderMinutes(reminderMinutes);
      setTests({});
    }
    wasOpen.current = open;
  }, [open, settings]);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const resendState = useMemo(() => readiness('resend', form), [form]);
  const feishuState = useMemo(() => readiness('feishu', form), [form]);
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

  const save = async (event) => {
    event.preventDefault();
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
    <Modal open={open} onClose={onClose} title="系统设置" subtitle="通知、安全与代理出口。" width={820}>
      <div className="settings-tabs"><button className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')}><EnvelopeSimple size={16} /> 通知与结单</button><button className={tab === 'proxy' ? 'active' : ''} onClick={() => setTab('proxy')}><GlobeHemisphereWest size={16} /> 代理池{proxyPool?.summary?.available > 0 && <i />}</button><button className={tab === 'security' ? 'active' : ''} onClick={() => setTab('security')}><ShieldCheck size={16} /> 账户安全{session?.twoFactorEnabled && <i />}</button></div>
      {tab === 'notifications' ? (
      <form className="settings-form" onSubmit={save}>
        <section className="notification-section">
          <header>
            <EnvelopeSimple size={21} />
            <div><h3>Resend 邮件链路</h3><p>低余额告警、未恢复提醒、恢复结单邮件。</p></div>
            <div className="channel-header-actions"><ChannelState enabled={form.resendEnabled} {...resendState} /><label className="switch"><input type="checkbox" checked={Boolean(form.resendEnabled)} onChange={(event) => set('resendEnabled', event.target.checked)} /><span /></label></div>
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
            <div className="channel-header-actions"><ChannelState enabled={form.feishuEnabled} {...feishuState} /><label className="switch"><input type="checkbox" checked={Boolean(form.feishuEnabled)} onChange={(event) => set('feishuEnabled', event.target.checked)} /><span /></label></div>
          </header>
          <label><span>群机器人 Webhook</span><input type="password" value={form.feishuWebhook || ''} onChange={(event) => set('feishuWebhook', event.target.value)} placeholder={form.hasFeishuWebhook ? '已配置，留空保持不变' : 'https://open.feishu.cn/open-apis/bot/v2/hook/...'} /></label>
          <div className="channel-test-row"><span>测试使用当前输入，不会自动保存。</span><button type="button" className="secondary-button" onClick={() => test('feishu')} disabled={Boolean(busy)}>{busy === 'feishu' ? <SpinnerGap className="spin" /> : <Flask size={15} />} 测试飞书</button></div>
          <TestResult result={tests.feishu} channel="feishu" />
        </section>

        <section className="notification-section compact">
          <header><CheckCircle size={21} /><div><h3>提醒与恢复闭环</h3><p>低余额持续未恢复会节流提醒；充值后连续检测达标再自动结单。</p></div></header>
          <div className="form-grid two"><label><span>恢复确认次数</span><select value={form.recoveryConfirmations || 2} onChange={(event) => set('recoveryConfirmations', Number(event.target.value))}><option value="1">连续 1 次</option><option value="2">连续 2 次</option><option value="3">连续 3 次</option></select></label><div className="reminder-field"><span className="field-label">未恢复重复提醒</span><div className={`reminder-interval-control ${reminderMode === 'custom' ? 'custom' : ''}`}><select aria-label="未恢复重复提醒周期" value={reminderMode} onChange={(event) => changeReminderMode(event.target.value)}><option value="180">每 3 小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每 24 小时</option><option value="custom">自定义分钟</option></select>{reminderMode === 'custom' && <div className="reminder-custom-input"><input aria-label="自定义提醒周期，单位分钟，范围 1 到 10080" type="number" min="1" max="10080" step="1" required value={form.reminderMinutes ?? ''} onChange={(event) => changeCustomReminder(event.target.value)} /><span aria-hidden="true">分钟</span></div>}</div></div></div>
          <div className="closure-flow"><span>低于阈值</span><i>→</i><span>双渠道告警</span><i>→</i><span>手动充值</span><i>→</i><span>连续检测恢复</span><i>→</i><span>恢复通知并结单</span></div>
        </section>
        <footer className="modal-actions"><span className="settings-save-note">启用渠道前建议先完成单独测试。</span><div><button type="button" className="ghost-button" onClick={onClose}>取消</button><button className="primary-button" disabled={Boolean(busy)}>{busy === 'save' && <SpinnerGap className="spin" />} 保存设置</button></div></footer>
      </form>
      ) : tab === 'proxy' ? <ProxyPoolPanel initialPool={proxyPool} onChanged={onProxyPoolChanged} pushToast={pushToast} /> : <SecurityPanel onClose={onClose} onSessionChanged={onSessionChanged} pushToast={pushToast} />}
    </Modal>
  );
}
