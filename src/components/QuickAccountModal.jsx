import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CheckCircle, Flask, Key, SignIn, SpinnerGap, SlidersHorizontal, UploadSimple, X } from '@phosphor-icons/react';
import { api } from '../api.js';
import { money } from '../lib.js';
import { applySub2ApiSession, buildQuickAccountPayload, parseSub2ApiSession } from '../quick-account.js';
import { Modal } from './Modal.jsx';

function defaults(upstreamName = '') {
  return {
    upstreamName,
    name: '',
    type: 'newapi',
    baseUrl: '',
    userId: '',
    token: '',
    sub2AuthMode: 'api_token',
    browserLogin: null,
    importedSession: null,
  };
}

export function QuickAccountModal({ open, upstreams, defaultUpstreamId, browserWorkspaceUrl = '', onClose, onSaved, onAdvanced, pushToast }) {
  const [form, setForm] = useState(defaults());
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [importError, setImportError] = useState('');
  const sessionFileInputId = useId();
  const sessionFileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const defaultUpstream = upstreams.find((upstream) => upstream.id === defaultUpstreamId) || upstreams[0];
    setForm(defaults(defaultUpstream?.name || ''));
    setPreview(null);
    setBusy('');
    setImportError('');
  }, [open, defaultUpstreamId]);

  useEffect(() => {
    const job = form.browserLogin;
    if (!open || !job?.id || ['captured', 'failed', 'closed', 'expired', 'cancelled', 'consumed'].includes(job.status)) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.upstreamLogin(job.id);
        if (!cancelled) setForm((current) => (
          current.browserLogin?.id === job.id ? { ...current, browserLogin: next } : current
        ));
      } catch (error) {
        if (!cancelled) setForm((current) => (
          current.browserLogin?.id === job.id
            ? { ...current, browserLogin: { ...current.browserLogin, status: 'failed', error: error.message } }
            : current
        ));
      }
    };
    const timer = window.setInterval(poll, 900);
    poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, form.browserLogin?.id, form.browserLogin?.status]);

  const payload = useMemo(() => buildQuickAccountPayload(form), [form]);
  const set = (key, value) => {
    setPreview(null);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const changeType = (type) => {
    if (form.browserLogin?.id) api.cancelUpstreamLogin(form.browserLogin.id).catch(() => {});
    setPreview(null);
    setImportError('');
    setForm((current) => ({
      ...current,
      type,
      sub2AuthMode: type === 'sub2api' ? current.sub2AuthMode : 'api_token',
      browserLogin: type === 'sub2api' ? current.browserLogin : null,
      importedSession: type === 'sub2api' ? current.importedSession : null,
    }));
  };

  const importSessionFile = async (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const session = parseSub2ApiSession(await file.text());
      if (form.browserLogin?.id) api.cancelUpstreamLogin(form.browserLogin.id).catch(() => {});
      setPreview(null);
      setImportError('');
      setForm((current) => applySub2ApiSession(current, session, file.name));
    } catch (error) {
      const message = `${file.name}：${error.message}`;
      setImportError(message);
    } finally {
      input.value = '';
    }
  };

  const clearSessionFile = () => {
    setPreview(null);
    setImportError('');
    setForm((current) => ({ ...current, importedSession: null, sub2AuthMode: 'api_token' }));
    if (sessionFileInputRef.current) sessionFileInputRef.current.value = '';
  };

  const cancelBrowserLogin = async () => {
    const id = form.browserLogin?.id;
    if (id) await api.cancelUpstreamLogin(id).catch(() => {});
    setPreview(null);
    setForm((current) => ({ ...current, browserLogin: null, sub2AuthMode: 'api_token' }));
  };

  const startBrowserLogin = async () => {
    let baseUrl;
    try {
      baseUrl = new URL(form.baseUrl.trim()).origin;
    } catch {
      pushToast('请先填写有效的 Sub2API 上游地址', 'error');
      return;
    }
    if (form.browserLogin?.id) await api.cancelUpstreamLogin(form.browserLogin.id).catch(() => {});
    setBusy('browser');
    setPreview(null);
    setImportError('');
    if (sessionFileInputRef.current) sessionFileInputRef.current.value = '';
    try {
      const request = api.startUpstreamLogin({ type: 'sub2api', baseUrl });
      if (browserWorkspaceUrl) {
        window.open(browserWorkspaceUrl, 'frosted-upstream-browser', 'noopener,noreferrer');
      }
      const job = await request;
      setForm((current) => ({
        ...current,
        baseUrl,
        importedSession: null,
        sub2AuthMode: 'browser',
        browserLogin: job,
      }));
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const importedTokenStatus = form.importedSession
    ? form.importedSession.accessToken && form.importedSession.refreshToken
      ? '已读取 Access Token + Refresh Token'
      : form.importedSession.accessToken
        ? '已读取 Access Token'
        : '已读取 Refresh Token，将尝试续期 Access Token'
    : '自动填写上游地址，并使用文件中的 AT / RT';

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
    apiTokenPoolText: form.type === 'sub2api' && form.sub2AuthMode === 'api_token' && !form.importedSession ? form.token : '',
  });

  const usingSub2BrowserLogin = form.type === 'sub2api' && form.sub2AuthMode === 'browser' && !form.importedSession;
  const usingSub2Session = form.type === 'sub2api' && Boolean(form.importedSession);
  const browserLoginCaptured = usingSub2BrowserLogin && form.browserLogin?.status === 'captured';
  const browserLoginWaiting = usingSub2BrowserLogin && ['opening', 'waiting'].includes(form.browserLogin?.status);

  const closeModal = () => {
    if (form.browserLogin?.id) api.cancelUpstreamLogin(form.browserLogin.id).catch(() => {});
    onClose();
  };

  return (
    <Modal open={open} title="添加监控账号" subtitle="默认使用上游官方令牌，无需账号密码" onClose={closeModal} width={620}>
      <form className="modal-body quick-account-form" onSubmit={submit}>
        <div className="quick-type-switch" role="group" aria-label="上游类型">
          <button type="button" className={form.type === 'newapi' ? 'active' : ''} onClick={() => changeType('newapi')}>New API</button>
          <button type="button" className={form.type === 'sub2api' ? 'active' : ''} onClick={() => changeType('sub2api')}>Sub2API</button>
        </div>

        <div className="form-grid two">
          <label><span>所属上游</span><input required value={form.upstreamName} onChange={(event) => set('upstreamName', event.target.value)} placeholder="例如 newapi、sub2api" /></label>
          <label><span>账号名称</span><input required value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="例如：主账号" /></label>
        </div>
        <label><span>上游地址</span><input required type="url" value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder={form.type === 'newapi' ? 'https://newapi.example.com' : 'https://sub2.example.com'} /></label>
        {form.type === 'newapi' && <label><span>User ID</span><input required value={form.userId} onChange={(event) => set('userId', event.target.value)} placeholder="个人资料中的数字 ID" /></label>}
        <label>
          <span>{form.type === 'newapi' ? '账户访问令牌' : 'API 令牌'}</span>
          <div className="input-with-icon"><Key size={18} /><input required={form.type === 'newapi' || (form.type === 'sub2api' && !usingSub2Session && !usingSub2BrowserLogin)} disabled={usingSub2Session || usingSub2BrowserLogin} type="password" autoComplete="off" value={form.token} onChange={(event) => set('token', event.target.value)} placeholder={form.type === 'newapi' ? '个人资料中生成的访问令牌' : usingSub2Session ? '已改用导入的登录态' : usingSub2BrowserLogin ? '已改用内置浏览器登录' : 'sk-...'} /></div>
          <small>{form.type === 'newapi' ? '读取账户总余额；令牌会加密保存。' : usingSub2Session ? '登录态令牌会加密保存，并在需要时自动续期。' : usingSub2BrowserLogin ? '登录成功后优先保存 AT / RT；没有令牌时保留浏览器 CK。' : '通过官方 /v1/usage 读取该 Key 的余额与倍率。'}</small>
        </label>

        {form.type === 'sub2api' && <div className="quick-session-import-field">
          <input
            ref={sessionFileInputRef}
            id={sessionFileInputId}
            className="quick-session-file-input"
            type="file"
            accept=".json,application/json"
            tabIndex={-1}
            aria-describedby={`${sessionFileInputId}-status${importError ? ` ${sessionFileInputId}-error` : ''}`}
            onChange={importSessionFile}
          />
          <div className={`quick-session-import${form.importedSession ? ' imported' : ''}`} aria-live="polite">
            <label
              className="quick-session-file-label"
              htmlFor={sessionFileInputId}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  sessionFileInputRef.current?.click();
                }
              }}
            >
              {form.importedSession ? <CheckCircle size={20} weight="fill" aria-hidden="true" /> : <UploadSimple size={20} aria-hidden="true" />}
              <div className="quick-session-file-copy">
                <strong title={form.importedSession?.fileName || ''}>{form.importedSession?.fileName || '导入登录态 JSON'}</strong>
                <small id={`${sessionFileInputId}-status`}>{importedTokenStatus}</small>
              </div>
              <em className="quick-session-file-action">{form.importedSession ? '重新导入' : '选择文件'}</em>
            </label>
            {form.importedSession && <button type="button" className="quick-session-clear" onClick={clearSessionFile} aria-label="清除已导入的登录态文件" title="清除导入"><X size={17} /></button>}
          </div>
          {importError && <p id={`${sessionFileInputId}-error`} className="quick-session-import-error" role="alert">{importError}</p>}
        </div>}

        {form.type === 'sub2api' && <div className={`quick-browser-login${usingSub2BrowserLogin ? ' active' : ''}`}>
          <button type="button" className="quick-direct-login" onClick={startBrowserLogin} disabled={busy === 'browser' || browserLoginWaiting || browserLoginCaptured}>
            {browserLoginCaptured ? <CheckCircle size={20} weight="fill" /> : busy === 'browser' || browserLoginWaiting ? <SpinnerGap className="spin" size={20} /> : <SignIn size={20} />}
            <span>
              <strong>{browserLoginCaptured ? (form.browserLogin.captureMode === 'tokens' ? '已取得浏览器 AT / RT' : '已取得浏览器 CK') : browserLoginWaiting ? '等待你在内置浏览器完成登录' : '打开内置浏览器登录'}</strong>
              <small>{form.browserLogin?.error || form.browserLogin?.message || (browserWorkspaceUrl ? '在服务器有头浏览器中完成 CF 与账号登录' : '弹出独立 Chromium 窗口，正常完成 CF 与账号登录')}</small>
            </span>
            <em>{browserLoginCaptured ? '已就绪' : browserLoginWaiting ? '等待中' : form.browserLogin ? '重试' : '打开'}</em>
          </button>
          {usingSub2BrowserLogin && <button type="button" className="quick-browser-login-clear" onClick={cancelBrowserLogin} aria-label="取消内置浏览器登录" title="取消登录"><X size={17} /></button>}
        </div>}

        <div className="quick-defaults"><span>默认配置</span><strong>低于 ¥10 报警 · 5 分钟检测 · Resend 与飞书通知</strong></div>
        {preview && <div className="quick-preview"><span>连接正常</span><strong>{money(preview.convertedCny)}</strong></div>}

        <div className="modal-actions quick-actions">
          <button type="button" className="advanced-command" onClick={() => onAdvanced(advancedDraft())}><SlidersHorizontal size={17} />高级设置</button>
          <span />
          <button type="button" className="secondary-button" disabled={Boolean(busy) || (usingSub2BrowserLogin && !browserLoginCaptured)} onClick={testConnection}>{busy === 'test' ? <SpinnerGap className="spin" /> : <Flask size={17} />}测试连接</button>
          <button type="submit" className="primary-button" disabled={Boolean(busy) || (usingSub2BrowserLogin && !browserLoginCaptured)}>{busy === 'save' && <SpinnerGap className="spin" />}{usingSub2BrowserLogin ? '使用登录态添加' : '添加账号'}</button>
        </div>
      </form>
    </Modal>
  );
}
