import { useEffect, useRef, useState } from 'react';

export function NumberCell({
  value, onChange, className, autoFocus, min, decimals
}: { value: number; onChange: (n: number) => void; className?: string; autoFocus?: boolean; min?: number; decimals?: number }) {
  const [text, setText] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(String(value)); }, [value]);
  // Fires once on this row's own mount (not on every re-render, since React reconciles by
  // key) — lets a freshly-added row that copied forward a placeholder value get overwritten
  // by the very next keystroke instead of silently keeping the old number if never touched.
  useEffect(() => { if (autoFocus) ref.current?.select(); }, [autoFocus]);
  return (
    <input
      ref={ref}
      type="number"
      className={`grid-cell-input grid-num ${className ?? ''}`}
      value={text}
      min={min}
      onFocus={() => {
        // The .00 formatting from the last blur is a display-only nicety — editing should
        // start from the plain number, not force the user to delete trailing zeros first.
        if (decimals != null && text !== '' && text !== '-') {
          const n = Number(text);
          if (!Number.isNaN(n)) setText(String(n));
        }
      }}
      onChange={e => {
        const raw = e.target.value;
        // Reject (rather than round) keystrokes that would exceed the decimal limit, so typing
        // a 3rd fractional digit is simply a no-op instead of reformatting mid-keystroke and
        // fighting the cursor.
        if (decimals != null && raw !== '' && raw !== '-') {
          const re = new RegExp(`^-?\\d*\\.?\\d{0,${decimals}}$`);
          if (!re.test(raw)) return;
        }
        setText(raw);
        if (raw === '' || raw === '-' || raw.endsWith('.')) return;
        const n = Number(raw);
        if (Number.isNaN(n)) return;
        if (min != null && n < min) {
          setText(String(min));
          onChange(min);
          return;
        }
        onChange(n);
      }}
      onBlur={() => {
        if (decimals != null && text !== '' && text !== '-') {
          const n = Number(text);
          if (!Number.isNaN(n)) setText(n.toFixed(decimals));
        }
      }}
    />
  );
}

// For fields that are legitimately absent (not just zero) — clears to undefined instead of
// pinning to 0, so an unset HR/RPE/macro field doesn't get silently written as a real value.
export function OptionalNumberCell({
  value, onChange, className, placeholder, min, max
}: { value?: number; onChange: (n: number | undefined) => void; className?: string; placeholder?: string; min?: number; max?: number }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => { setText(value == null ? '' : String(value)); }, [value]);
  return (
    <input
      type="number"
      className={`grid-cell-input grid-num ${className ?? ''}`}
      value={text}
      placeholder={placeholder}
      min={min}
      max={max}
      onChange={e => {
        const raw = e.target.value;
        if (raw === '') { setText(raw); onChange(undefined); return; }
        if (raw === '-') { setText(raw); return; }
        let n = Number(raw);
        if (Number.isNaN(n)) { setText(raw); return; }
        if (max != null) n = Math.min(n, max);
        if (min != null) n = Math.max(n, min);
        setText(String(n));
        onChange(n);
      }}
    />
  );
}

export function NotesCell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <textarea
      className={`grid-cell-input grid-notes-input ${expanded ? 'expanded' : ''}`}
      rows={expanded ? 3 : 1}
      placeholder="Add a note…"
      value={value}
      onFocus={() => setExpanded(true)}
      onBlur={() => setExpanded(false)}
      onChange={e => onChange(e.target.value)}
    />
  );
}
