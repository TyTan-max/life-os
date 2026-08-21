import React, { useEffect } from 'react';
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

export function Modal({
  title, eyebrow, onClose, children, footer, size
}: { title: string; eyebrow?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; size?: 'default' | 'wide' }) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
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
