import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

const WIDTH = 300;

// A small ⓘ that opens an explanation. Hover shows it on a desktop; a tap toggles it (phones have
// no hover). Portalled with position:fixed so a table's scroll box can't clip it. Closes on a tap
// elsewhere, Escape, or scroll. Clicks are stopped here so an ⓘ inside a <label> or a sortable
// header doesn't also focus the field or re-sort the table.
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [pinned, setPinned] = useState(false);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - WIDTH / 2, window.innerWidth - WIDTH - 8));
    setPos({ top: r.bottom + 6, left });
  };
  const close = () => { setPos(null); setPinned(false); };

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="info-tip-btn"
        aria-label={label}
        aria-expanded={!!pos}
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          if (pinned) close(); else { place(); setPinned(true); }
        }}
        onMouseEnter={() => { if (!pinned && window.matchMedia('(hover: hover)').matches) place(); }}
        onMouseLeave={() => { if (!pinned) setPos(null); }}
      >
        <Info size={13} />
      </button>
      {pos && createPortal(
        <div ref={popRef} className="info-tip-pop" role="tooltip" style={{ top: pos.top, left: pos.left, width: WIDTH }}>
          {children}
        </div>,
        document.body
      )}
    </>
  );
}
