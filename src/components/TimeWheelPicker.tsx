import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock } from 'lucide-react';

const ITEM_HEIGHT = 32;
// The visible list is a finite (non-infinite) array — just the 12/60-value cycle repeated
// several times — so scrolling backward from the start wraps around to the end quickly
// instead of requiring a scroll all the way through the whole range.
const REPEAT = 7;
const MIDDLE_REP = Math.floor(REPEAT / 2);
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const DRAG_CLICK_THRESHOLD = 4;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

interface TimeValue { hour12: number; minute: number; period: 'AM' | 'PM'; }

function parseValue(value?: string): TimeValue | null {
  if (!value) return null;
  const [hStr, mStr] = value.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const period: 'AM' | 'PM' = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute: m, period };
}

function toValue(t: TimeValue): string {
  let h = t.hour12 % 12;
  if (t.period === 'PM') h += 12;
  return `${pad2(h)}:${pad2(t.minute)}`;
}

function formatDisplay(value?: string): string {
  const parsed = parseValue(value);
  if (!parsed) return '';
  return `${parsed.hour12}:${pad2(parsed.minute)} ${parsed.period}`;
}

// Accepts exactly the "H:MM AM/PM" shape (what formatDisplay produces), case-insensitive,
// with flexible spacing. Returns a 24h "HH:mm" value, '' to clear, or null if unparseable.
function parseTyped(text: string): string | '' | null {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 1 || h > 12 || m < 0 || m > 59) return null;
  const period = match[3].toUpperCase() as 'AM' | 'PM';
  return toValue({ hour12: h, minute: m, period });
}

