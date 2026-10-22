import { useEffect, useId, useRef } from 'react';
import { X } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'motion/react';

const dialogStack = [];
let originalBodyOverflow;

const focusableSelector = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, iframe, [tabindex], [contenteditable="true"]';

function focusableElements(panel) {
  return [...panel.querySelectorAll(focusableSelector)].filter((element) => (
    element.tabIndex >= 0
    && !element.matches(':disabled')
    && !element.closest('[inert], [hidden], [aria-hidden="true"]')
    && element.getClientRects().length > 0
    && window.getComputedStyle(element).visibility !== 'hidden'
  ));
}

export function Modal({ open, title, subtitle, onClose, children, width = 620, dismissible = true }) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  const wasOpenRef = useRef(false);
  const returnFocusRef = useRef(null);
  const titleId = useId();
  const subtitleId = useId();
  onCloseRef.current = onClose;
  dismissibleRef.current = dismissible;
  // Capture before child autoFocus runs during the opening commit.
  if (open && !wasOpenRef.current) returnFocusRef.current = document.activeElement;
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open || !panelRef.current) return undefined;
    const panel = panelRef.current;
    const returnFocus = returnFocusRef.current;
    const entry = { panel };
    if (!dialogStack.length) {
      originalBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    dialogStack.push(entry);
    const isTopDialog = () => dialogStack.at(-1) === entry;
    const focusFirst = () => {
      const focusable = focusableElements(panel);
      const preferred = focusable.find((element) => element.matches('[autofocus], [data-autofocus], input, textarea, select'));
      (preferred || focusable[0] || panel).focus({ preventScroll: true });
    };
    if (!panel.contains(document.activeElement)) focusFirst();

    const handleKeyDown = (event) => {
      if (!isTopDialog()) return;
      // The native picker owns its keyboard while open. In particular, the
      // first Escape closes the choices; a second Escape closes the dialog.
      if (CSS.supports('selector(select:open)') && panel.querySelector('select:open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (dismissibleRef.current) onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(panel);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusable.includes(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !focusable.includes(active))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    const handleFocusIn = (event) => {
      if (isTopDialog() && !panel.contains(event.target)) focusFirst();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn);

    return () => {
      const wasTopDialog = isTopDialog();
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn);
      const index = dialogStack.indexOf(entry);
      if (index !== -1) dialogStack.splice(index, 1);
      if (!dialogStack.length) document.body.style.overflow = originalBodyOverflow;
      if (!wasTopDialog) return;
      // Allow a replacement dialog to mount before deciding where focus belongs.
      requestAnimationFrame(() => {
        const currentDialog = dialogStack.at(-1)?.panel;
        if (currentDialog && !currentDialog.contains(returnFocus)) return;
        const active = document.activeElement;
        if (active !== document.body && active !== returnFocus && !panel.contains(active)) return;
        if (returnFocus?.isConnected && returnFocus !== document.body && !returnFocus.closest('[inert], [hidden]')) {
          returnFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [open]);

  const close = () => {
    if (dismissibleRef.current && dialogStack.at(-1)?.panel === panelRef.current) onCloseRef.current?.();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={close}>
          <motion.section
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={subtitle ? subtitleId : undefined}
            tabIndex={-1}
            className="modal-panel"
            style={{ '--modal-width': `${width}px` }}
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.99 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <h2 id={titleId}>{title}</h2>
                {subtitle && <p id={subtitleId}>{subtitle}</p>}
              </div>
              <button type="button" className="icon-button" onClick={close} disabled={!dismissible} aria-label="关闭"><X size={18} aria-hidden="true" /></button>
            </header>
            {children}
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
