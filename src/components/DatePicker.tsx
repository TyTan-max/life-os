import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';

const POPOVER_WIDTH = 260;
const POPOVER_HEIGHT = 320;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface GridCell {
  date: Date;
  iso: string;
  inMonth: boolean;
}

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIso(value?: string): Date {
  if (value) {
    const d = new Date(`${value}T12:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildGrid(year: number, month: number): GridCell[][] {
  const first = new Date(year, month, 1);
  const gridStart = addDays(first, -first.getDay());
  const cells: GridCell[] = Array.from({ length: 42 }, (_, i) => {
    const date = addDays(gridStart, i);
    return { date, iso: toIso(date), inMonth: date.getMonth() === month };
  });
  const weeks: GridCell[][] = [];
  for (let i = 0; i < 42; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function formatDisplay(value?: string): string {
  if (!value) return '';
  const d = parseIso(value);
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

export function DatePicker({
  value, onChange, placeholder, displayLabel, markedDates
}: { value?: string; onChange: (value: string) => void; placeholder?: string; displayLabel?: string; markedDates?: string[] }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => parseIso(value).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => parseIso(value).getMonth());
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const todayIso = toIso(new Date());

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onScrollOrResize = () => setOpen(false);
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

  const weeks = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const yearOptions = useMemo(() => Array.from({ length: 101 }, (_, i) => 2000 + i), []);

  const openPicker = () => {
    const anchor = parseIso(value);
    setViewYear(anchor.getFullYear());
    setViewMonth(anchor.getMonth());
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      let left = rect.left;
      let top = rect.bottom + 6;
      if (left + POPOVER_WIDTH > window.innerWidth - 8) left = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8);
      if (top + POPOVER_HEIGHT > window.innerHeight - 8) top = Math.max(8, rect.top - POPOVER_HEIGHT - 6);
      setPos({ top, left });
    }
    setOpen(true);
  };

  const shiftMonth = (delta: number) => {
    let m = viewMonth + delta;
    let y = viewYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setViewMonth(m);
    setViewYear(y);
  };

  const pick = (cell: GridCell) => {
    onChange(cell.iso);
    setOpen(false);
  };

  return (
    <div className="date-picker" ref={containerRef}>
      <button type="button" className="date-picker-trigger" onClick={() => (open ? setOpen(false) : openPicker())}>
        <span className={value ? '' : 'date-picker-placeholder'}>{displayLabel ?? (value ? formatDisplay(value) : (placeholder ?? 'Select date'))}</span>
        <CalendarIcon size={15} />
      </button>
      {open && createPortal(
        <div className="date-picker-popover" ref={popoverRef} style={{ position: 'fixed', top: pos.top, left: pos.left }}>
          <div className="date-picker-header">
            <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={15} /></button>
            <div className="date-picker-header-selects">
              <select value={viewMonth} onChange={e => setViewMonth(Number(e.target.value))} aria-label="Month">
                {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
              <select value={viewYear} onChange={e => setViewYear(Number(e.target.value))} aria-label="Year">
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month"><ChevronRight size={15} /></button>
          </div>
          <div className="date-picker-grid-header">
            {DAY_LABELS.map((d, i) => <span key={i}>{d}</span>)}
          </div>
          {weeks.map((week, wi) => (
            <div className="date-picker-row" key={wi}>
              {week.map(cell => (
                <button
                  type="button"
                  key={cell.iso}
                  className={`date-picker-cell ${cell.inMonth ? '' : 'other-month'} ${cell.iso === value ? 'selected' : ''} ${cell.iso === todayIso ? 'today' : ''} ${markedDates?.includes(cell.iso) ? 'marked' : ''}`}
                  onClick={() => pick(cell)}
                >
                  {cell.date.getDate()}
                </button>
              ))}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
