import {
  Bell,
  CirclesThreePlus,
  GearSix,
  MagnifyingGlass,
  Plus,
  Pulse,
  SignOut,
  SlidersHorizontal,
  Stack,
} from '@phosphor-icons/react';
import { relativeTime } from '../lib.js';

export function IconRail({ active, onNavigate }) {
  const items = [
    ['upstreams', Stack, '上游总览'],
    ['accounts', CirclesThreePlus, '账号详情'],
    ['incidents', Bell, '告警事件'],
  ];
  return (
    <aside className="icon-rail" aria-label="主导航">
      <button className="brand-mark" title="霜镜" onClick={() => onNavigate('overview')}><span>霜</span></button>
      <nav>
        {items.map(([id, Icon, label]) => (
          <button key={id} className={active === id ? 'active' : ''} onClick={() => onNavigate(id)} title={label} aria-label={label}>
            <Icon size={20} weight={active === id ? 'fill' : 'regular'} />
          </button>
        ))}
      </nav>
      <div className="rail-bottom">
        <button onClick={() => onNavigate('settings')} title="系统设置" aria-label="系统设置"><GearSix size={20} /></button>
      </div>
    </aside>
  );
}

export function TopBar({ summary, search, setSearch, onAddUpstream, onNotifications, onLogout, syncing }) {
  return (
    <header className="top-bar glass-surface">
      <div className="workspace-title">
        <span className="workspace-icon"><SlidersHorizontal size={17} weight="bold" /></span>
        <span>上游余额</span>
      </div>
      <label className="global-search">
        <MagnifyingGlass size={17} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索上游、账号或站点地址" />
        <kbd>⌘ K</kbd>
      </label>
      <div className="top-actions">
        <span className={`sync-state ${syncing ? 'syncing' : ''}`}><Pulse size={18} /> {syncing ? '同步中' : '已同步'} · {relativeTime(summary.lastSyncAt)}</span>
        <button className="icon-button notification-button" aria-label="通知" onClick={onNotifications}><Bell size={19} /><i>{summary.openIncidents || 0}</i></button>
        <button className="primary-button" onClick={onAddUpstream}><Plus size={17} weight="bold" /> 添加上游</button>
        <button className="avatar-button" onClick={onLogout} title="退出登录"><span>CH</span><SignOut size={14} /></button>
      </div>
    </header>
  );
}
