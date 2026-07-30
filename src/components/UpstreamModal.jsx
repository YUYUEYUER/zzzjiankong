import { useEffect, useState } from 'react';
import { ArrowClockwise, CheckCircle, GlobeHemisphereWest, SpinnerGap, Trash, WarningCircle } from '@phosphor-icons/react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

export function UpstreamModal({ open, editingUpstream, proxyPool, onClose, onSaved, onDeleted, onOpenProxySettings, pushToast }) {
  const [name, setName] = useState('');
  const [proxyMode, setProxyMode] = useState('direct');
  const [busy, setBusy] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editingUpstream?.name || '');
    setProxyMode(editingUpstream?.proxyMode || 'direct');
    setBusy('');
    setConfirmDelete(false);
  }, [open, editingUpstream]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy('save');
    try {
      const result = editingUpstream
        ? await api.updateUpstream(editingUpstream.id, { name, proxyMode })
        : await api.createUpstream({ name, proxyMode });
      pushToast(editingUpstream ? '上游配置已更新' : '上游已创建，可以继续添加监控账号', 'success');
      onSaved(result.upstream, !editingUpstream);
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const reassign = async () => {
    setBusy('reassign');
    try {
      const result = await api.reassignUpstreamProxy(editingUpstream.id);
      pushToast(`已固定到 ${result.upstream.proxyNodeName}`, 'success');
      onSaved(result.upstream, false);
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const proxyReady = Boolean(proxyPool?.subscription?.configured && proxyPool?.summary?.available > 0);
  const proxyStatus = editingUpstream?.proxyStatus || 'unchecked';

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy('delete');
    try {
      await api.deleteUpstream(editingUpstream.id);
      pushToast('空上游已删除', 'success');
      onDeleted(editingUpstream.id);
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editingUpstream ? '编辑上游' : '添加上游'}
      width={520}
    >
      <form className="upstream-form" onSubmit={submit}>
        <label>
          <span>上游名称</span>
          <input autoFocus required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 newapi、sub2api" />
        </label>
        <div className="upstream-proxy-section">
          <div className="upstream-proxy-title"><GlobeHemisphereWest size={19} /><div><strong>代理出口</strong><small>同一上游的账号共用固定出口</small></div></div>
          <div className="proxy-mode-segmented">
            <button type="button" className={proxyMode === 'direct' ? 'active' : ''} onClick={() => setProxyMode('direct')}>直连</button>
            <button type="button" className={proxyMode === 'auto_sticky' ? 'active' : ''} disabled={!proxyReady} onClick={() => setProxyMode('auto_sticky')}>自动优选并固定</button>
          </div>
          {!proxyReady && <button type="button" className="proxy-settings-link" onClick={onOpenProxySettings}>代理池尚未就绪，去导入订阅</button>}
          {editingUpstream?.proxyMode === 'auto_sticky' && editingUpstream.proxyNodeName && (
            <div className="upstream-proxy-assignment">
              <span className={`proxy-node-state ${proxyStatus}`}>{proxyStatus === 'unavailable' ? <WarningCircle weight="fill" /> : <CheckCircle weight="fill" />} {editingUpstream.proxyNodeName}</span>
              <small>{editingUpstream.proxyLatencyMs == null ? '未检测延迟' : `${editingUpstream.proxyLatencyMs} ms`}</small>
              <button type="button" className="secondary-button compact" onClick={reassign} disabled={Boolean(busy)}>{busy === 'reassign' ? <SpinnerGap className="spin" /> : <ArrowClockwise size={15} />} 重新分配</button>
            </div>
          )}
        </div>
        <footer className="modal-actions upstream-modal-actions">
          <div>
            {editingUpstream?.accountCount === 0 && (
              <button type="button" className={`danger-text-button ${confirmDelete ? 'confirming' : ''}`} onClick={remove} disabled={Boolean(busy)}>
                {busy === 'delete' ? <SpinnerGap className="spin" /> : <Trash size={16} />}
                {confirmDelete ? '再次点击确认删除' : '删除空上游'}
              </button>
            )}
          </div>
          <div>
            <button type="button" className="ghost-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={Boolean(busy) || !name.trim()}>
              {busy === 'save' && <SpinnerGap className="spin" />}
              {editingUpstream ? '保存配置' : '创建并添加账号'}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
