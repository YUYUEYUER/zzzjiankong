import { useEffect, useState } from 'react';
import { SpinnerGap, Trash } from '@phosphor-icons/react';
import { api } from '../api.js';
import { Modal } from './Modal.jsx';

export function UpstreamModal({ open, editingUpstream, onClose, onSaved, onDeleted, pushToast }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editingUpstream?.name || '');
    setBusy('');
    setConfirmDelete(false);
  }, [open, editingUpstream]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy('save');
    try {
      const result = editingUpstream
        ? await api.updateUpstream(editingUpstream.id, { name })
        : await api.createUpstream({ name });
      pushToast(editingUpstream ? '上游名称已更新' : '上游已创建，可以继续添加监控账号', 'success');
      onSaved(result.upstream, !editingUpstream);
      onClose();
    } catch (error) {
      pushToast(error.message, 'error');
    } finally {
      setBusy('');
    }
  };

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
          <input autoFocus required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 86GameStore、NewCLI" />
        </label>
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
              {editingUpstream ? '保存名称' : '创建并添加账号'}
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}
