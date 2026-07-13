import { CaretDown, DotsThree, Globe, Plus, Stack } from '@phosphor-icons/react';
import { money, statusLabels } from '../lib.js';

function groupAccounts(accounts) {
  const platforms = new Map();
  for (const account of accounts) {
    const platform = account.type === 'newapi' ? 'New API' : account.type === 'sub2api' ? 'Sub2API' : '自定义';
    if (!platforms.has(platform)) platforms.set(platform, new Map());
    const region = account.subgroup || account.region || '未分组';
    if (!platforms.get(platform).has(region)) platforms.get(platform).set(region, []);
    platforms.get(platform).get(region).push(account);
  }
  return platforms;
}
export function AccountMap({ accounts, selectedId, onSelect, onAdd }) {
  const grouped = groupAccounts(accounts);
  return (
    <aside className="account-map glass-surface">
      <header className="panel-title-row">
        <h2>账户地图</h2>
        <button className="icon-button" aria-label="账户地图菜单"><DotsThree size={20} /></button>
      </header>
      <div className="account-tree">
        {[...grouped.entries()].map(([platform, regions]) => (
          <section className="platform-group" key={platform}>
            <div className="platform-heading">
              <span className="platform-icon">{platform === 'New API' ? <Globe size={16} /> : <Stack size={16} />}</span>
              <strong>{platform}</strong>
              <span>{[...regions.values()].flat().length}</span>
            </div>
            {[...regions.entries()].map(([region, items]) => (
              <div className="region-group" key={region}>
                <div className="region-heading"><CaretDown size={13} /> <span>{region}</span><em>{items.length}</em></div>
                {items.map((account) => (
                  <button key={account.id} className={`account-row ${selectedId === account.id ? 'selected' : ''}`} onClick={() => onSelect(account.id)}>
                    <i className={`status-dot ${account.status}`} title={statusLabels[account.status]} />
                    <span className="account-name">{account.name}</span>
                    <span className="account-money">{money(account.convertedCny)}</span>
                  </button>
                ))}
              </div>
            ))}
          </section>
        ))}
        {accounts.length === 0 && <div className="empty-accounts"><p>还没有上游账号</p><button onClick={onAdd}>添加第一个账号</button></div>}
      </div>
      <button className="secondary-button add-group" onClick={onAdd}><Plus size={15} /> 添加账号</button>
    </aside>
  );
}
