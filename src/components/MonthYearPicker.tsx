import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 200;
const POPOVER_HEIGHT = 110;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const YEAR_OPTIONS = Array.from({ length: 101 }, (_, i) => 2000 + i);

// A click-to-open month/year jump, portaled to <body> so it never gets clipped by a
// scrolling ancestor. `month` is 0-11. Reused by the Plan Calendar and the Finance
// Budgets month nav so both get the same picker instead of duplicating this logic.
export function MonthYearPicker({
  month, year, onChange, triggerClassName, triggerLabel
}: {
  month: number;
  year: number;
  onChange: (month: number, year: number) => void;
  triggerClassName?: string;
  triggerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openPicker = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
      let top = rect.bottom + 6;
      if (left + POPOVER_WIDTH > window.innerWidth - 8) left = Math.max(8, window.innerWidth - POPOVER_WIDTH - 8);
      if (left < 8) left = 8;
      if (top + POPOVER_HEIGHT > window.innerHeight - 8) top = Math.max(8, rect.top - POPOVER_HEIGHT - 6);
      setPos({ top, left });
    }
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className={triggerClassName ?? 'cal-nav-title'}
        ref={triggerRef}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        {triggerLabel}
      </button>
      {open && createPortal(
        <div className="cal-month-year-popover" ref={popoverRef} style={{ position: 'fixed', top: pos.top, left: pos.left }}>
          <select value={month} onChange={e => onChange(Number(e.target.value), year)} aria-label="Month">
            {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
          </select>
          <select value={year} onChange={e => onChange(month, Number(e.target.value))} aria-label="Year">
            {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>,
        document.body
      )}
    </>
  );
}
