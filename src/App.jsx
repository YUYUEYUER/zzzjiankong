import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from './api.js';
import { AccountModal } from './components/AccountModal.jsx';
import { AccountWorkspace } from './components/AccountWorkspace.jsx';
import { IncidentQueue } from './components/IncidentQueue.jsx';
import { Inspector } from './components/Inspector.jsx';
import { LoginScreen } from './components/LoginScreen.jsx';
import { IconRail, TopBar } from './components/Navigation.jsx';
import { SettingsModal } from './components/SettingsModal.jsx';
import { UpstreamList } from './components/UpstreamList.jsx';
import { UpstreamModal } from './components/UpstreamModal.jsx';
import { UpstreamOverview } from './components/UpstreamOverview.jsx';

function Toasts({ toasts, dismiss }) {
  const icons = { success: CheckCircle, warning: WarningCircle, error: WarningCircle, info: Info };
  return (
    <div className="toast-stack">
      <AnimatePresence>
        {toasts.map((toast) => {
          const Icon = icons[toast.tone] || Info;
          return (
            <motion.div className={`toast ${toast.tone}`} key={toast.id} initial={{ opacity: 0, x: 24, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 18 }}>
              <Icon size={19} weight="fill" /><span>{toast.message}</span><button onClick={() => dismiss(toast.id)}><X size={15} /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><div className="brand-mark large"><span>霜</span></div><div className="loading-line"><i /></div><p>正在打开上游工作台</p></main>;
}

export function App() {
  const [session, setSession] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [selectedUpstreamId, setSelectedUpstreamId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [activeNav, setActiveNav] = useState('upstreams');
  const [queueFilter, setQueueFilter] = useState('all');
  const [showDemo, setShowDemo] = useState(false);
  const [upstreamModal, setUpstreamModal] = useState(false);
  const [editingUpstream, setEditingUpstream] = useState(null);
  const [accountModal, setAccountModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [defaultUpstreamId, setDefaultUpstreamId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyAccount, setBusyAccount] = useState('');
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
      const preferredUpstream = data.upstreams.find((upstream) => upstream.realAccountCount > 0) || data.upstreams[0];
      setSelectedUpstreamId((current) => current && data.upstreams.some((upstream) => upstream.id === current) ? current : preferredUpstream?.id || '');
      setSelectedId((current) => current && data.accounts.some((account) => account.id === current)
        ? current
        : data.accounts.find((account) => account.upstreamId === preferredUpstream?.id)?.id || data.accounts[0]?.id || '');
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
    }).catch((error) => { setSession({ authenticated: false, authRequired: true }); setLoginError(error.message); });
  }, [loadDashboard]);

  useEffect(() => {
    if (!session?.authenticated) return undefined;
    const timer = setInterval(() => loadDashboard(true), 30000);
    return () => clearInterval(timer);
  }, [session?.authenticated, loadDashboard]);

  useEffect(() => {
    if (!dashboard || !selectedUpstreamId) return;
    const belongs = dashboard.accounts.some((account) => account.id === selectedId && account.upstreamId === selectedUpstreamId);
    if (!belongs) setSelectedId(dashboard.accounts.find((account) => account.upstreamId === selectedUpstreamId)?.id || '');
  }, [dashboard, selectedUpstreamId, selectedId]);

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
    } catch (error) { setLoginError(error.message); return null; }
    finally { setLoginBusy(false); }
  };

  const login = async (payload) => {
    setLoginBusy(true); setLoginError('');
    try {
      const result = await api.login(payload);
      if (result.requiresTwoFactor) return result;
      await finishAuthentication();
      return result;
    } catch (error) { setLoginError(error.message); return null; }
    finally { setLoginBusy(false); }
  };

  const verifyTwoFactor = async (payload) => {
    setLoginBusy(true); setLoginError('');
    try {
      const result = await api.verifyTwoFactor(payload);
      await finishAuthentication();
      return result;
    } catch (error) { setLoginError(error.message); return null; }
    finally { setLoginBusy(false); }
  };

  const logout = async () => {
    await api.logout();
    setSession(await api.session());
    setDashboard(null);
  };

  const filteredAccounts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return dashboard?.accounts || [];
    const upstreamNames = new Map((dashboard?.upstreams || []).map((upstream) => [upstream.id, upstream.name]));
    return dashboard.accounts.filter((account) => [account.name, account.baseUrl, account.region, account.type, upstreamNames.get(account.upstreamId)].some((value) => String(value || '').toLowerCase().includes(needle)));
  }, [dashboard?.accounts, dashboard?.upstreams, search]);

  const filteredUpstreams = useMemo(() => {
    if (!dashboard) return [];
    const hasReal = dashboard.upstreams.some((upstream) => upstream.realAccountCount > 0);
    const needle = search.trim().toLowerCase();
    return dashboard.upstreams.filter((upstream) => {
      if (!showDemo && hasReal && upstream.realAccountCount === 0 && upstream.demoAccountCount > 0) return false;
      if (!needle) return true;
      const memberText = dashboard.accounts.filter((account) => account.upstreamId === upstream.id).map((account) => `${account.name} ${account.baseUrl} ${account.region}`).join(' ');
      return [upstream.name, ...(upstream.baseUrls || []), ...(upstream.platforms || []), memberText].some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [dashboard, search, showDemo]);

  const selectedUpstream = dashboard?.upstreams.find((upstream) => upstream.id === selectedUpstreamId) || filteredUpstreams[0];
  const selectedAccount = dashboard?.accounts.find((account) => account.id === selectedId && account.upstreamId === selectedUpstream?.id)
    || filteredAccounts.find((account) => account.upstreamId === selectedUpstream?.id)
    || dashboard?.accounts.find((account) => account.upstreamId === selectedUpstream?.id);

  const refreshAccount = async (id) => {
    setBusyAccount(id);
    try {
      const result = await api.refreshAccount(id);
      setDashboard(result.dashboard);
      pushToast('余额已同步并完成阈值检查', 'success');
    } catch (error) { pushToast(error.message, 'error'); }
    finally { setBusyAccount(''); }
  };

  const simulateRecharge = async (id) => {
    setBusyAccount(id);
    try {
      const data = await api.simulateRecharge(id);
      setDashboard(data);
      pushToast('已模拟充值，两次恢复检测完成，事件自动结单', 'success');
    } catch (error) { pushToast(error.message, 'error'); }
    finally { setBusyAccount(''); }
  };

  const refreshUpstream = async (upstreamId) => {
    const accounts = dashboard.accounts.filter((account) => account.upstreamId === upstreamId);
    if (!accounts.length) return;
    setBusyUpstream(upstreamId);
    try {
      const results = await Promise.allSettled(accounts.map((account) => api.refreshAccount(account.id)));
      await loadDashboard(true);
      const failed = results.filter((result) => result.status === 'rejected').length;
      pushToast(failed ? `上游同步完成，${failed} 个账号失败` : '该上游所有账号已同步', failed ? 'warning' : 'success');
    } finally {
      setBusyUpstream('');
    }
  };

  const acknowledge = async (id) => {
    try { setDashboard(await api.acknowledge(id)); pushToast('事件已确认，继续等待余额恢复', 'success'); }
    catch (error) { pushToast(error.message, 'error'); }
  };

  const selectUpstream = (id) => {
    setSelectedUpstreamId(id);
    setSelectedId(dashboard.accounts.find((account) => account.upstreamId === id)?.id || '');
  };
  const openUpstream = (id) => { selectUpstream(id); setActiveNav('accounts'); };
  const openAccountFromIncident = (id) => {
    const account = dashboard.accounts.find((item) => item.id === id);
    if (!account) return;
    setSelectedUpstreamId(account.upstreamId);
    setSelectedId(account.id);
    setActiveNav('accounts');
  };
  const openUpstreamModal = (upstream = null) => { setEditingUpstream(upstream); setUpstreamModal(true); };
  const closeUpstreamModal = () => { setUpstreamModal(false); setEditingUpstream(null); };
  const upstreamSaved = async (upstream, created) => {
    setSelectedUpstreamId(upstream.id);
    setDefaultUpstreamId(upstream.id);
    await loadDashboard();
    if (created) {
      setEditingAccount(null);
      setAccountModal(true);
    }
  };
  const upstreamDeleted = async (id) => {
    if (selectedUpstreamId === id) setSelectedUpstreamId('');
    await loadDashboard();
  };
  const addAccount = (upstreamId) => {
    setDefaultUpstreamId(upstreamId);
    setEditingAccount(null);
    setAccountModal(true);
  };
  const openEdit = (account) => { setDefaultUpstreamId(account.upstreamId); setEditingAccount(account); setAccountModal(true); };
  const closeAccountModal = () => { setAccountModal(false); setEditingAccount(null); };
  const accountSaved = async (account) => { setSelectedUpstreamId(account.upstreamId); setSelectedId(account.id); await loadDashboard(); setActiveNav('accounts'); };

  const navigate = (target) => {
    if (target === 'settings') { setSettingsOpen(true); return; }
    setActiveNav(target);
  };

  if (!session) return <LoadingScreen />;
  if (!session.authenticated) return <><LoginScreen session={session} onSetup={setupAdmin} onLogin={login} onVerifyTwoFactor={verifyTwoFactor} busy={loginBusy} error={loginError} /><Toasts toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} /></>;
  if (!dashboard) return <LoadingScreen />;

  return (
    <div className="app-shell">
      <IconRail active={activeNav} onNavigate={navigate} />
      <TopBar
        summary={dashboard.summary}
        search={search}
        setSearch={setSearch}
        onAddUpstream={() => openUpstreamModal()}
        onNotifications={() => setActiveNav('incidents')}
        onLogout={logout}
        syncing={Boolean(busyAccount || busyUpstream)}
      />
      {activeNav === 'upstreams' && (
        <UpstreamOverview
          upstreams={filteredUpstreams}
          accounts={dashboard.accounts}
          hasDemo={dashboard.upstreams.some((upstream) => upstream.demoAccountCount > 0)}
          showDemo={showDemo}
          setShowDemo={setShowDemo}
          onOpen={openUpstream}
          onEdit={openUpstreamModal}
          onAddAccount={addAccount}
          onAddUpstream={() => openUpstreamModal()}
          onRefresh={refreshUpstream}
          busyUpstream={busyUpstream}
        />
      )}
      {activeNav === 'accounts' && (
        <div className="dashboard-grid">
          <UpstreamList
            upstreams={filteredUpstreams.some((upstream) => upstream.id === selectedUpstream?.id) ? filteredUpstreams : selectedUpstream ? [selectedUpstream, ...filteredUpstreams] : filteredUpstreams}
            accounts={filteredAccounts}
            selectedUpstreamId={selectedUpstream?.id}
            selectedAccountId={selectedAccount?.id}
            onSelectUpstream={selectUpstream}
            onSelectAccount={setSelectedId}
            onAddUpstream={() => openUpstreamModal()}
            onEditUpstream={openUpstreamModal}
            onAddAccount={addAccount}
          />
          <AccountWorkspace
            account={selectedAccount}
            upstream={selectedUpstream}
            snapshots={dashboard.snapshots}
            onRefresh={refreshAccount}
            onEdit={openEdit}
            onRecharge={simulateRecharge}
            busy={busyAccount === selectedAccount?.id}
            pushToast={pushToast}
          />
          <Inspector account={selectedAccount} incidents={dashboard.incidents} settings={dashboard.settings} onOpenIncidents={() => setActiveNav('incidents')} />
        </div>
      )}
      {activeNav === 'incidents' && (
        <div className="queue-page">
          <IncidentQueue
            incidents={dashboard.incidents}
            filter={queueFilter}
            setFilter={setQueueFilter}
            onAcknowledge={acknowledge}
            onSelectAccount={openAccountFromIncident}
            onRefresh={() => loadDashboard()}
          />
        </div>
      )}
      <UpstreamModal open={upstreamModal} editingUpstream={editingUpstream} onClose={closeUpstreamModal} onSaved={upstreamSaved} onDeleted={upstreamDeleted} pushToast={pushToast} />
      <AccountModal open={accountModal} editingAccount={editingAccount} upstreams={dashboard.upstreams} defaultUpstreamId={defaultUpstreamId || selectedUpstream?.id} onClose={closeAccountModal} onSaved={accountSaved} pushToast={pushToast} turnstileSolver={dashboard.turnstileSolver} />
      <SettingsModal open={settingsOpen} settings={dashboard.settings} session={session} onSessionChanged={async () => setSession(await api.session())} onClose={() => setSettingsOpen(false)} onSaved={(settings) => setDashboard((current) => ({ ...current, settings }))} pushToast={pushToast} />
      <Toasts toasts={toasts} dismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
    </div>
  );
}