function WheelColumn({
  items, selectedIndex, format, onSettle
}: {
  items: number[];
  selectedIndex: number;
  format: (n: number) => string;
  onSettle: (baseIndex: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settleTimer = useRef<number | null>(null);
  const baseLen = items.length;
  const flat = Array.from({ length: baseLen * REPEAT }, (_, i) => items[i % baseLen]);

  const drag = useRef<{ pointerId: number; startY: number; startScrollTop: number; moved: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Only a genuine user interaction (wheel/trackpad, drag, or item click) may cause a commit —
  // otherwise merely opening the picker would "settle" on whatever value it happened to mount
  // showing (the mount-sync scroll itself fires a 'scroll' event) and silently commit it.
  const hasInteracted = useRef(false);
  const markInteracted = () => { hasInteracted.current = true; };
  // Also suppresses the post-settle re-center's own scroll event from scheduling a redundant settle.
  const suppressSettle = useRef(false);

  const scrollToIndex = (baseIndex: number, smooth: boolean) => {
    const el = ref.current;
    if (!el) return;
    const flatIndex = MIDDLE_REP * baseLen + baseIndex;
    el.scrollTo({ top: flatIndex * ITEM_HEIGHT, behavior: smooth ? 'smooth' : 'auto' });
  };

  const scrollToIndexSilently = (baseIndex: number) => {
    suppressSettle.current = true;
    scrollToIndex(baseIndex, false);
    window.setTimeout(() => { suppressSettle.current = false; }, 200);
  };

  useEffect(() => {
    scrollToIndexSilently(selectedIndex);
    // Only on mount — the popover remounts fresh each time it opens, which is when we want to re-sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { if (settleTimer.current) window.clearTimeout(settleTimer.current); }, []);

  const handleScroll = () => {
    if (suppressSettle.current || !hasInteracted.current) return;
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const flatIndex = Math.round(el.scrollTop / ITEM_HEIGHT);
      const baseIndex = ((flatIndex % baseLen) + baseLen) % baseLen;
      onSettle(baseIndex);
      // Silently re-center within the middle repetition so there's always room to scroll further either way.
      scrollToIndexSilently(baseIndex);
    }, 130);
  };

  // Click-and-drag is more precise than a wheel/trackpad scroll, which tends to overshoot.
  const handlePointerDown = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    markInteracted();
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startScrollTop: el.scrollTop, moved: 0 };
    el.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const state = drag.current;
    const el = ref.current;
    if (!state || !el) return;
    const delta = e.clientY - state.startY;
    state.moved = Math.max(state.moved, Math.abs(delta));
    el.scrollTop = state.startScrollTop - delta;
  };
  const endDrag = () => {
    const el = ref.current;
    if (drag.current && el) {
      try { el.releasePointerCapture(drag.current.pointerId); } catch { /* already released */ }
    }
    drag.current = null;
    setDragging(false);
  };

  return (
    <div
      className={`time-wheel-col ${dragging ? 'dragging' : ''}`}
      ref={ref}
      onScroll={handleScroll}
      onWheel={markInteracted}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="time-wheel-pad" />
      {flat.map((n, i) => (
        <div
          className="time-wheel-item"
          key={i}
          onClick={() => { if ((drag.current?.moved ?? 0) < DRAG_CLICK_THRESHOLD) { markInteracted(); scrollToIndex(i % baseLen, true); } }}
        >
          {format(n)}
        </div>
      ))}
      <div className="time-wheel-pad" />
    </div>
  );
}

export function TimeWheelPicker({
  value, onChange, placeholder
}: { value?: string; onChange: (value: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [draft, setDraft] = useState<TimeValue>(() => parseValue(value) ?? { hour12: 1, minute: 0, period: 'AM' });
  const [textDraft, setTextDraft] = useState(() => formatDisplay(value));
  const isEditingText = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // The draft value last synced FROM the outside (mount, or opening the picker) — draft only
  // triggers onChange once it diverges from this baseline, i.e. once the user actually changes
  // something. A one-shot "skip the first effect run" ref would look right in dev, but React
  // StrictMode deliberately double-invokes effects, and the ref gets consumed by the first of
  // the two invocations — letting the second slip through and fire onChange with nothing typed.
  const syncedFrom = useRef<TimeValue>(draft);

  // Keep the typed text in sync with external value changes (e.g. the wheel picker committing),
  // but never while the user has the text field focused and is actively typing.
  useEffect(() => {
    if (isEditingText.current) return;
    setTextDraft(formatDisplay(value));
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    // Capture-phase scroll also catches the wheel columns' own internal scrollTo() calls
    // (scroll doesn't bubble, but capture-phase listeners still see it) — ignore those.
    const onScrollOrResize = (e: Event) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  const openPicker = () => {
    const initial = parseValue(value) ?? { hour12: 1, minute: 0, period: 'AM' };
    setDraft(initial);
    syncedFrom.current = initial;
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 208;
      const height = 190;
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      setPos({ top, left });
    }
    setOpen(true);
  };

  // setDraft's updater must stay pure (no calling the parent's onChange from inside it) — React
  // may invoke it during render, and updating a different component's state there is a violation.
  // The actual onChange call happens in the effect below, once state has settled, and only if
  // draft has actually diverged from the last-synced baseline (see syncedFrom above).
  useEffect(() => {
    const baseline = syncedFrom.current;
    if (draft.hour12 === baseline.hour12 && draft.minute === baseline.minute && draft.period === baseline.period) return;
    onChange(toValue(draft));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Uses a functional update so two near-simultaneous settles (hour + minute scrolled in
  // quick succession) each merge onto the latest state instead of a stale closed-over `draft`,
  // which would otherwise let whichever settles second silently discard the other's change.
  const commit = (patch: Partial<TimeValue>) => {
    setDraft(prev => ({ ...prev, ...patch }));
  };

  const commitTypedText = () => {
    isEditingText.current = false;
    const parsed = parseTyped(textDraft);
    if (parsed === null) {
      setTextDraft(formatDisplay(value));
      return;
    }
    onChange(parsed);
    setTextDraft(formatDisplay(parsed || undefined));
  };

  return (
    <div className="date-picker time-wheel-trigger" ref={containerRef}>
      <input
        type="text"
        className="time-wheel-text-input"
        value={textDraft}
        placeholder={placeholder ?? '--:-- --'}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => { isEditingText.current = true; setOpen(false); }}
        onChange={e => setTextDraft(e.target.value)}
        onBlur={commitTypedText}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <button
        type="button"
        className="time-wheel-icon-btn"
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-label="Open time picker"
      >
        <Clock size={15} />
      </button>
      {open && createPortal(
        <div className="time-wheel-popover" ref={popoverRef} style={{ position: 'fixed', top: pos.top, left: pos.left }}>
          <div className="time-wheel-cols-wrap">
            <div className="time-wheel-band" />
            <div className="time-wheel-cols">
              <WheelColumn
                items={HOURS}
                selectedIndex={HOURS.indexOf(draft.hour12)}
                format={n => String(n)}
                onSettle={baseIndex => commit({ hour12: HOURS[baseIndex] })}
              />
              <div className="time-wheel-colon">:</div>
              <WheelColumn
                items={MINUTES}
                selectedIndex={draft.minute}
                format={n => pad2(n)}
                onSettle={baseIndex => commit({ minute: baseIndex })}
              />
              <div className="time-wheel-period">
                <button type="button" className={draft.period === 'AM' ? 'active' : ''} onClick={() => commit({ period: 'AM' })}>AM</button>
                <button type="button" className={draft.period === 'PM' ? 'active' : ''} onClick={() => commit({ period: 'PM' })}>PM</button>
              </div>
            </div>
          </div>
          <button type="button" className="time-wheel-clear" onClick={() => { onChange(''); setOpen(false); }}>Clear</button>
        </div>,
        document.body
      )}
    </div>
  );
}
