import { useEffect, useRef, useState } from 'react';

export function NumberCell({
  value, onChange, className, autoFocus, min, decimals
}: { value: number; onChange: (n: number) => void; className?: string; autoFocus?: boolean; min?: number; decimals?: number }) {
  const format = (n: number) => (decimals != null ? n.toFixed(decimals) : String(n));
  const [text, setText] = useState(() => format(value));
  const focusedRef = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  // Only resync from the prop while the field isn't being actively typed into — otherwise this
  // would refire (and reformat mid-keystroke, fighting the cursor) on every keystroke's round
  // trip through parent state, since onChange below commits on every keystroke, not just on blur.
  useEffect(() => { if (!focusedRef.current) setText(format(value)); }, [value, decimals]);
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
        focusedRef.current = true;
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
        focusedRef.current = false;
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

// A set's weight: one number, or two joined by a dash for a superset ("40-50"). "/", "+", ","
// or a space between the two also work (not every phone keypad has a dash) and are saved as "-".
export function parseSetWeight(raw: string): number | string | undefined {
  const parts = raw.trim().split(/\s*[-–—/+,\s]\s*/).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : `${parts[0]}-${parts[1]}`;
}

export function WeightCell({
  value, onChange, className, placeholder
}: { value?: number | string; onChange: (w: number | string | undefined) => void; className?: string; placeholder?: string }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => { setText(value == null ? '' : String(value)); }, [value]);
  return (
    <input
      type="text"
      inputMode="decimal"
      className={`grid-cell-input grid-num ${String(value ?? '').includes('-') ? 'superset' : ''} ${className ?? ''}`}
      value={text}
      placeholder={placeholder}
      title="One weight, or two for a superset: 40-50"
      onChange={e => {
        const raw = e.target.value.replace(/[^0-9.\-–—/+,\s]/g, '');
        setText(raw);
        if (raw.trim() === '') { onChange(undefined); return; }
        // Still typing the second weight ("40-") or a decimal ("42."): wait for the rest.
        if (/[-–—/+,.\s]$/.test(raw)) return;
        onChange(parseSetWeight(raw));
      }}
      onBlur={() => { const parsed = parseSetWeight(text); setText(parsed == null ? '' : String(parsed)); if (parsed !== value) onChange(parsed); }}
    />
  );
}

// `ghost` is last time's note for the same thing (e.g. the previous session's note on an exercise).
// It shows faintly while the box is empty, like a placeholder — but unlike one, it doesn't vanish
// for good when you start typing: while the box is open it's listed underneath, where you can read
// it, select part of it to copy, or pull the whole thing in with "Use it" (or Tab in an empty box)
// and edit from there.
export function NotesCell({
  value, onChange, placeholder = 'Add a note…', ghost
}: { value: string; onChange: (v: string) => void; placeholder?: string; ghost?: string }) {
  const [expanded, setExpanded] = useState(false);
  // Collapsed to one clipped line, `text-overflow: ellipsis` on the textarea itself is easy to
  // miss — this overlays an explicit "..." at the end of the line whenever the note is actually
  // longer than what's visible, so a note isn't silently hidden until you happen to click in.
  const [truncated, setTruncated] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (expanded) { setTruncated(false); return; }
    const el = ref.current;
    setTruncated(!!el && (el.scrollWidth > el.clientWidth + 1 || value.includes('\n')));
  }, [value, expanded]);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setExpanded(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [expanded]);
  const last = ghost?.trim();
  // The "last time" strip is placed against the screen, not the cell: notes columns are narrow and
  // sit inside scrolling tables that would clip anything wider hanging off them.
  const [stripPos, setStripPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useEffect(() => {
    if (!expanded || !last) { setStripPos(null); return; }
    const place = () => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(320, window.innerWidth - 16);
      const left = Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8));
      setStripPos({ top: box.bottom + 4, left, width });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [expanded, last, value]);
  // Empty box: the old note becomes the note. Otherwise it's added on its own line.
  const applyGhost = () => {
    if (!last) return;
    onChange(value.trim() ? `${value.replace(/\s+$/, '')}\n${last}` : last);
    ref.current?.focus();
  };
  return (
    // Open while you're in the box or the "last time" strip. It closes when focus moves somewhere else
    // on the page or you click outside — not merely because the window itself lost focus.
    <div ref={wrapRef} className="grid-notes-wrap" onBlur={e => { const next = e.relatedTarget as Node | null; if (next && !e.currentTarget.contains(next)) setExpanded(false); }}>
      <textarea
        ref={ref}
        className={`grid-cell-input grid-notes-input ${expanded ? 'expanded' : ''}`}
        rows={expanded ? 3 : 1}
        placeholder={last || placeholder}
        value={value}
        title={value || last || undefined}
        onFocus={() => setExpanded(true)}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Tab' && !e.shiftKey && last && !value) { e.preventDefault(); applyGhost(); } }}
      />
      {truncated && <span className="grid-notes-more-dot" title="More text — click to see the full note">...</span>}
      {expanded && last && stripPos && value.trim() !== last && (
        <div className="grid-notes-ghost" tabIndex={-1} style={{ top: stripPos.top, left: stripPos.left, width: stripPos.width }}>
          <span className="grid-notes-ghost-label">Last time</span>
          <span className="grid-notes-ghost-text">{last}</span>
          <button type="button" className="grid-notes-ghost-use" onClick={applyGhost} title={value.trim() ? 'Add last time’s note to this one' : 'Start from last time’s note (Tab)'}>
            {value.trim() ? 'Add it' : 'Use it'}
          </button>
        </div>
      )}
    </div>
  );
}

// A plain number field for the mobile entry sheets. A 0 shows as an empty box (with a faint 0),
// so it never has to be deleted first; clearing the box means 0; and focusing selects what's
// there, so the first digit typed replaces a copied-forward value instead of adding to it.
export function SheetNumberInput({
  value, onChange, inputMode = 'decimal', step
}: { value: number; onChange: (n: number) => void; inputMode?: 'decimal' | 'numeric'; step?: string }) {
  // Typed text is kept as-is while editing, so a partial value like "0." isn't wiped mid-entry.
  const [text, setText] = useState(value === 0 ? '' : String(value));
  const focusedRef = useRef(false);
  useEffect(() => { if (!focusedRef.current) setText(value === 0 ? '' : String(value)); }, [value]);
  return (
    <input
      type="number"
      inputMode={inputMode}
      step={step}
      placeholder="0"
      value={text}
      onFocus={e => { focusedRef.current = true; const el = e.currentTarget; window.setTimeout(() => el.select(), 0); }}
      onBlur={() => { focusedRef.current = false; setText(value === 0 ? '' : String(value)); }}
      onChange={e => { setText(e.target.value); onChange(e.target.value === '' ? 0 : Number(e.target.value)); }}
    />
  );
}
