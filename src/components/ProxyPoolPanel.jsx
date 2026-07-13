import { useEffect, useMemo, useState } from 'react';
import {
  ArrowClockwise,
  CheckCircle,
  GlobeHemisphereWest,
  LinkSimple,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import { api } from '../api.js';
import { relativeTime } from '../lib.js';

const statusLabels = {
  available: '可用',
  slow: '较慢',
  unavailable: '不可用',
  unchecked: '未检测',
};

export function ProxyPoolPanel({ initialPool, onChanged, pushToast }) {
  const [pool, setPool] = useState(initialPool || null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState('load');

  useEffect(() => {
    let active = true;
    setBusy('load');
    api.proxyPool()
      .then((value) => { if (active) setPool(value); })
      .catch((error) => pushToast(error.message, 'error'))
      .finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [pushToast]);

  const apply = (value) => {
    setPool(value);
    onChanged?.(value);
  };

  const importSubscription = async (event) => {
    event.preventDefault();
    setBusy('import');
    try {
      const value = await api.importProxySubscription(url);
      apply(value);
      setUrl('');
      pushToast(`订阅已导入，${value.summary.available}/${value.summary.total} 个节点可用`, 'success');
    } catch (error) {
      pushToast(error.message, 'error');
      setPool((current) => current ? { ...current, subscription: { ...current.subscription, lastError: error.message } } : current);
    } finally {
      setBusy('');
    }
  };

  const run = async (action) => {
    setBusy(action);
    try {
      const value = action === 'refresh' ? await api.refreshProxySubscription() : await api.checkProxyPool();
      apply(value);
      pushToast(action === 'refresh' ? '订阅与节点状态已更新' : '节点检测完成', 'success');
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const summary = pool?.summary || { total: 0, available: 0, assigned: 0, lastCheckedAt: null };
  const nodes = useMemo(() => pool?.nodes || [], [pool]);
  const locked = Boolean(busy);

  return (
    <section className="proxy-pool-panel">
      <div className="proxy-pool-heading">
        <div className="proxy-heading-icon"><GlobeHemisphereWest size={22} /></div>
        <div><h3>代理出口管理</h3><p>连接质量优选，按上游固定出口</p></div>
        <span className={`proxy-controller-state ${pool?.subscription?.lastError ? 'error' : pool?.subscription?.configured ? 'ready' : 'muted'}`}>
          {pool?.subscription?.lastError ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />}
          {pool?.subscription?.lastError ? '需要处理' : pool?.subscription?.configured ? '已配置' : '未配置'}
        </span>
      </div>

      <form className="proxy-import-row" onSubmit={importSubscription}>
        <label>
          <span>Clash 订阅地址</span>
          <div className="proxy-url-input"><LinkSimple size={17} /><input type="password" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder={pool?.subscription?.configured ? '已加密保存，输入新地址可替换' : 'https://...'} /></div>
        </label>
        <button className="primary-button" disabled={locked || !url.trim()}>{busy === 'import' ? <SpinnerGap className="spin" /> : <LinkSimple size={16} />} 导入订阅</button>
        <button type="button" className="secondary-button" disabled={locked || !pool?.subscription?.configured} onClick={() => run('refresh')}>{busy === 'refresh' ? <SpinnerGap className="spin" /> : <ArrowClockwise size={16} />} 更新订阅</button>
        <button type="button" className="secondary-button" disabled={locked || !pool?.subscription?.configured} onClick={() => run('check')}>{busy === 'check' ? <SpinnerGap className="spin" /> : <CheckCircle size={16} />} 检测全部</button>
      </form>

      {pool?.subscription?.lastError && <div className="proxy-pool-error"><WarningCircle weight="fill" /> {pool.subscription.lastError}</div>}

      <div className="proxy-summary-strip">
        <div><span>节点</span><strong>{summary.total}</strong></div>
        <div><span>可用</span><strong>{summary.available}</strong></div>
        <div><span>已分配上游</span><strong>{summary.assigned}</strong></div>
        <div><span>最近检测</span><strong className="time-value">{relativeTime(summary.lastCheckedAt)}</strong></div>
      </div>

      <div className="proxy-node-table-wrap">
        <table className="proxy-node-table">
          <thead><tr><th>节点</th><th>协议</th><th>状态</th><th>延迟</th><th>上游</th><th>检测时间</th></tr></thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.id}>
                <td><strong>{node.name}</strong></td>
                <td>{node.type || '未知'}</td>
                <td><span className={`proxy-node-state ${node.status}`}><i />{statusLabels[node.status] || node.status}</span></td>
                <td className="tabular">{node.latencyMs == null ? '-' : `${node.latencyMs} ms`}</td>
                <td>{node.assignedUpstreamCount || '-'}</td>
                <td>{relativeTime(node.lastCheckedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!nodes.length && (
          <div className="proxy-pool-empty">
            {busy === 'load' ? <><SpinnerGap className="spin" /> 正在读取代理池</> : '尚未导入订阅'}
          </div>
        )}
      </div>
    </section>
  );
}
