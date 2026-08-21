import { useEffect, useState } from 'react';
import { Undo2, X } from 'lucide-react';
import { useStore } from '../store';

const VISIBLE_MS = 6000;

// Surfaces immediately after a destructive change so undo is reachable without a keyboard —
// on touch there is no Ctrl+Z, and the floating history controls sit outside the thumb zone.
export function UndoToast() {
  const { lastDestructive, dismissDestructive, undo, canUndo } = useStore();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!lastDestructive) return;
    setLeaving(false);
    const hide = window.setTimeout(() => setLeaving(true), VISIBLE_MS);
    const clear = window.setTimeout(() => dismissDestructive(), VISIBLE_MS + 200);
    return () => { window.clearTimeout(hide); window.clearTimeout(clear); };
    // Keyed on `at` so deleting twice in a row restarts the timer rather than letting the
    // first deletion's timeout cut the second toast short.
  }, [lastDestructive?.at, lastDestructive, dismissDestructive]);

  if (!lastDestructive) return null;

  return (
    <div className={`undo-toast ${leaving ? 'leaving' : ''}`} role="status" aria-live="polite">
      <span className="undo-toast-label">{lastDestructive.label}</span>
      <button type="button" className="undo-toast-action" onClick={() => void undo()} disabled={!canUndo}>
        <Undo2 size={14} /> Undo
      </button>
      <button type="button" className="undo-toast-close" onClick={dismissDestructive} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
