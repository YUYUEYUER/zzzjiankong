import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, Eye, EyeSlash, Flask, Info, SpinnerGap } from '@phosphor-icons/react';
import { api } from '../api.js';
import { money } from '../lib.js';
import { Modal } from './Modal.jsx';

const SUB2_AUTH_DEFAULTS = {
  api_token: { profilePath: '/v1/usage', balancePath: 'remaining', rawUnit: 'USD', formula: 'x * 7.2' },
  access_token: { profilePath: '/api/v1/auth/me', balancePath: 'data.balance', rawUnit: 'CNY', formula: 'x' },
  password: { profilePath: '/api/v1/auth/me', balancePath: 'data.balance', rawUnit: 'CNY', formula: 'x' },
};

function defaults(type = 'newapi', upstreamId = '', upstreamName = '') {
  const sub2Defaults = SUB2_AUTH_DEFAULTS.api_token;
  return {
    upstreamId, upstreamName, name: '', type, baseUrl: '', region: '未分组', subgroup: '', authMode: type === 'sub2api' ? 'api_token' : 'access_token', username: '', userId: '',
    tokenStrategy: 'sticky', apiTokenPoolText: '',
    profilePath: type === 'sub2api' ? sub2Defaults.profilePath : '/api/user/self',
    balancePath: type === 'sub2api' ? sub2Defaults.balancePath : 'data.quota',
    formula: type === 'sub2api' ? sub2Defaults.formula : type === 'newapi' ? 'x / 500000 * 1' : 'x',
    rawUnit: type === 'sub2api' ? sub2Defaults.rawUnit : type === 'newapi' ? 'quota' : 'CNY',
    turnstileSiteKey: '',
    thresholdLow: 10, thresholdRecover: 15, pollIntervalMinutes: 5, enabled: true,
    notifications: { resend: true, feishu: true },
    credentials: {
      apiToken: '', accessToken: '', refreshToken: '', password: '', turnstileToken: '',
      cfAccessClientId: '', cfAccessClientSecret: '',
    },
  };
}

