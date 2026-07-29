import { useEffect, useMemo, useState } from 'react';
import { Flask, Key, SpinnerGap, SlidersHorizontal } from '@phosphor-icons/react';
import { api } from '../api.js';
import { money } from '../lib.js';
import { Modal } from './Modal.jsx';

function defaults(upstreamName = '') {
  return {
    upstreamName,
    name: '',
    type: 'newapi',
    baseUrl: '',
    userId: '',
    token: '',
  };
}

function buildPayload(form) {
  const isSub2 = form.type === 'sub2api';
  const credentials = isSub2
    ? { apiToken: form.token.trim(), apiTokens: [form.token.trim()] }
    : { accessToken: form.token.trim() };
  return {
    upstreamId: '',
    upstreamName: form.upstreamName.trim(),
    name: form.name.trim(),
    type: form.type,
    baseUrl: form.baseUrl.trim().replace(/\/$/, ''),
    region: '默认分组',
    subgroup: isSub2 ? 'Sub2API' : 'New API',
    authMode: isSub2 ? 'api_token' : 'access_token',
    tokenStrategy: 'sticky',
    userId: isSub2 ? '' : form.userId.trim(),
    profilePath: isSub2 ? '/v1/usage' : '/api/user/self',
    balancePath: isSub2 ? 'remaining' : 'data.quota',
    formula: isSub2 ? 'x * 7.2' : 'x / 500000 * 1',
    rawUnit: isSub2 ? 'USD' : 'quota',
    thresholdLow: 10,
    thresholdRecover: 15,
    pollIntervalMinutes: 5,
    enabled: true,
    notifications: { resend: true, feishu: true },
    credentials,
  };
}

export function QuickAccountModal({ open, upstreams, defaultUpstreamId, onClose, onSaved, onAdvanced, pushToast }) {
  const [form, setForm] = useState(defaults());
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (!open) return;
    const defaultUpstream = upstreams.find((upstream) => upstream.id === defaultUpstreamId) || upstreams[0];
    setForm(defaults(defaultUpstream?.name || ''));
    setPreview(null);
    setBusy('');
  }, [open, defaultUpstreamId]);

  const payload = useMemo(() => buildPayload(form), [form]);
  const set = (key, value) => {
    setPreview(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const testConnection = async () => {
    setBusy('test');
    try {
      const result = await api.testAccount(payload);
      setPreview(result);
      pushToast(`连接成功，人民币余额 ${money(result.convertedCny)}`, 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy('save');
    try {
      const result = await api.createAccount(payload);
      if (result.syncError) pushToast(`账号已保存，首次同步待重试：${result.syncError}`, 'warning');
      else pushToast('账号已添加并开始监控', 'success');
      await onSaved(result.account);
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const advancedDraft = () => ({
    ...payload,
    apiTokenPoolText: form.type === 'sub2api' ? form.token : '',
  });

  return (
    <Modal open={open} title="添加监控账号" subtitle="默认使用上游官方令牌，无需账号密码" onClose={onClose} width={620}>
      <form className="modal-body quick-account-form" onSubmit={submit}>
        <div className="quick-type-switch" role="group" aria-label="上游类型">
          <button type="button" className={form.type === 'newapi' ? 'active' : ''} onClick={() => set('type', 'newapi')}>New API</button>
          <button type="button" className={form.type === 'sub2api' ? 'active' : ''} onClick={() => set('type', 'sub2api')}>Sub2API</button>
        </div>

        <div className="form-grid two">
          <label><span>所属上游</span><input required value={form.upstreamName} onChange={(event) => set('upstreamName', event.target.value)} placeholder="例如：86 或 NewCLI" /></label>
          <label><span>账号名称</span><input required value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="例如：主账号" /></label>
        </div>
        <label><span>上游地址</span><input required type="url" value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder={form.type === 'newapi' ? 'https://newapi.example.com' : 'https://sub2.example.com'} /></label>
        {form.type === 'newapi' && <label><span>User ID</span><input required value={form.userId} onChange={(event) => set('userId', event.target.value)} placeholder="个人资料中的数字 ID" /></label>}
        <label>
          <span>{form.type === 'newapi' ? '账户访问令牌' : 'API 令牌'}</span>
          <div className="input-with-icon"><Key size={18} /><input required type="password" autoComplete="off" value={form.token} onChange={(event) => set('token', event.target.value)} placeholder={form.type === 'newapi' ? '个人资料中生成的访问令牌' : 'sk-...'} /></div>
          <small>{form.type === 'newapi' ? '读取账户总余额；令牌会加密保存。' : '通过官方 /v1/usage 读取该 Key 的余额与倍率。'}</small>
        </label>

        <div className="quick-defaults"><span>默认配置</span><strong>低于 ¥10 报警 · 5 分钟检测 · Resend 与飞书通知</strong></div>
        {preview && <div className="quick-preview"><span>连接正常</span><strong>{money(preview.convertedCny)}</strong></div>}

        <div className="modal-actions quick-actions">
          <button type="button" className="advanced-command" onClick={() => onAdvanced(advancedDraft())}><SlidersHorizontal size={17} />高级设置</button>
          <span />
          <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={testConnection}>{busy === 'test' ? <SpinnerGap className="spin" /> : <Flask size={17} />}测试连接</button>
          <button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === 'save' && <SpinnerGap className="spin" />}添加账号</button>
        </div>
      </form>
    </Modal>
  );
}
