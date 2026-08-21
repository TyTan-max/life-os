import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

// Bottom sheet — the mobile counterpart to Modal. Anchored to the bottom edge so its controls
// land in the thumb zone, and dismissable by backdrop tap or Escape.
export function Sheet({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <span className="sheet-grabber" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>
        {children}
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>
  );
}
