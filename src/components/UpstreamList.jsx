import { CaretDown, PencilSimple, Plus } from '@phosphor-icons/react';
import { money, statusLabels } from '../lib.js';

export function UpstreamList({ upstreams, accounts, selectedUpstreamId, selectedAccountId, onSelectUpstream, onSelectAccount, onAddUpstream, onEditUpstream, onAddAccount }) {
  return (
    <aside className="upstream-list glass-surface">
      <header className="panel-title-row">
        <h2>上游</h2>
        <button className="icon-button" onClick={onAddUpstream} title="添加上游" aria-label="添加上游"><Plus size={18} /></button>
      </header>
      <div className="upstream-tree">
        {upstreams.map((upstream) => {
          const members = accounts.filter((account) => account.upstreamId === upstream.id);
          const selected = selectedUpstreamId === upstream.id;
          return (
            <section className={`upstream-list-group ${selected ? 'selected' : ''}`} key={upstream.id}>
              <div className="upstream-list-heading">
                <button className="upstream-select" onClick={() => onSelectUpstream(upstream.id)}>
                  <CaretDown size={14} className={selected ? '' : 'collapsed'} />
                  <i className={`status-dot ${upstream.status}`} title={statusLabels[upstream.status]} />
                  <span><strong>{upstream.name}</strong><small>{members.length} 个账号 · {money(upstream.totalCny)}</small></span>
                </button>
                <button className="icon-button" onClick={() => onEditUpstream(upstream)} title="重命名上游"><PencilSimple size={15} /></button>
              </div>
              {selected && (
                <div className="upstream-account-list">
                  {members.map((account) => (
                    <button key={account.id} className={`account-row ${selectedAccountId === account.id ? 'selected' : ''}`} onClick={() => onSelectAccount(account.id)}>
                      <i className={`status-dot ${account.status}`} title={statusLabels[account.status]} />
                      <span className="account-name">{account.name}</span>
                      <span className="account-money">{money(account.convertedCny)}</span>
                    </button>
                  ))}
                  {members.length === 0 && <div className="empty-upstream-accounts">暂无账号</div>}
                  <button className="add-account-link" onClick={() => onAddAccount(upstream.id)}><Plus size={14} /> 添加账号</button>
                </div>
              )}
            </section>
          );
        })}
        {upstreams.length === 0 && <div className="empty-accounts"><p>暂无上游</p></div>}
      </div>
      <button className="secondary-button add-group" onClick={onAddUpstream}><Plus size={15} /> 添加上游</button>
    </aside>
  );
}
