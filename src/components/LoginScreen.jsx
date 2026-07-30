import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeSlash, Key, LockKey, ShieldCheck, UserCircle } from '@phosphor-icons/react';
import { Turnstile } from '@marsidev/react-turnstile';

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
  const turnstileRef = useRef(null);
  const checks = useMemo(() => passwordChecks(password), [password]);

  useEffect(() => {
    if (setup && !password) setPassword(generateStrongPassword());
  }, [setup, password]);

  const resetTurnstile = () => {
    setTurnstileToken('');
    turnstileRef.current?.reset();
  };

  const submit = async (event) => {
    event.preventDefault();
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
    <main className="login-screen">
      <section className={`login-glass ${setup ? 'setup' : ''}`}>
        <div className="brand-mark large"><span>霜</span></div>
        <p className="eyebrow">PRIVATE OPERATIONS</p>
        <h1>{challengeToken ? '两步验证' : setup ? '初始化管理员' : '霜镜'}</h1>
        <p className="login-copy">{challengeToken ? '输入验证器中的 6 位动态码，也可使用一条恢复码。' : setup ? '自拟用户名，使用系统生成的强密码建立首个管理员。' : '验证身份后进入上游余额控制台。'}</p>
        <form onSubmit={submit}>
          {!challengeToken && <>
            <label className="field-label" htmlFor="admin-username">管理员用户名</label>
            <div className="input-with-icon"><UserCircle size={18} /><input id="admin-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus placeholder="3-32 个字符，可自行拟定" /></div>
            <label className="field-label" htmlFor="admin-password">管理员密码</label>
            <div className="input-with-icon password-input"><LockKey size={18} /><input id="admin-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeSlash size={17} /> : <Eye size={17} />}</button></div>
            {setup && session?.bootstrapRequired && <><label className="field-label" htmlFor="bootstrap-token">部署引导令牌</label><div className="input-with-icon"><Key size={18} /><input id="bootstrap-token" type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="one-time-code" placeholder="部署终端显示的一次性令牌" /></div></>}
            {setup && <><div className="generated-password-row"><span>已默认生成强密码</span><button type="button" onClick={() => setPassword(generateStrongPassword())}>重新生成</button></div><div className="password-checks">{checks.map(([label, passed]) => <span className={passed ? 'passed' : ''} key={label}><ShieldCheck size={13} weight={passed ? 'fill' : 'regular'} />{label}</span>)}</div></>}
            {session?.turnstile?.enabled && <div className="turnstile-wrap"><Turnstile ref={turnstileRef} siteKey={session.turnstile.siteKey} onSuccess={setTurnstileToken} onExpire={resetTurnstile} onError={resetTurnstile} options={{ action: setup ? 'setup' : 'login', theme: 'light', size: 'flexible' }} /></div>}
          </>}
          {challengeToken && <><label className="field-label" htmlFor="two-factor-code">动态验证码或恢复码</label><div className="input-with-icon"><Key size={18} /><input id="two-factor-code" value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456 或 XXXX-XXXX-XXXX" /></div></>}
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button full" disabled={busy || (challengeToken ? code.length < 6 : !username || !password || (setup && checks.some(([, passed]) => !passed)) || (setup && session?.bootstrapRequired && !bootstrapToken) || (session?.turnstile?.enabled && !turnstileToken))}>
            {busy ? '正在验证' : challengeToken ? '完成验证' : setup ? '创建管理员并进入' : '继续'} <ArrowRight size={17} />
          </button>
          {challengeToken && <button type="button" className="login-back-button" onClick={() => { setChallengeToken(''); setCode(''); }}>返回密码登录</button>}
        </form>
      </section>
    </main>
  );
}
