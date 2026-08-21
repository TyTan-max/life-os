import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, MoreHorizontal, NotebookPen, Plus, RefreshCw, Redo2, Save, Undo2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { Note } from '../types';
import { MOBILE_TABS, MOBILE_TAB_LABELS, NAV_SECTIONS, navIconFor } from '../navigation';
import { useIsMobile } from '../hooks/useIsMobile';
import { getFabAction, subscribeFabActions } from '../lib/fabRegistry';
import { Sheet } from './Sheet';

const LONG_PRESS_MS = 500;

export function MobileNav({ page, navigate }: { page: string; navigate: (page: string, tab?: string) => void }) {
  const isMobile = useIsMobile();
  const {
    upsert, undo, redo, canUndo, canRedo, exportBackup,
    syncNow, syncStatus, syncError, lastSyncedAt, isSyncConfigured
  } = useStore();
  const [sheet, setSheet] = useState<'more' | 'capture' | null>(null);
  const [captureText, setCaptureText] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const [radialOpen, setRadialOpen] = useState(false);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);

  // Registration happens in an effect on the destination page, which commits *after* MobileNav's
  // own render for the same navigation — a plain read at render time would show the previous
  // page's action for one frame and then never update, since a Map mutation doesn't itself
  // trigger React to re-render anything. Subscribing is what closes that gap.
  const fabAction = useSyncExternalStore(subscribeFabActions, () => getFabAction(page));

  // A sheet left mounted after a rotate-to-landscape would be stranded with no way back.
  useEffect(() => { if (!isMobile) { setSheet(null); setRadialOpen(false); } }, [isMobile]);
  useEffect(() => { setRadialOpen(false); }, [page]);

  if (!isMobile) return null;

  const closeSheet = () => setSheet(null);

  const capture = async () => {
    const text = captureText.trim();
    if (!text) return;
    await upsert('notes', newRecord<Note>({ title: '', body: text, tags: [], pinned: false }));
    setCaptureText('');
    closeSheet();
  };

  const go = (next: string) => { navigate(next); closeSheet(); };

  const saveNow = () => {
    exportBackup();
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1800);
  };

  return (
    <>
      <nav className="mobile-tabbar" aria-label="Primary">
        {MOBILE_TABS.slice(0, 2).map(target => {
          const Icon = navIconFor(target);
          return (
            <button type="button" key={target} className={`mobile-tab ${page === target ? 'on' : ''}`} onClick={() => go(target)}>
              {Icon && <Icon size={19} />}
              <span>{MOBILE_TAB_LABELS[target] ?? target}</span>
            </button>
          );
        })}

        <button
          type="button"
          className="mobile-fab"
          aria-label={fabAction ? fabAction.label : 'Quick capture'}
          onPointerDown={() => {
            // Nothing to disambiguate: tap and long-press would show the same single option, so
            // a long-press menu is not worth the extra tap here.
            if (!fabAction) return;
            longPressFired.current = false;
            longPressTimer.current = window.setTimeout(() => {
              longPressFired.current = true;
              setRadialOpen(true);
            }, LONG_PRESS_MS);
          }}
          onPointerUp={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } }}
          onPointerLeave={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } }}
          onClick={() => {
            // The long-press timer already opened the radial menu; suppress the click that
            // follows the same press so it doesn't also fire the primary action underneath it.
            if (longPressFired.current) { longPressFired.current = false; return; }
            if (fabAction) fabAction.onTrigger(); else setSheet('capture');
          }}
        >
          <Plus size={24} />
        </button>

        {radialOpen && (
          <>
            <div className="fab-radial-backdrop" onClick={() => setRadialOpen(false)} />
            <div className="fab-radial" role="menu">
              {fabAction && (
                <button
                  type="button"
                  className="fab-radial-item"
                  role="menuitem"
                  onClick={() => { setRadialOpen(false); fabAction.onTrigger(); }}
                >
                  <Plus size={16} /><span>{fabAction.label}</span>
                </button>
              )}
              <button
                type="button"
                className="fab-radial-item"
                role="menuitem"
                onClick={() => { setRadialOpen(false); setSheet('capture'); }}
              >
                <NotebookPen size={16} /><span>Quick capture</span>
              </button>
            </div>
          </>
        )}

        {MOBILE_TABS.slice(2).map(target => {
          const Icon = navIconFor(target);
          return (
            <button type="button" key={target} className={`mobile-tab ${page === target ? 'on' : ''}`} onClick={() => go(target)}>
              {Icon && <Icon size={19} />}
              <span>{MOBILE_TAB_LABELS[target] ?? target}</span>
            </button>
          );
        })}

        {/* Also lights up while on any page that lives under More, so the bar always shows
            where you are rather than going blank on 12 of the 15 screens. */}
        <button
          type="button"
          className={`mobile-tab ${sheet === 'more' || !MOBILE_TABS.includes(page) ? 'on' : ''}`}
          onClick={() => setSheet(sheet === 'more' ? null : 'more')}
          aria-expanded={sheet === 'more'}
        >
          <MoreHorizontal size={19} />
          <span>More</span>
        </button>
      </nav>

      {sheet === 'capture' && (
        <Sheet title="Quick capture" onClose={closeSheet}>
          <textarea
            className="sheet-capture"
            autoFocus
            rows={5}
            placeholder="Dump a thought, link, or task…"
            value={captureText}
            onChange={e => setCaptureText(e.target.value)}
          />
          <button type="button" className="btn primary full" onClick={() => void capture()} disabled={!captureText.trim()}>
            Capture to Inbox
          </button>
        </Sheet>
      )}

      {sheet === 'more' && (
        <Sheet title="All screens" onClose={closeSheet}>
          {NAV_SECTIONS.map((section, i) => (
            <div className="sheet-group" key={section.label || `group-${i}`}>
              {section.label && <span className="sheet-group-label">{section.label}</span>}
              <div className="sheet-links">
                {section.items.map(item => (
                  <button
                    type="button"
                    key={item.page}
                    className={`sheet-link ${page === item.page ? 'on' : ''}`}
                    onClick={() => go(item.page)}
                  >
                    <item.icon size={17} />
                    <span>{item.page}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Home for the controls that used to float over content bottom-right. Undo/redo keep a
              permanent, reachable place here for anything older than the toast's window. */}
          <div className="sheet-group">
            <span className="sheet-group-label">Data</span>
            <div className="sheet-actions">
              <button type="button" className="sheet-action" onClick={saveNow}>
                {justSaved ? <Check size={16} /> : <Save size={16} />}
                <span>{justSaved ? 'Saved' : 'Save backup'}</span>
              </button>
              <button type="button" className="sheet-action" disabled={!canUndo} onClick={() => void undo()}>
                <Undo2 size={16} /><span>Undo</span>
              </button>
              <button type="button" className="sheet-action" disabled={!canRedo} onClick={() => void redo()}>
                <Redo2 size={16} /><span>Redo</span>
              </button>
              <button
                type="button"
                className="sheet-action"
                disabled={!isSyncConfigured || syncStatus === 'syncing'}
                onClick={() => void syncNow(true)}
                title={!isSyncConfigured ? 'Google Drive sync isn’t configured' : syncStatus === 'error' ? syncError ?? undefined : undefined}
              >
                <RefreshCw size={16} className={syncStatus === 'syncing' ? 'sheet-action-spin' : ''} />
                <span>
                  {syncStatus === 'syncing' ? 'Syncing…'
                    : syncStatus === 'error' ? 'Sync failed'
                    : lastSyncedAt ? `Synced ${new Date(lastSyncedAt).toLocaleTimeString()}`
                    : 'Sync now'}
                </span>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
