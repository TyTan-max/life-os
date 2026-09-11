import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

export function Badge({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`badge${tone ? ` tone-${tone}` : ''}`}>{children}</span>;
}

export function Card({ className, children, style }: { className?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className={`card${className ? ` ${className}` : ''}`} style={style}>{children}</div>;
}

export function Kpi({
  label, value, caption, tone
}: { label: string; value: React.ReactNode; caption?: string; tone?: string }) {
  return (
    <div className={`card kpi tone-${tone || 'default'}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {caption && <small>{caption}</small>}
    </div>
  );
}

export function ProgressBar({ value }: { value: number }) {
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div className="progress-bar">
      <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

export function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr.length <= 10 ? `${dateStr}T12:00:00` : dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="muted empty-state">{children}</p>;
}

// A plain-looking currency input (inherits whatever the surrounding form styles a normal
// <input> as, unlike NumberCell which is styled for a compact grid cell) that fills in a
// trailing decimal on blur — typing "0.4" becomes "0.40" once you leave the field, matching
// how money is actually written, while editing still starts from the plain number so you're
// not stuck deleting trailing zeros first.
export function MoneyInput({
  value, onChange, min = 0
}: { value: number; onChange: (n: number) => void; min?: number }) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => { setText(value.toFixed(2)); }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      step="0.01"
      min={min}
      value={text}
      onFocus={() => {
        const n = Number(text);
        if (!Number.isNaN(n)) setText(String(n));
      }}
      onChange={e => {
        const raw = e.target.value;
        if (raw !== '' && raw !== '-') {
          if (!/^-?\d*\.?\d{0,2}$/.test(raw)) return;
        }
        setText(raw);
        if (raw === '' || raw === '-' || raw.endsWith('.')) return;
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        if (n < min) { setText(String(min)); onChange(min); return; }
        onChange(n);
      }}
      onBlur={() => {
        const n = Number(text);
        setText((Number.isNaN(n) ? min : n).toFixed(2));
      }}
    />
  );
}

export function Modal({
  title, eyebrow, onClose, children, footer, size
}: { title: string; eyebrow?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; size?: 'default' | 'wide' }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Closing on a bare click on the overlay is the whole point (click outside to dismiss), but a
  // click also fires wherever the mouse is released — so dragging a text selection that starts
  // inside the modal and ends past its edge (easy to do selecting the last line of a field) fires
  // a "click" on the overlay too, closing the modal out from under the selection. Only closing
  // when the *mousedown* also started on the bare overlay (not dragged in from the card) keeps
  // click-outside-to-close while leaving an in-progress selection alone.
  const downOnOverlayRef = useRef(false);

  return (
    <div
      className="modal-overlay"
      onMouseDown={e => { downOnOverlayRef.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnOverlayRef.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className={`modal-card ${size === 'wide' ? 'modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            {eyebrow && <span className="modal-eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
