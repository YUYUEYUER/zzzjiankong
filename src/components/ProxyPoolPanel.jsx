import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowClockwise,
  CheckCircle,
  Eye,
  EyeSlash,
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

const errorHints = {
  PROXY_SUBSCRIPTION_HTML: '请重新复制可用的订阅链接，不要复制网页地址。',
  PROXY_SUBSCRIPTION_INVALID_FORMAT: '请确认链接返回的是 Clash/Mihomo 配置，或包含代理 URI 的订阅内容。',
  PROXY_SUBSCRIPTION_NO_NODES: '请确认订阅仍有节点，并检查订阅服务是否生成了空配置。',
  PROXY_SUBSCRIPTION_HTTP_FAILED: '请确认订阅权限和链接有效期；私有订阅过期后需要重新获取链接。',
  PROXY_SUBSCRIPTION_DNS_FAILED: '请检查域名拼写和服务器 DNS；确认服务器可以解析这个域名。',
  MIHOMO_UNAVAILABLE: '请检查 Mihomo 服务是否启动，服务恢复后再重试。',
  EMPTY_PROXY_POOL: '请确认订阅格式正确，并且至少包含一个代理节点。',
};

function describeError(error) {
  const message = error?.message || '订阅操作失败，请稍后重试';
  const hint = errorHints[error?.body?.code || error?.code];
  return hint ? `${message} ${hint}` : message;
}