export function AccountModal({ open, editingAccount, initialDraft, upstreams, defaultUpstreamId, onClose, onSaved, pushToast, turnstileSolver }) {
  const [form, setForm] = useState(defaults());
  const [showSecret, setShowSecret] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (editingAccount) {
      const authMode = editingAccount.authMode || 'access_token';
      const editingDefaults = editingAccount.type === 'sub2api'
        ? { ...defaults(editingAccount.type), ...SUB2_AUTH_DEFAULTS[authMode] }
        : defaults(editingAccount.type);
      setForm({
        ...editingDefaults,
        ...editingAccount,
        upstreamName: upstreams.find((upstream) => upstream.id === editingAccount.upstreamId)?.name || '',
        authMode,
        credentials: {
          apiToken: '', accessToken: '', refreshToken: '', password: '', turnstileToken: '',
          cfAccessClientId: '', cfAccessClientSecret: '',
        },
      });
    } else if (initialDraft) {
      const initialUpstreamId = initialDraft.upstreamId || defaultUpstreamId || upstreams[0]?.id || '';
      const initialUpstreamName = initialDraft.upstreamName
        || upstreams.find((upstream) => upstream.id === initialUpstreamId)?.name
        || '';
      const base = defaults(initialDraft.type || 'newapi', initialUpstreamId, initialUpstreamName);
      setForm({
        ...base,
        ...initialDraft,
        credentials: { ...base.credentials, ...(initialDraft.credentials || {}) },
      });
    } else {
      const initialUpstreamId = defaultUpstreamId || upstreams[0]?.id || '';
      setForm(defaults('newapi', initialUpstreamId, upstreams.find((upstream) => upstream.id === initialUpstreamId)?.name || ''));
    }
    setPreview(null);
    setAdvanced(false);
  }, [open, editingAccount, initialDraft, defaultUpstreamId]);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const setCredential = (key, value) => setForm((current) => ({ ...current, credentials: { ...current.credentials, [key]: value } }));

  const payload = useMemo(() => {
    const commonCredentialKeys = ['cfAccessClientId', 'cfAccessClientSecret'];
    const credentialKeys = form.authMode === 'api_token'
      ? [form.type === 'newapi' ? 'accessToken' : null, ...commonCredentialKeys].filter(Boolean)
      : form.type === 'sub2api'
        ? ['accessToken', 'refreshToken', 'password', 'turnstileToken', ...commonCredentialKeys]
        : form.authMode === 'password'
          ? [form.type === 'newapi' ? 'accessToken' : null, 'password', ...commonCredentialKeys].filter(Boolean)
          : ['accessToken', ...commonCredentialKeys];
    const allowedCredentialKeys = new Set(credentialKeys);
    const credentials = Object.fromEntries(Object.entries(form.credentials || {}).filter(([key, value]) => (
      allowedCredentialKeys.has(key) && value
    )));
    const apiTokens = String(form.apiTokenPoolText || '').split(/[\n,]+/).map((token) => token.trim()).filter(Boolean);
    if (form.authMode === 'api_token' && apiTokens.length) {
      credentials.apiTokens = [...new Set(apiTokens)].slice(0, 20);
      credentials.apiToken = credentials.apiTokens[0];
    }
    const { apiTokenPoolText, ...cleanForm } = form;
    const body = { ...cleanForm, credentials: Object.keys(credentials).length ? credentials : undefined };
    if (editingAccount?.id) body.id = editingAccount.id;
    return body;
  }, [form, editingAccount]);

  const changeType = (type) => {
    const next = defaults(type);
    setForm((current) => ({
      ...current,
      type,
      profilePath: next.profilePath,
      balancePath: next.balancePath,
      formula: next.formula,
      rawUnit: next.rawUnit,
      authMode: next.authMode,
    }));
  };

  const changeNewApiAuthMode = (authMode) => {
    setForm((current) => ({
      ...current,
      authMode,
      profilePath: authMode === 'api_token' ? '/api/usage/token' : '/api/user/self',
      balancePath: authMode === 'api_token' ? 'data.total_available' : 'data.quota',
    }));
  };

  const changeSub2AuthMode = (authMode) => {
    setForm((current) => ({
      ...current,
      authMode,
      ...SUB2_AUTH_DEFAULTS[authMode],
    }));
  };

  const testFormula = async () => {
    setBusy('formula');
    try {
      const result = await api.testFormula(editingAccount?.rawBalance || 1500000, form.formula);
      setPreview(result);
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const testConnection = async () => {
    const submittedOneShotToken = Boolean(form.credentials.turnstileToken);
    setBusy('connection');
    try {
      const result = await api.testAccount(payload);
      setPreview(result);
      if (result.tokensCaptured || result.metadata?.tokenRenewed) {
        pushToast(`连接成功并已捕获/续期 Token，折算余额 ${money(result.convertedCny)}`, 'success');
      } else if (result.metadata?.apiTokenPoolSize) {
        pushToast(`免登录连接成功，API 密钥槽位 ${result.metadata.apiTokenSlot}/${result.metadata.apiTokenPoolSize} 可用`, 'success');
      } else if (result.metadata?.tokenPoolSize > 1) {
        pushToast(`连接成功，令牌池槽位 ${result.metadata.tokenSlot}/${result.metadata.tokenPoolSize} 可用`, 'success');
      } else {
        pushToast(`连接成功，折算余额 ${money(result.convertedCny)}`, 'success');
      }
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      if (submittedOneShotToken) setCredential('turnstileToken', '');
      setBusy('');
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy('save');
    try {
      const result = editingAccount ? await api.updateAccount(editingAccount.id, payload) : await api.createAccount(payload);
      if (result.syncError) pushToast(`账号已保存，但首次采集失败：${result.syncError}`, 'warning');
      else pushToast(editingAccount ? '账号配置已更新' : '账号已添加并开始监控', 'success');
      onSaved(result.account);
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const isSub2 = form.type === 'sub2api';
  const tokenHint = editingAccount
    ? [
        editingAccount.hasApiToken ? `${editingAccount.type === 'sub2api' ? 'API 令牌' : 'API 密钥'}${editingAccount.apiTokenCount > 1 ? ` × ${editingAccount.apiTokenCount}` : ''}` : null,
        editingAccount.hasAccessToken ? '用户访问令牌' : null,
        editingAccount.hasRefreshToken ? 'RT' : null,
        editingAccount.hasPassword ? '密码' : null,
        editingAccount.hasCfAccess ? 'CF Access' : null,
      ].filter(Boolean).join(' + ') || '无'
    : null;

  return (
    <Modal open={open} onClose={onClose} title={editingAccount ? '编辑监控账号' : '添加监控账号'} width={720}>
      <form className="account-form" onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title"><span>1</span><div><h3>账号归属与站点</h3></div></div>
          <label>
            <span>所属上游</span>
            <input required value={form.upstreamName || ''} onChange={(event) => set('upstreamName', event.target.value)} placeholder="例如 newapi、sub2api" />
          </label>
          <div className="type-segmented">
            {[['newapi', 'New API'], ['sub2api', 'Sub2API'], ['generic', '自定义']].map(([id, label]) => (
              <button type="button" key={id} className={form.type === id ? 'active' : ''} onClick={() => changeType(id)}>{label}</button>
            ))}
          </div>
          <div className="form-grid two">
            <label><span>账号别名</span><input required value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="例如 主账号、备用账号" /></label>
            <label><span>所属地区</span><input value={form.region} onChange={(event) => set('region', event.target.value)} placeholder="例如 美国 (US)" /></label>
          </div>
          <label><span>站点地址</span><input required type="url" value={form.baseUrl} onChange={(event) => set('baseUrl', event.target.value)} placeholder="https://example.com" /></label>

          {!isSub2 && form.type === 'newapi' && (
            <>
              <div className="auth-hint">
                <Info size={18} weight="fill" />
                <div>
                  <strong>{form.authMode === 'api_token' ? 'API 密钥：只读取该密钥的可用额度' : form.authMode === 'access_token' ? '新版用户访问令牌：免登录读取整个账户余额' : '账号密码：仅作为回退方式'}</strong>
                  <p>{form.authMode === 'api_token'
                    ? '使用左侧“API 密钥”页面创建的调用密钥，请求 /api/usage/token。余额只属于该 Key；额外填写用户访问令牌与 User ID 后，会自动定位并读取它的分组倍率。'
                    : form.authMode === 'access_token'
                      ? '使用“个人资料 → 安全 → 访问令牌”生成的字符串，原样放入 Authorization；NewAPI 同时要求 User ID 请求头，不需要用户名或密码。'
                      : `密码模式遇到挑战时会${turnstileSolver?.enabled ? '进入浏览器验证并保存可用会话；仅在上游明确返回 AT/RT 时才回写令牌' : '尝试登录，建议同时保存用户访问令牌作为回退'}。`}</p>
                  {tokenHint && <p className="auth-hint-status">已保存凭据：{tokenHint}（字段留空表示不修改）</p>}
                </div>
              </div>
              <div className="form-grid two">
                <label>
                  <span>余额读取方式</span>
                  <select value={form.authMode} onChange={(event) => changeNewApiAuthMode(event.target.value)}>
                    <option value="access_token">用户访问令牌（新版，账户余额）</option>
                    <option value="api_token">API 密钥（仅密钥额度）</option>
                    <option value="password">账号密码</option>
                  </select>
                </label>
                {form.authMode === 'api_token' && <label>
                  <span>令牌调度</span>
                  <select value={form.tokenStrategy || 'sticky'} onChange={(event) => set('tokenStrategy', event.target.value)}>
                    <option value="sticky">故障切换（推荐）</option>
                    <option value="round_robin">轮询调度</option>
                  </select>
                </label>}
                {form.authMode !== 'api_token' && <label><span>User ID</span><input value={form.userId} onChange={(event) => set('userId', event.target.value)} placeholder="用户资料中显示的数字 ID" /></label>}
              </div>
              {form.authMode === 'api_token' && <label>
                  <span>API 密钥（每行一个，最多 20 个）</span>
                <div className="secret-input">
                  <textarea
                    className={showSecret ? '' : 'masked-textarea'}
                    value={form.apiTokenPoolText || ''}
                    onChange={(event) => set('apiTokenPoolText', event.target.value)}
                    placeholder={editingAccount?.hasApiToken ? `已加密保存 ${editingAccount.apiTokenCount || 1} 个 API 密钥，留空不修改` : '粘贴“API 密钥”页面创建的调用密钥'}
                  />
                  <button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button>
                </div>
                <small>{form.tokenStrategy === 'round_robin' ? '每次采集从下一个 API 密钥开始，失败继续切换。' : '沿用上次成功的 API 密钥，失效时自动切换。'} 系统兼容带或不带 sk- 的密钥；无限额度密钥无法提供有限余额。</small>
              </label>}
              {form.authMode === 'api_token' && <div className="form-grid two">
                <label>
                  <span>User ID（倍率读取）</span>
                  <input value={form.userId} onChange={(event) => set('userId', event.target.value)} placeholder="用户资料中显示的数字 ID" />
                </label>
                <label>
                  <span>用户访问令牌（倍率读取，可选）</span>
                  <div className="secret-input"><input type={showSecret ? 'text' : 'password'} value={form.credentials.accessToken} onChange={(event) => setCredential('accessToken', event.target.value)} placeholder={editingAccount?.hasAccessToken ? '已加密保存，留空不修改' : '个人资料 → 安全 → 访问令牌'} /><button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button></div>
                  <small>只用于读取 API Key 列表与用户分组倍率，不参与该 Key 的余额鉴权。</small>
                </label>
              </div>}
              {form.authMode !== 'api_token' && <>
                <label>
                  <span>用户访问令牌{form.authMode === 'password' ? '（登录失败回退）' : ''}</span>
                  <div className="secret-input"><input type={showSecret ? 'text' : 'password'} value={form.credentials.accessToken} onChange={(event) => setCredential('accessToken', event.target.value)} placeholder={editingAccount?.hasAccessToken ? '已加密保存，留空不修改' : '个人资料 → 安全 → 访问令牌'} /><button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button></div>
                  <small>令牌按页面显示的原始值提交，不要添加 Bearer 或 sk-。User ID 是 NewAPI 账户数字 ID，用于 New-Api-User 校验。</small>
                </label>
                {form.authMode === 'password' && <div className="form-grid two"><label><span>用户名 / 邮箱</span><input value={form.username} onChange={(event) => set('username', event.target.value)} /></label><label><span>登录密码</span><input
                    type={showSecret ? 'text' : 'password'}
                    value={form.credentials.password}
                    onChange={(event) => setCredential('password', event.target.value)}
                    placeholder={editingAccount?.hasPassword ? '已保存，留空不修改' : '遇 CF 时用于浏览器登录'}
                  /></label></div>}
              </>}
            </>
          )}

          {!isSub2 && form.type !== 'newapi' && (
            <>
              <div className="auth-row">
                <label>
                  <span>认证方式</span>
                  <select value={form.authMode} onChange={(event) => set('authMode', event.target.value)}>
                    <option value="access_token">Access Token</option>
                    <option value="password">账号密码</option>
                  </select>
                </label>
                {form.authMode === 'password' && (
                  <label><span>用户名 / 邮箱</span><input value={form.username} onChange={(event) => set('username', event.target.value)} /></label>
                )}
              </div>
              <label>
                <span>{form.authMode === 'password' ? '登录密码' : 'Access Token'}</span>
                <div className="secret-input">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={form.authMode === 'password' ? form.credentials.password : form.credentials.accessToken}
                    onChange={(event) => setCredential(form.authMode === 'password' ? 'password' : 'accessToken', event.target.value)}
                    placeholder={editingAccount?.hasCredentials ? '留空则保留已加密凭据' : '仅加密保存，不会返回到浏览器'}
                  />
                  <button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button>
                </div>
              </label>
            </>
          )}

          {isSub2 && (
            <>
              <div className="auth-hint">
                <Info size={18} weight="fill" />
                <div>
                  <strong>{form.authMode === 'api_token'
                    ? 'Sub2API API 令牌：免登录读取剩余额度'
                    : form.authMode === 'access_token'
                      ? 'AT/RT 长久会话：自动续期并回写旋转令牌'
                      : '账号密码兜底：优先复用 AT/RT，失效后自动登录'}</strong>
                  {form.authMode === 'api_token' && <p>使用以 sk- 开头的用户 API Key 请求 /v1/usage，读取 wallet、API key 或 subscription 范围返回的 remaining；无需登录账号。</p>}
                  {form.authMode === 'access_token' && <p>
                    优先使用 Access Token 拉余额；JWT 临近过期会提前用 Refresh Token 续期；上游返回旋转 RT 时立即加密回写。两者都失效时，可使用邮箱密码重新登录并保存新的 AT/RT。
                  </p>}
                  {form.authMode === 'password' && <p>
                    优先复用已保存的 Access Token / Refresh Token；令牌失效后使用邮箱和密码重新登录并保存新令牌。
                    {turnstileSolver?.enabled && turnstileSolver.provider === 'browser'
                      ? ' 遇 Cloudflare 挑战时会在固定出口打开浏览器并等待验证完成。'
                      : turnstileSolver?.enabled
                        ? ' 遇到验证页面时会保持浏览器打开并等待完成。'
                        : ' 验证站点可启用浏览器流程。'}
                  </p>}
                  {tokenHint && <p className="auth-hint-status">已保存凭据：{tokenHint}（字段留空表示不修改）</p>}
                </div>
              </div>

              <div className="form-grid two">
                <label>
                  <span>认证方式</span>
                  <select value={form.authMode} onChange={(event) => changeSub2AuthMode(event.target.value)}>
                    <option value="api_token">API 令牌免登录（sk-）</option>
                    <option value="access_token">Access Token / Refresh Token</option>
                    <option value="password">账号密码</option>
                  </select>
                </label>
                {form.authMode === 'api_token' && <label>
                  <span>令牌调度</span>
                  <select value={form.tokenStrategy || 'sticky'} onChange={(event) => set('tokenStrategy', event.target.value)}>
                    <option value="sticky">故障切换（推荐）</option>
                    <option value="round_robin">轮询调度</option>
                  </select>
                </label>}
              </div>

              {form.authMode === 'api_token' && <label>
                <span>Sub2API API 令牌（每行一个，最多 20 个）</span>
                <div className="secret-input">
                  <textarea
                    className={showSecret ? '' : 'masked-textarea'}
                    value={form.apiTokenPoolText || ''}
                    onChange={(event) => set('apiTokenPoolText', event.target.value)}
                    placeholder={editingAccount?.hasApiToken ? `已加密保存 ${editingAccount.apiTokenCount || 1} 个 API 令牌，留空不修改` : 'sk-...'}
                  />
                  <button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button>
                </div>
                <small>{form.tokenStrategy === 'round_robin' ? '每次采集从下一个令牌开始，失败继续切换。' : '沿用上次成功令牌，失效时自动切换。'} /v1/usage 会读取 wallet、API key 或 subscription 对应的 remaining。</small>
              </label>}

              {form.authMode !== 'api_token' && <>
                <label>
                  <span>登录邮箱{form.authMode === 'access_token' ? '（密码回退时使用）' : ''}</span>
                  <input value={form.username} onChange={(event) => set('username', event.target.value)} placeholder="user@example.com" />
                </label>

                {form.authMode === 'password' && <label>
                  <span>登录密码</span>
                  <div className="secret-input">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={form.credentials.password}
                      onChange={(event) => setCredential('password', event.target.value)}
                      placeholder={editingAccount?.hasPassword ? '已保存，留空不修改' : '账号登录密码'}
                    />
                    <button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button>
                  </div>
                </label>}

                <label>
                  <span>Access Token{form.authMode === 'password' ? '（可选回退）' : '（推荐）'}</span>
                  <div className="secret-input">
                    <input
                      type={showSecret ? 'text' : 'password'}
                      value={form.credentials.accessToken}
                      onChange={(event) => setCredential('accessToken', event.target.value)}
                      placeholder={editingAccount?.hasAccessToken ? '已保存，留空不修改' : 'Bearer 使用的 access_token'}
                    />
                    <button type="button" onClick={() => setShowSecret((value) => !value)}>{showSecret ? <EyeSlash size={17} /> : <Eye size={17} />}</button>
                  </div>
                </label>

                <label>
                  <span>Refresh Token{form.authMode === 'password' ? '（可选回退）' : '（用于自动续期）'}</span>
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={form.credentials.refreshToken}
                    onChange={(event) => setCredential('refreshToken', event.target.value)}
                    placeholder={editingAccount?.hasRefreshToken ? '已保存，留空不修改' : 'refresh_token'}
                  />
                </label>

                {form.authMode === 'access_token' && <label>
                  <span>登录密码（可选回退）</span>
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={form.credentials.password}
                    onChange={(event) => setCredential('password', event.target.value)}
                    placeholder={editingAccount?.hasPassword ? '已保存，留空不修改' : 'AT/RT 都失效时用于重新登录'}
                  />
                </label>}

                <label>
                  <span>一次性 Turnstile Token（可选）</span>
                  <input
                    type={showSecret ? 'text' : 'password'}
                    value={form.credentials.turnstileToken}
                    onChange={(event) => setCredential('turnstileToken', event.target.value)}
                    placeholder="人工验证后粘贴一次；浏览器验证开启时可留空"
                  />
                </label>
              </>}
            </>
          )}
        </div>

        <div className="form-section">
          <div className="form-section-title"><span>2</span><div><h3>余额转换器</h3><p>把登录后取得的余额处理为人民币。</p></div></div>
          <div className="form-grid formula-grid">
            <label><span>原始余额字段</span><input required value={form.balancePath} onChange={(event) => set('balancePath', event.target.value)} /></label>
            <label><span>原始单位</span><input value={form.rawUnit} onChange={(event) => set('rawUnit', event.target.value)} /></label>
            <label className="formula-field"><span>转换公式</span><input required value={form.formula} onChange={(event) => set('formula', event.target.value)} /><small>仅支持 x、数字、+ - * / 和括号</small></label>
            <button type="button" className="secondary-button formula-test-button" onClick={testFormula} disabled={busy === 'formula'}>{busy === 'formula' ? <SpinnerGap className="spin" /> : <Flask size={16} />} 测试公式</button>
          </div>
          {preview && (
            <div className="connection-preview">
              <CheckCircle size={20} weight="fill" />
              <div>
                <span>转换结果</span>
                <strong>{money(preview.convertedCny)}</strong>
                <small>
                  原始值 {preview.rawBalance ?? preview.rawValue}
                  {preview.metadata?.authSource ? ` · 鉴权 ${preview.metadata.authSource}` : ''}
                  {preview.metadata?.apiTokenPoolSize ? ` · API 密钥槽位 ${preview.metadata.apiTokenSlot}/${preview.metadata.apiTokenPoolSize}` : ''}
                  {preview.metadata?.rateMultiplier !== null && preview.metadata?.rateMultiplier !== undefined && Number.isFinite(Number(preview.metadata.rateMultiplier)) ? ` · 当前倍率 × ${Number(preview.metadata.rateMultiplier)}` : ''}
                  {preview.metadata?.tokenPoolSize ? ` · 令牌槽位 ${preview.metadata.tokenSlot}/${preview.metadata.tokenPoolSize}` : ''}
                  {preview.metadata?.refreshReason ? ` · 主动续期 ${preview.metadata.refreshReason}` : ''}
                  {preview.metadata?.refreshTokenRotated ? ' · RT 已轮换' : ''}
                  {preview.tokensCaptured || preview.metadata?.tokenRenewed ? ' · 已捕获/续期 Token' : ''}
                </small>
              </div>
            </div>
          )}
        </div>

        <div className="form-section">
          <div className="form-section-title"><span>3</span><div><h3>告警与恢复</h3><p>所有阈值都使用折算后的人民币余额。</p></div></div>
          <div className="form-grid three">
            <label><span>触发阈值 (CNY)</span><input type="number" min="0" value={form.thresholdLow} onChange={(event) => set('thresholdLow', event.target.value)} /></label>
            <label><span>恢复阈值 (CNY)</span><input type="number" min="0" value={form.thresholdRecover} onChange={(event) => set('thresholdRecover', event.target.value)} /></label>
            <label>
              <span>采集频率</span>
              <select value={form.pollIntervalMinutes} onChange={(event) => set('pollIntervalMinutes', Number(event.target.value))}>
                <option value="1">每 1 分钟</option>
                <option value="5">每 5 分钟</option>
                <option value="10">每 10 分钟</option>
                <option value="30">每 30 分钟</option>
              </select>
            </label>
          </div>
        </div>

        <button type="button" className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>{advanced ? '收起高级设置' : '展开高级设置'}</button>
        {advanced && (
          <div className="form-grid two advanced-fields">
            <label><span>用户信息接口</span><input value={form.profilePath} onChange={(event) => set('profilePath', event.target.value)} /></label>
            <label><span>站点内分组</span><input value={form.subgroup} onChange={(event) => set('subgroup', event.target.value)} /></label>
            {(isSub2 || form.type === 'newapi') && (
              <label className="span-2">
                <span>Turnstile Site Key（可选）</span>
                <input
                  value={form.turnstileSiteKey || ''}
                  onChange={(event) => set('turnstileSiteKey', event.target.value)}
                  placeholder="0x4AAAAA... 留空则自动从站点 HTML/JS 发现"
                />
                <small>浏览器自动发现失败时再填；可在上游登录页源码中搜索 data-sitekey</small>
              </label>
            )}
            <label>
              <span>CF Access Client ID（可选）</span>
              <input
                type={showSecret ? 'text' : 'password'}
                value={form.credentials.cfAccessClientId || ''}
                onChange={(event) => setCredential('cfAccessClientId', event.target.value)}
                placeholder={editingAccount?.hasCfAccess ? '已加密保存，留空不修改' : '仅自管上游使用'}
              />
            </label>
            <label>
              <span>CF Access Client Secret（可选）</span>
              <input
                type={showSecret ? 'text' : 'password'}
                value={form.credentials.cfAccessClientSecret || ''}
                onChange={(event) => setCredential('cfAccessClientSecret', event.target.value)}
                placeholder={editingAccount?.hasCfAccess ? '已加密保存，留空不修改' : 'Service Token Secret'}
              />
              <small>只发送到当前上游同源请求，不会发送给挑战 iframe 或第三方域名。</small>
            </label>
          </div>
        )}

        <footer className="modal-actions">
          <button type="button" className="secondary-button" onClick={testConnection} disabled={Boolean(busy)}>
            {busy === 'connection' ? <SpinnerGap className="spin" /> : <Flask size={16} />} 测试连接
          </button>
          <div>
            <button type="button" className="ghost-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={Boolean(busy)}>{busy === 'save' && <SpinnerGap className="spin" />} {editingAccount ? '保存修改' : '添加并监控'}</button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
