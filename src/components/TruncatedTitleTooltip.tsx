import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Default: the elements that hold a note's name across Second Brain — list/overview rows put the
// title in a <b>, the All table and project boards use their own classes.
const DEFAULT_SELECTOR = 'b, .sb-all-table-title, .sb-board-card-title';

// One page-wide hover tooltip for names cut off with an ellipsis. Instead of wrapping every place
// a note title renders (there are ~15), it listens for the pointer entering any matching element
// and shows the full text only when that element is actually truncated — a name that already
// fits gets no redundant tooltip. Mouse/trackpad only: touch has no hover to trigger it.
export function TruncatedTitleTooltip({ selector = DEFAULT_SELECTOR, scope = '.main-content, .modal-card' }: {
  selector?: string;
  scope?: string;
}) {
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    let current: HTMLElement | null = null;

    const onOver = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const el = target?.closest<HTMLElement>(selector) ?? null;
      if (el === current) return;
      current = el;
      if (!el || !el.closest(scope)) { setTip(null); return; }
      const text = el.textContent?.trim() ?? '';
      const truncated = el.scrollWidth > el.clientWidth + 1;
      if (!text || !truncated) { setTip(null); return; }
      const rect = el.getBoundingClientRect();
      // Below the name, clamped so a long tooltip never runs off the right edge of the window.
      setTip({ text, top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)) });
    };
    const clear = () => { current = null; setTip(null); };

    document.addEventListener('mouseover', onOver);
    // Scrolling moves the name out from under a fixed-position tooltip; drop it rather than chase.
    window.addEventListener('scroll', clear, true);
    document.addEventListener('mousedown', clear);
    return () => {
      document.removeEventListener('mouseover', onOver);
      window.removeEventListener('scroll', clear, true);
      document.removeEventListener('mousedown', clear);
    };
  }, [selector, scope]);

  return tip ? createPortal(
    <div className="truncated-title-tooltip" role="tooltip" style={{ top: tip.top, left: tip.left }}>{tip.text}</div>,
    document.body
  ) : null;
}
