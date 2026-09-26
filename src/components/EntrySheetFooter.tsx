import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';

// Footer for a phone edit sheet over a log entry (sleep, workout, weigh-in, meal). A freshly
// added entry is already saved with sensible defaults, so its sheet offers Discard / Save — a
// way out that doesn't leave a made-up 8h night or 30-minute run in the log. An existing entry
// gets Delete / Done.
export function EntrySheetFooter({ isNew, onRemove, onDone }: { isNew: boolean; onRemove: () => void; onDone: () => void }) {
  return <>
    <button type="button" className="btn ghost danger" onClick={onRemove}>
      <Trash2 size={15} /> {isNew ? 'Discard' : 'Delete'}
    </button>
    <button type="button" className="btn teal" onClick={onDone}>{isNew ? 'Save' : 'Done'}</button>
  </>;
}

// Runs `add` once each time `trigger` turns true (Health's Quick log asking a tab to open a new
// entry), then reports back. Ref-guarded because StrictMode runs mount effects twice in dev.
export function useAutoAdd(trigger: boolean | undefined, add: () => void, onDone?: () => void) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (!trigger) { firedRef.current = false; return; }
    if (firedRef.current) return;
    firedRef.current = true;
    add();
    onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
}
