import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Modal } from './UI';
import { useIsMobile } from '../hooks/useIsMobile';

// Right-hand detail pane for desktop: docks beside the page instead of covering it, so the list
// you picked from stays visible and clicking another item just swaps the panel's contents.
// While it's open the page reserves room for it (body.has-detail-panel → main-content padding).
// On a phone there's no room beside anything, so the same props render as the usual Modal.
export function DetailPanel({
  title, eyebrow, onClose, footer, children, onPrev, onNext
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
  /** Arrow-key navigation between neighbouring records while the panel is open. */
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isMobile) return;
    document.body.classList.add('has-detail-panel');
    return () => document.body.classList.remove('has-detail-panel');
  }, [isMobile]);

  useEffect(() => {
    if (isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      // Anything layered above the panel (an edit modal, the command palette) owns the keyboard.
      if (document.querySelector('.modal-overlay, .cmdk-overlay')) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (e.key === 'Escape') { onClose(); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'k') && onPrev) { e.preventDefault(); onPrev(); }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'j') && onNext) { e.preventDefault(); onNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, onClose, onPrev, onNext]);

  if (isMobile) {
    return <Modal eyebrow={eyebrow} title={title} onClose={onClose} footer={footer}>{children}</Modal>;
  }

  return createPortal(
    <aside className="detail-panel" role="complementary" aria-label={title}>
      <div className="detail-panel-header">
        <div className="detail-panel-heading">
          {eyebrow && <span className="eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel" title="Close (Esc)"><X size={17} /></button>
      </div>
      <div className="detail-panel-body">{children}</div>
      {(footer || onPrev || onNext) && (
        <div className="detail-panel-footer">
          {(onPrev || onNext) && <span className="detail-panel-nav-hint"><kbd>←</kbd><kbd>→</kbd> browse</span>}
          <div className="detail-panel-actions">{footer}</div>
        </div>
      )}
    </aside>,
    document.body
  );
}
