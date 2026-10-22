import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeSlash, Key, LockKey, ShieldCheck, UserCircle } from '@phosphor-icons/react';
import { Turnstile } from '@marsidev/react-turnstile';
import './onboarding-login.css';

function generateStrongPassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%&*+-_='];
  const all = groups.join('');
  const values = crypto.getRandomValues(new Uint32Array(20));
  const chars = groups.map((group, index) => group[values[index] % group.length]);
  for (let index = 4; index < values.length; index += 1) chars.push(all[values[index] % all.length]);
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const target = crypto.getRandomValues(new Uint32Array(1))[0] % (index + 1);
    [chars[index], chars[target]] = [chars[target], chars[index]];
  }
  return chars.join('');
}

function passwordChecks(password) {
  return [
    ['至少 12 位', password.length >= 12],
    ['大写字母', /[A-Z]/.test(password)],
    ['小写字母', /[a-z]/.test(password)],
    ['数字', /\d/.test(password)],
    ['特殊符号', /[^A-Za-z0-9]/.test(password)],
  ];
}

export function LoginScreen({ session, onSetup, onLogin, onVerifyTwoFactor, busy, error }) {
  const setup = Boolean(session?.setupRequired);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [challengeToken, setChallengeToken] = useState('');
  const [code, setCode] = useState('');
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(null);
  const [copying, setCopying] = useState(false);
  const generatedSetupPassword = useRef(false);
  const currentPassword = useRef(password);
  const turnstileRef = useRef(null);
  const checks = useMemo(() => passwordChecks(password), [password]);
  currentPassword.current = password;

  useEffect(() => {
    if (!setup || generatedSetupPassword.current) return;
    generatedSetupPassword.current = true;
    if (!currentPassword.current) setPassword(generateStrongPassword());
  }, [setup]);

  const updatePassword = (value) => {
    setPassword(value);
    setPasswordSaved(false);
    setCopyFeedback(null);
  };

  const copyPassword = async () => {
    const value = password;
    setCopying(true);
    setCopyFeedback(null);
    try {
      await navigator.clipboard.writeText(value);
      if (currentPassword.current === value) setCopyFeedback({ error: false, text: '密码已复制，请保存到你的密码管理器。' });
    } catch {
      if (currentPassword.current === value) setCopyFeedback({ error: true, text: '复制失败。请点击“显示”，手动复制并保存密码。' });
    } finally {
      setCopying(false);
    }
  };

  const resetTurnstile = () => {
    setTurnstileToken('');
    turnstileRef.current?.reset();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (busy || (setup && !challengeToken && !passwordSaved)) return;
    if (challengeToken) {
      const result = await onVerifyTwoFactor({ challengeToken, code });
      if (!result) setCode('');
      return;
    }
    const payload = { username, password, bootstrapToken, turnstileToken };
    const result = setup ? await onSetup(payload) : await onLogin(payload);
    if (result?.requiresTwoFactor) {
      setChallengeToken(result.challengeToken);
      setPassword('');
      resetTurnstile();
    } else if (!result) {
      resetTurnstile();
    }
  };

  return (
    <main className="login-screen login-accessible-screen">
      <section className={`login-glass ${setup ? 'setup' : ''}`}>
        <div className="brand-mark large"><span>霜</span></div>
        <p className="eyebrow">PRIVATE OPERATIONS</p>
        <h1>{challengeToken ? '两步验证' : setup ? '欢迎使用霜镜' : '霜镜'}</h1>
        <p className="login-copy">{challengeToken ? '输入验证器中的 6 位动态码，也可使用一条恢复码。' : setup ? '先创建管理员账号，用于登录霜镜。上游账号和令牌会在进入后单独接入。' : '验证身份后进入上游余额控制台。'}</p>
        {setup && !challengeToken && <ol className="onboarding-login-steps" aria-label="首次使用步骤"><li aria-current="step"><span>1</span>创建管理员</li><li><span>2</span>接入上游</li><li><span>3</span>设置提醒</li></ol>}
        <form onSubmit={submit} aria-busy={busy}>
          {!challengeToken && <>
            <label className="field-label" htmlFor="admin-username">管理员用户名</label>
            <div className="input-with-icon"><UserCircle size={18} aria-hidden="true" /><input id="admin-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required disabled={busy} minLength={setup ? 3 : undefined} maxLength={setup ? 32 : undefined} placeholder={setup ? '3–32 个字符，可自行拟定' : '输入管理员用户名'} /></div>
            <label className="field-label" htmlFor="admin-password">管理员密码</label>
            <div className="input-with-icon password-input"><LockKey size={18} aria-hidden="true" /><input id="admin-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => updatePassword(event.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} required disabled={busy} aria-describedby={setup ? 'password-guidance password-requirements' : undefined} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} title={showPassword ? '隐藏密码' : '显示密码'}>{setup ? (showPassword ? '隐藏' : '显示') : showPassword ? <EyeSlash size={17} /> : <Eye size={17} />}</button></div>
            {setup && <>
              <div className="generated-password-row"><span id="password-guidance">默认提供强密码，也可自行修改</span><div><button type="button" onClick={copyPassword} disabled={busy || !password || copying}>{copying ? '复制中…' : '复制密码'}</button><button type="button" disabled={busy} onClick={() => updatePassword(generateStrongPassword())}>重新生成</button></div></div>
              {copyFeedback && <p className={`password-copy-feedback ${copyFeedback.error ? 'error' : ''}`} role={copyFeedback.error ? 'alert' : 'status'}>{copyFeedback.text}</p>}
              <div className="password-checks" id="password-requirements" role="list" aria-label="密码要求">{checks.map(([label, passed]) => <span className={passed ? 'passed' : ''} key={label} role="listitem"><ShieldCheck size={13} weight={passed ? 'fill' : 'regular'} aria-hidden="true" />{label}<span className="onboarding-sr-only">，{passed ? '已满足' : '未满足'}</span></span>)}</div>
              <label className="password-saved-confirmation"><input type="checkbox" checked={passwordSaved} onChange={(event) => setPasswordSaved(event.target.checked)} disabled={busy || !password} required /><span>已妥善保存管理员密码<small>后续登录需要使用此密码，请勿与上游密码混用。</small></span></label>
            </>}
            {setup && session?.bootstrapRequired && <><label className="field-label" htmlFor="bootstrap-token">部署引导令牌</label><div className="input-with-icon"><Key size={18} aria-hidden="true" /><input id="bootstrap-token" type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="one-time-code" placeholder="部署终端显示的一次性令牌" required disabled={busy} aria-describedby="bootstrap-token-help" /></div><p className="bootstrap-token-help" id="bootstrap-token-help">用于确认你有权初始化这台霜镜服务，仅首次创建管理员时需要。</p></>}
            {session?.turnstile?.enabled && <div className="turnstile-wrap"><Turnstile ref={turnstileRef} siteKey={session.turnstile.siteKey} onSuccess={setTurnstileToken} onExpire={resetTurnstile} onError={resetTurnstile} options={{ action: setup ? 'setup' : 'login', theme: 'light', size: 'flexible' }} /></div>}
          </>}
          {challengeToken && <><label className="field-label" htmlFor="two-factor-code">动态验证码或恢复码</label><div className="input-with-icon"><Key size={18} aria-hidden="true" /><input id="two-factor-code" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy} autoFocus placeholder="123456 或 XXXX-XXXX-XXXX" /></div></>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full" disabled={busy || (challengeToken ? code.length < 6 : !username.trim() || !password || (setup && (!passwordSaved || checks.some(([, passed]) => !passed))) || (setup && session?.bootstrapRequired && !bootstrapToken) || (session?.turnstile?.enabled && !turnstileToken))}>
            {busy ? (setup ? '正在创建管理员…' : '正在验证…') : challengeToken ? '完成验证' : setup ? '创建管理员，开始接入' : '继续'} <ArrowRight size={17} aria-hidden="true" />
          </button>
          {challengeToken && <button type="button" className="login-back-button" disabled={busy} onClick={() => { setChallengeToken(''); setCode(''); }}>返回密码登录</button>}
        </form>
      </section>
    </main>
  );
}