export function ProxyPoolPanel({ initialPool, onChanged, pushToast }) {
  const [pool, setPool] = useState(initialPool || null);
  const [url, setUrl] = useState('');
  const [urlVisible, setUrlVisible] = useState(false);
  const [busy, setBusy] = useState('load');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  const loadPool = useCallback(async () => {
    setBusy('load');
    setLoadError('');
    setStatusMessage('正在读取代理池…');
    try {
      const value = await api.proxyPool();
      setPool(value);
      setStatusMessage('代理池已加载');
    } catch (error) {
      const message = describeError(error);
      setLoadError(message);
      setStatusMessage('读取代理池失败');
      pushToast(message, 'error');
    } finally {
      setBusy('');
    }
  }, [pushToast]);

  useEffect(() => {
    let active = true;
    setBusy('load');
    setLoadError('');
    api.proxyPool()
      .then((value) => {
        if (!active) return;
        setPool(value);
        setStatusMessage('代理池已加载');
      })
      .catch((error) => {
        if (!active) return;
        const message = describeError(error);
        setLoadError(message);
        setStatusMessage('读取代理池失败');
        pushToast(message, 'error');
      })
      .finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [pushToast]);

  const apply = (value) => {
    setLoadError('');
    setPool(value);
    onChanged?.(value);
  };

  const importSubscription = async (event) => {
    event.preventDefault();
    const nextUrl = url.trim();
    if (!nextUrl) {
      setFieldError('请填写 Clash 订阅地址');
      setStatusMessage('订阅地址不能为空');
      return;
    }
    setFieldError('');
    setActionError('');
    setBusy('import');
    setStatusMessage('正在下载并验证订阅，请稍候…');
    try {
      const value = await api.importProxySubscription(nextUrl);
      apply(value);
      setUrl('');
      setUrlVisible(false);
      setStatusMessage(`订阅导入成功，${value.summary.available}/${value.summary.total} 个节点可用`);
      pushToast(`订阅已导入，${value.summary.available}/${value.summary.total} 个节点可用`, 'success');
    } catch (error) {
      const message = describeError(error);
      setActionError(message);
      setStatusMessage('订阅导入失败');
      pushToast(message, 'error');
      setPool((current) => current ? { ...current, subscription: { ...current.subscription, lastError: message } } : current);
    } finally {
      setBusy('');
    }
  };

  const run = async (action) => {
    setActionError('');
    setBusy(action);
    setStatusMessage(action === 'refresh' ? '正在更新订阅，请稍候…' : '正在检测全部节点，请稍候…');
    try {
      const value = action === 'refresh' ? await api.refreshProxySubscription() : await api.checkProxyPool();
      apply(value);
      setStatusMessage(action === 'refresh' ? '订阅与节点状态已更新' : '节点检测完成');
      pushToast(action === 'refresh' ? '订阅与节点状态已更新' : '节点检测完成', 'success');
    } catch (error) {
      const message = describeError(error);
      setActionError(message);
      setStatusMessage(action === 'refresh' ? '订阅更新失败' : '节点检测失败');
      pushToast(message, 'error');
      setPool((current) => current ? { ...current, subscription: { ...current.subscription, lastError: message } } : current);
    } finally {
      setBusy('');
    }
  };

  const summary = pool?.summary || { total: 0, available: 0, assigned: 0, lastCheckedAt: null };
  const nodes = useMemo(() => pool?.nodes || [], [pool]);
  const locked = Boolean(busy);
  const subscriptionError = pool?.subscription?.lastError || '';
  const visibleError = actionError || subscriptionError;

  return (
    <section className="proxy-pool-panel" aria-busy={locked} aria-labelledby="proxy-pool-title">
      <div className="proxy-pool-heading">
        <div className="proxy-heading-icon"><GlobeHemisphereWest size={22} /></div>
        <div><h3 id="proxy-pool-title">代理出口管理</h3><p>连接质量优选，按上游固定出口</p></div>
        <span className={`proxy-controller-state ${visibleError ? 'error' : pool?.subscription?.configured ? 'ready' : 'muted'}`}>
          {visibleError ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />}
          {visibleError ? '需要处理' : pool?.subscription?.configured ? '已配置' : '未配置'}
        </span>
      </div>

      <form className="proxy-import-row" onSubmit={importSubscription} noValidate>
        <label htmlFor="proxy-subscription-url">
          <span>Clash 订阅地址</span>
          <div className="proxy-url-input">
            <LinkSimple size={17} aria-hidden="true" />
            <input
              id="proxy-subscription-url"
              name="proxySubscriptionUrl"
              type={urlVisible ? 'url' : 'password'}
              required
              value={url}
              onChange={(event) => { setUrl(event.target.value); if (fieldError) setFieldError(''); }}
              placeholder={pool?.subscription?.configured ? '已加密保存，输入新地址可替换' : 'https://...'}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={`proxy-subscription-help${fieldError ? ' proxy-subscription-url-error' : ''}`}
              autoComplete="url"
            />
            <button type="button" className="proxy-url-toggle" onClick={() => setUrlVisible((visible) => !visible)} aria-label={urlVisible ? '隐藏订阅地址' : '显示订阅地址'} aria-pressed={urlVisible}>
              {urlVisible ? <EyeSlash size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <small id="proxy-subscription-help">仅支持 HTTPS；地址会加密保存，不会在页面和日志中完整显示。</small>
          {fieldError && <small id="proxy-subscription-url-error" className="proxy-field-error" role="alert">{fieldError}</small>}
        </label>
        <button className="primary-button" disabled={locked || !url.trim()} aria-label={busy === 'import' ? '正在导入订阅' : '导入订阅'}>{busy === 'import' ? <SpinnerGap className="spin" /> : <LinkSimple size={16} />} {busy === 'import' ? '正在导入' : '导入订阅'}</button>
        <button type="button" className="secondary-button" disabled={locked || !pool?.subscription?.configured} onClick={() => run('refresh')}>{busy === 'refresh' ? <SpinnerGap className="spin" /> : <ArrowClockwise size={16} />} {busy === 'refresh' ? '正在更新' : '更新订阅'}</button>
        <button type="button" className="secondary-button" disabled={locked || !pool?.subscription?.configured} onClick={() => run('check')}>{busy === 'check' ? <SpinnerGap className="spin" /> : <CheckCircle size={16} />} {busy === 'check' ? '正在检测' : '检测全部'}</button>
      </form>

      {loadError && <div className="proxy-pool-error proxy-pool-load-error" role="alert"><WarningCircle weight="fill" /><div><strong>代理池读取失败</strong><span>{loadError}</span></div><button type="button" className="secondary-button" onClick={loadPool} disabled={locked}>重试</button></div>}
      {visibleError && !loadError && <div className="proxy-pool-error" role="alert"><WarningCircle weight="fill" /><div><strong>{actionError ? '操作未完成' : '订阅需要处理'}</strong><span>{visibleError}</span></div></div>}
      <div className="proxy-pool-status" role="status" aria-live="polite">{statusMessage}</div>

      <div className="proxy-summary-strip">
        <div><span>节点</span><strong>{summary.total}</strong></div>
        <div><span>可用</span><strong>{summary.available}</strong></div>
        <div><span>已分配上游</span><strong>{summary.assigned}</strong></div>
        <div><span>最近检测</span><strong className="time-value">{relativeTime(summary.lastCheckedAt)}</strong></div>
      </div>

      <div className="proxy-node-table-wrap">
        <table className="proxy-node-table">
          <caption>代理节点列表</caption>
          <thead><tr><th scope="col">节点</th><th scope="col">协议</th><th scope="col">状态</th><th scope="col">延迟</th><th scope="col">上游</th><th scope="col">检测时间</th></tr></thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.id}>
                <td><strong>{node.name}</strong></td>
                <td>{node.type || '未知'}</td>
                <td><span className={`proxy-node-state ${node.status}`}><i aria-hidden="true" />{statusLabels[node.status] || node.status}</span></td>
                <td className="tabular">{node.latencyMs == null ? '-' : `${node.latencyMs} ms`}</td>
                <td>{node.assignedUpstreamCount || '-'}</td>
                <td>{relativeTime(node.lastCheckedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!nodes.length && (
          <div className="proxy-pool-empty">
            {busy === 'load' ? <><SpinnerGap className="spin" /> 正在读取代理池</> : loadError ? <><WarningCircle weight="fill" /> 暂时无法读取节点列表</> : pool?.subscription?.configured ? <><WarningCircle /> 订阅已配置，但暂未加载到节点</> : '尚未导入订阅'}
          </div>
        )}
      </div>
    </section>
  );
}
