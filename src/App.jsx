import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from './api.js';
import { AccountModal } from './components/AccountModal.jsx';
import { LoginScreen } from './components/LoginScreen.jsx';
import { QuickAccountModal } from './components/QuickAccountModal.jsx';
import { SettingsModal } from './components/SettingsModal.jsx';
import { StatusDashboard } from './components/StatusDashboard.jsx';
import { UpstreamModal } from './components/UpstreamModal.jsx';

function Toasts({ toasts, dismiss }) {
  const icons = { success: CheckCircle, warning: WarningCircle, error: WarningCircle, info: Info };
  return (
    <div className="toast-stack">
      <AnimatePresence>
        {toasts.map((toast) => {
          const Icon = icons[toast.tone] || Info;
          return (
            <motion.div className={`toast ${toast.tone}`} key={toast.id} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 18 }}>
              <Icon size={19} weight="fill" /><span>{toast.message}</span><button type="button" onClick={() => dismiss(toast.id)} aria-label="关闭通知"><X size={15} /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><div className="status-brand-mark loading-mark">上</div><div className="loading-line"><i /></div><p>正在打开上游余额面板</p></main>;
}

export function App() {
  const [session, setSession] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [upstreamModal, setUpstreamModal] = useState(false);
  const [editingUpstream, setEditingUpstream] = useState(null);
  const [quickAccountOpen, setQuickAccountOpen] = useState(false);
  const [accountModal, setAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [advancedDraft, setAdvancedDraft] = useState(null);
  const [defaultUpstreamId, setDefaultUpstreamId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('notifications');
  const [busyAccount, setBusyAccount] = useState('');
  const [openingAccount, setOpeningAccount] = useState('');
  const [busyUpstream, setBusyUpstream] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [toasts, setToasts] = useState([]);

  const pushToast = useCallback((message, tone = 'info') => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4600);
  }, []);

  const loadDashboard = useCallback(async (quiet = false) => {
    try {
      const data = await api.dashboard();
      setDashboard(data);
      return data;
    } catch (error) {
      if (error.status === 401) setSession((current) => ({ ...current, authenticated: false, authRequired: true }));
      else if (!quiet) pushToast(error.message, 'error');
      return null;
    }
  }, [pushToast]);

  useEffect(() => {
    api.session().then(async (value) => {
      setSession(value);
      if (value.authenticated) await loadDashboard();
    }).catch((error) => {
      setSession({ authenticated: false, authRequired: true });
      setLoginError(error.message);
    });
  }, [loadDashboard]);

  useEffect(() => {
    if (!session?.authenticated) return undefined;
    const timer = setInterval(() => loadDashboard(true), 30000);
    return () => clearInterval(timer);
  }, [session?.authenticated, loadDashboard]);

  const finishAuthentication = async () => {
    const nextSession = await api.session();
    setSession(nextSession);
    await loadDashboard();
    return nextSession;
  };

  const setupAdmin = async (payload) => {
    setLoginBusy(true); setLoginError('');
    try {
      await api.setupAdmin(payload);
      await finishAuthentication();
      return { success: true };
    } catch (error) {
      setLoginError(error.message);
      return null;
    } finally {
      setLoginBusy(false);
    }
  };

  const login = async (payload) => {
    setLoginBusy(true); setLoginError('');
    try {
      const result = await api.login(payload);
      if (result.requiresTwoFactor) return result;
      await finishAuthentication();
      return result;
    } catch (error) {
      setLoginError(error.message);
      return null;
    } finally {
      setLoginBusy(false);
    }
  };

  const verifyTwoFactor = async (payload) => {
    setLoginBusy(true); setLoginError('');
    try {
      const result = await api.verifyTwoFactor(payload);
      await finishAuthentication();
      return result;
    } catch (error) {
      setLoginError(error.message);
      return null;
    } finally {
      setLoginBusy(false);
    }
  };

  const logout = async () => {
    await api.logout();
    setSession(await api.session());
    setDashboard(null);
  };

  const refreshAccount = async (id) => {
    setBusyAccount(id);
    try {
      const result = await api.refreshAccount(id);
      setDashboard(result.dashboard);
      pushToast('余额已同步并完成阈值检查', 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusyAccount('');
    }
  };

  const refreshUpstream = async (upstreamId) => {
    const accounts = dashboard.accounts.filter((account) => account.upstreamId === upstreamId && !account.demo);
    if (!accounts.length) return;
    setBusyUpstream(upstreamId);
    try {
      const results = await Promise.allSettled(accounts.map((account) => api.refreshAccount(account.id)));
      await loadDashboard(true);
      const failed = results.filter((result) => result.status === 'rejected').length;
      pushToast(failed ? `同步完成，${failed} 个账号失败` : '该上游所有账号已同步', failed ? 'warning' : 'success');
    } finally {
      setBusyUpstream('');
    }
  };

  const openAccountUpstream = async (account) => {
    setOpeningAccount(account.id);
    try {
      const request = api.openAccountUpstream(account.id);
      const popup = dashboard.browserWorkspaceUrl
        ? window.open(dashboard.browserWorkspaceUrl, 'frosted-upstream-browser', 'noopener,noreferrer')
        : null;
      if (dashboard.browserWorkspaceUrl) {
        const ticket = await api.browserTicket().catch(() => null);
        if (ticket?.url && popup && !popup.closed) popup.location.href = ticket.url;
      }
      const job = await request;
      pushToast(job.status === 'opened' ? '已切换到原上游浏览器窗口' : '正在用原浏览器登录态打开上游', 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setOpeningAccount('');
    }
  };

  const acknowledge = async (id) => {
    try {
      setDashboard(await api.acknowledge(id));
      pushToast('告警已确认，系统继续等待余额恢复', 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    }
  };

  const openUpstreamModal = (upstream = null) => {
    setEditingUpstream(upstream);
    setUpstreamModal(true);
  };
  const closeUpstreamModal = () => {
    setUpstreamModal(false);
    setEditingUpstream(null);
  };
  const upstreamSaved = async (upstream, created) => {
    setDefaultUpstreamId(upstream.id);
    await loadDashboard();
    if (created) setQuickAccountOpen(true);
  };
  const upstreamDeleted = async () => loadDashboard();

  const addAccount = (upstreamId) => {
    setDefaultUpstreamId(upstreamId);
    setQuickAccountOpen(true);
  };
  const openEditAccount = (account) => {
    setDefaultUpstreamId(account.upstreamId);
    setEditingAccount(account);
    setAdvancedDraft(null);
    setAccountModal(true);
  };
  const openAdvancedAccount = (draft) => {
    setQuickAccountOpen(false);
    setEditingAccount(null);
    setAdvancedDraft(draft);
    setDefaultUpstreamId(draft.upstreamId);
    setAccountModal(true);
  };
  const closeAccountModal = () => {
    setAccountModal(false);
    setEditingAccount(null);
    setAdvancedDraft(null);
  };
  const accountSaved = async () => loadDashboard();
  const accountDeleted = async () => loadDashboard();
  const restoreAccount = async (account) => {
    try {
      await api.restoreAccount(account.id);
      await loadDashboard(true);
      pushToast('账号已恢复并进入待同步状态', 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    }
  };

  if (!session) return <LoadingScreen />;
  if (!session.authenticated) {
    return <><LoginScreen session={session} onSetup={setupAdmin} onLogin={login} onVerifyTwoFactor={verifyTwoFactor} busy={loginBusy} error={loginError} /><Toasts toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} /></>;
  }
  if (!dashboard) return <LoadingScreen />;

  return (
    <div className="single-page-shell">
      <StatusDashboard
        dashboard={dashboard}
        busyAccount={busyAccount}
        openingAccount={openingAccount}
        busyUpstream={busyUpstream}
        onAddUpstream={() => openUpstreamModal()}
        onEditUpstream={openUpstreamModal}
        onAddAccount={addAccount}
        onEditAccount={openEditAccount}
        onRefreshAccount={refreshAccount}
        onOpenUpstream={openAccountUpstream}
        onRefreshUpstream={refreshUpstream}
        onSettings={() => { setSettingsInitialTab('notifications'); setSettingsOpen(true); }}
        onLogout={logout}
        onAcknowledge={acknowledge}
        onLoadKeyDetails={api.accountKeyDetails}
        onRestoreAccount={restoreAccount}
      />
      <UpstreamModal open={upstreamModal} editingUpstream={editingUpstream} proxyPool={dashboard.proxyPool} onClose={closeUpstreamModal} onSaved={upstreamSaved} onDeleted={upstreamDeleted} onOpenProxySettings={() => { closeUpstreamModal(); setSettingsInitialTab('proxy'); setSettingsOpen(true); }} pushToast={pushToast} />
      <QuickAccountModal open={quickAccountOpen} upstreams={dashboard.upstreams} defaultUpstreamId={defaultUpstreamId} browserWorkspaceUrl={dashboard.browserWorkspaceUrl} onClose={() => setQuickAccountOpen(false)} onSaved={accountSaved} onAdvanced={openAdvancedAccount} pushToast={pushToast} />
      <AccountModal open={accountModal} editingAccount={editingAccount} initialDraft={advancedDraft} upstreams={dashboard.upstreams} defaultUpstreamId={defaultUpstreamId} onClose={closeAccountModal} onSaved={accountSaved} onDeleted={accountDeleted} pushToast={pushToast} turnstileSolver={dashboard.turnstileSolver} />
      <SettingsModal open={settingsOpen} settings={dashboard.settings} proxyPool={dashboard.proxyPool} initialTab={settingsInitialTab} session={session} onSessionChanged={async () => setSession(await api.session())} onClose={() => setSettingsOpen(false)} onSaved={(settings) => setDashboard((current) => ({ ...current, settings }))} onProxyPoolChanged={async (proxyPool) => { setDashboard((current) => ({ ...current, proxyPool })); await loadDashboard(true); }} pushToast={pushToast} />
      <Toasts toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </div>
  );
}
