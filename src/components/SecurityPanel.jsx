import { useEffect, useState } from 'react';
import { CheckCircle, Copy, Key, LockKey, QrCode, ShieldCheck, SpinnerGap, UserCircle, WarningCircle } from '@phosphor-icons/react';
import { api } from '../api.js';

export function SecurityPanel({ onClose, onSessionChanged, pushToast }) {
  const [security, setSecurity] = useState(null);
  const [profile, setProfile] = useState({ username: '', currentPassword: '', newPassword: '' });
  const [enrollment, setEnrollment] = useState(null);
  const [enableCode, setEnableCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [manageMode, setManageMode] = useState('');
  const [manage, setManage] = useState({ currentPassword: '', code: '' });
  const [busy, setBusy] = useState('');

  const load = async () => {
    const result = await api.security();
    setSecurity(result);
    setProfile((current) => ({ ...current, username: result.username }));
  };

  useEffect(() => { load().catch((error) => pushToast(error.message, 'error')); }, []);

  const saveProfile = async (event) => {
    event.preventDefault();
    setBusy('profile');
    try {
      const payload = { currentPassword: profile.currentPassword };
      if (profile.username && profile.username !== security.username) payload.username = profile.username;
      if (profile.newPassword) payload.newPassword = profile.newPassword;
      await api.updateSecurityProfile(payload);
      await onSessionChanged();
      await load();
      setProfile((current) => ({ ...current, currentPassword: '', newPassword: '' }));
      pushToast('管理员账户已更新，旧会话已经失效', 'success');
    } catch (error) { pushToast(error.message, 'error'); }
    finally { setBusy(''); }
  };

  const startEnrollment = async () => {
    setBusy('setup2fa');
    try {
      setEnrollment(await api.setupTwoFactor());
      setEnableCode('');
    } catch (error) { pushToast(error.message, 'error'); }
    finally { setBusy(''); }
  };

  const enable = async (event) => {
    event.preventDefault();
    setBusy('enable2fa');
    try {
      const result = await api.enableTwoFactor(enableCode);
      setRecoveryCodes(result.recoveryCodes);
      setEnrollment(null);
      await onSessionChanged();
      await load();
      pushToast('两步验证已启用，请妥善保存恢复码', 'success');
    } catch (error) { pushToast(error.message, 'error'); }
    finally { setBusy(''); }
  };

  const manageTwoFactor = async (event) => {
    event.preventDefault();
    setBusy(manageMode);
    try {
      if (manageMode === 'regenerate') {
        const result = await api.regenerateRecoveryCodes(manage);
        setRecoveryCodes(result.recoveryCodes);
        pushToast('旧恢复码已作废，新恢复码已生成', 'success');
      } else {
        await api.disableTwoFactor(manage);
        await onSessionChanged();
        await load();
        setRecoveryCodes([]);
        pushToast('两步验证已关闭', 'success');
      }
      setManageMode('');
      setManage({ currentPassword: '', code: '' });
    } catch (error) { pushToast(error.message, 'error'); }
    finally { setBusy(''); }
  };

  const copyRecoveryCodes = async () => {
    await navigator.clipboard.writeText(recoveryCodes.join('\n'));
    pushToast('恢复码已复制', 'success');
  };

  if (!security) return <div className="security-loading"><SpinnerGap className="spin" /> 正在读取账户安全状态</div>;

  return (
    <div className="security-panel">
      <section className="security-section">
        <header><UserCircle size={21} /><div><h3>管理员账户</h3><p>用户名可自行修改；修改后其他登录会话立即失效。</p></div></header>
        <form onSubmit={saveProfile}>
          <div className="form-grid two"><label><span>管理员用户名</span><input value={profile.username} onChange={(event) => setProfile((current) => ({ ...current, username: event.target.value }))} /></label><label><span>当前密码</span><input type="password" required value={profile.currentPassword} onChange={(event) => setProfile((current) => ({ ...current, currentPassword: event.target.value }))} /></label></div>
          <label><span>新密码（不修改可留空）</span><input type="password" value={profile.newPassword} onChange={(event) => setProfile((current) => ({ ...current, newPassword: event.target.value }))} placeholder="至少 12 位，并包含大小写、数字和符号" /></label>
          <div className="security-action-row"><span>密码使用 bcrypt 12 轮哈希保存。</span><button className="secondary-button" disabled={Boolean(busy)}>{busy === 'profile' && <SpinnerGap className="spin" />} 保存账户</button></div>
        </form>
      </section>

      <section className="security-section">
        <header><ShieldCheck size={21} /><div><h3>登录人机验证</h3><p>Cloudflare Turnstile token 会交给服务器进行一次性校验。</p></div><span className={`security-status ${security.turnstileEnabled ? 'success' : 'muted'}`}>{security.turnstileEnabled ? '已启用' : '待配置'}</span></header>
        <div className="security-note"><LockKey size={17} /><p>{security.turnstileEnabled ? '登录和首次初始化均要求通过人机验证。' : '在服务器环境变量中填写 DASHBOARD_TURNSTILE_SITE_KEY 与 DASHBOARD_TURNSTILE_SECRET_KEY 后自动启用。'}</p></div>
      </section>

      <section className="security-section compact">
        <header><Key size={21} /><div><h3>两步验证（TOTP）</h3><p>支持 Google Authenticator、Microsoft Authenticator、1Password 等验证器。</p></div><span className={`security-status ${security.twoFactorEnabled ? 'success' : 'muted'}`}>{security.twoFactorEnabled ? '已启用' : '未启用'}</span></header>
        {!security.twoFactorEnabled && !enrollment && <div className="two-factor-empty"><QrCode size={28} /><div><strong>绑定验证器</strong><p>密码验证后，还需要 6 位动态码才能登录。</p></div><button className="primary-button" onClick={startEnrollment} disabled={Boolean(busy)}>{busy === 'setup2fa' && <SpinnerGap className="spin" />} 开始绑定</button></div>}
        {enrollment && <form className="two-factor-enrollment" onSubmit={enable}><img src={enrollment.qrCodeDataUrl} alt="两步验证二维码" /><div><strong>1. 使用验证器扫描二维码</strong><p>无法扫码时手动输入密钥：</p><code>{enrollment.secret}</code><label><span>2. 输入验证器生成的 6 位验证码</span><input value={enableCode} onChange={(event) => setEnableCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" /></label><button className="primary-button" disabled={busy || enableCode.length !== 6}>{busy === 'enable2fa' && <SpinnerGap className="spin" />} 确认启用</button></div></form>}
        {security.twoFactorEnabled && !manageMode && <div className="two-factor-enabled"><CheckCircle size={24} weight="fill" /><div><strong>登录保护正常</strong><p>剩余 {security.recoveryCodesRemaining} 条恢复码。恢复码每条只能使用一次。</p></div><div><button className="secondary-button" onClick={() => setManageMode('regenerate')}>重置恢复码</button><button className="danger-text-button" onClick={() => setManageMode('disable')}>关闭 2FA</button></div></div>}
        {manageMode && <form className="two-factor-manage" onSubmit={manageTwoFactor}><div className="security-warning"><WarningCircle size={18} weight="fill" /><p>{manageMode === 'regenerate' ? '生成新恢复码后，所有旧恢复码立即作废。' : '关闭后，登录将只依赖用户名、密码和人机验证。'}</p></div><div className="form-grid two"><label><span>当前密码</span><input type="password" required value={manage.currentPassword} onChange={(event) => setManage((current) => ({ ...current, currentPassword: event.target.value }))} /></label><label><span>动态码或恢复码</span><input required value={manage.code} onChange={(event) => setManage((current) => ({ ...current, code: event.target.value }))} /></label></div><div className="security-action-row"><button type="button" className="ghost-button" onClick={() => setManageMode('')}>取消</button><button className={manageMode === 'disable' ? 'danger-button' : 'primary-button'} disabled={Boolean(busy)}>{busy === manageMode && <SpinnerGap className="spin" />}{manageMode === 'disable' ? '确认关闭' : '生成新恢复码'}</button></div></form>}
        {recoveryCodes.length > 0 && <div className="recovery-codes"><header><div><strong>仅显示一次：请离线保存恢复码</strong><p>手机丢失时，每条恢复码可代替一次动态验证码。</p></div><button className="secondary-button" onClick={copyRecoveryCodes}><Copy size={15} /> 复制全部</button></header><div>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div></div>}
      </section>

      <footer className="modal-actions"><span className="settings-save-note">安全设置变更会写入审计记录。</span><div><button type="button" className="primary-button" onClick={onClose}>完成</button></div></footer>
    </div>
  );
}
