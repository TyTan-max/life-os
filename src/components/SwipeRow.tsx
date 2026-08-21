import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

export interface SwipeAction {
  label: string;
  icon: ReactNode;
  onTrigger: () => void;
}

const ENGAGE_PX = 10;
const DETENT_RATIO = 0.25;
const COMMIT_RATIO = 0.6;
const REST_OPEN_PX = 88;

// Wraps any row-shaped content with iOS/Android-style swipe actions, built on Pointer Events so
// the same code path drives mouse, touch, and pen. Destructive actions belong on `trailing` —
// every major mobile OS treats that edge as "delete," and putting it there means the muscle
// memory a user already has actually transfers in. Swipe is never the *only* way to reach an
// action: the row underneath stays fully tappable, since a gesture with no visible affordance
// is easy to never discover in the first place.
export function SwipeRow({
  leading, trailing, children, disabled
}: { leading?: SwipeAction; trailing?: SwipeAction; children: ReactNode; disabled?: boolean }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);
  const widthRef = useRef(1);
  const wrapRef = useRef<HTMLDivElement>(null);

  if (disabled || (!leading && !trailing)) return <>{children}</>;

  const reset = () => { setDx(0); setDragging(false); draggingRef.current = false; startRef.current = null; };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    startRef.current = { x: e.clientX, y: e.clientY };
    widthRef.current = wrapRef.current?.clientWidth || 1;
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const ddx = e.clientX - startRef.current.x;
    const ddy = e.clientY - startRef.current.y;
    if (!draggingRef.current) {
      // Horizontal displacement has to clearly lead vertical before the row claims the
      // gesture — otherwise an ordinary vertical scroll through the list gets hijacked the
      // instant a finger drifts a few pixels sideways.
      if (Math.abs(ddx) > ENGAGE_PX && Math.abs(ddx) > Math.abs(ddy)) {
        draggingRef.current = true;
        setDragging(true);
        // Capture keeps the drag tracking even if the finger strays outside the row's bounds
        // mid-swipe — but it's a nice-to-have, not a correctness requirement, so a pointer id
        // the browser won't let us capture (synthetic events, some edge cases) shouldn't abort
        // the swipe over it.
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
      } else if (Math.abs(ddy) > ENGAGE_PX) {
        startRef.current = null;
        return;
      } else {
        return;
      }
    }
    e.preventDefault();
    let next = ddx;
    if (!leading) next = Math.min(0, next);
    if (!trailing) next = Math.max(0, next);
    setDx(next);
  };

  const finish = () => {
    if (!draggingRef.current) { startRef.current = null; return; }
    const ratio = Math.abs(dx) / widthRef.current;
    if (ratio >= COMMIT_RATIO) {
      if (dx < 0 && trailing) trailing.onTrigger();
      else if (dx > 0 && leading) leading.onTrigger();
      reset();
    } else if (ratio >= DETENT_RATIO) {
      setDx(dx < 0 ? -REST_OPEN_PX : REST_OPEN_PX);
      setDragging(false);
      draggingRef.current = false;
      startRef.current = null;
    } else {
      reset();
    }
  };

  return (
    <div className="swipe-row" ref={wrapRef}>
      {leading && (
        <button type="button" className="swipe-row-action leading" onClick={() => { leading.onTrigger(); reset(); }} tabIndex={-1}>
          {leading.icon}<span>{leading.label}</span>
        </button>
      )}
      {trailing && (
        <button type="button" className="swipe-row-action trailing" onClick={() => { trailing.onTrigger(); reset(); }} tabIndex={-1}>
          {trailing.icon}<span>{trailing.label}</span>
        </button>
      )}
      <div
        className="swipe-row-body"
        style={{ transform: `translateX(${dx}px)`, transition: dragging ? 'none' : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={reset}
      >
        {children}
      </div>
    </div>
  );
}
