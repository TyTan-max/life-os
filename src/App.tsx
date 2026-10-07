import React, { useCallback, useEffect, useState } from 'react';
import { Check, RefreshCw, Redo2, Save, Search, Sparkles, Undo2 } from 'lucide-react';
import { SyncBanner, useSyncDescription } from './components/SyncPanel';
import { useIsMobile } from './hooks/useIsMobile';
import { StoreProvider, useStore } from './store';
import { NAV_SECTIONS } from './navigation';
import { MobileNav } from './components/MobileNav';
import { Dashboard } from './pages/Dashboard';
import { Habits } from './pages/Habits';
import { Calendar } from './pages/Calendar';
import { Movies } from './pages/Movies';
import { Videogames } from './pages/Videogames';
import { Books } from './pages/Books';
import { Finance } from './pages/Finance';
import { TradingJournal } from './pages/TradingJournal';
import { Settings } from './pages/Settings';
import { Research } from './pages/Research';
import { SecondBrain } from './pages/SecondBrain';
import type { ParaTab } from './pages/SecondBrain';
import { HealthWellness } from './pages/HealthWellness';
import { Travel } from './pages/Travel';
import { PersonalCRM } from './pages/PersonalCRM';
import { UndoToast } from './components/UndoToast';
import { CommandPalette, PAGE_SHORTCUT_PAGES, ShortcutsSheet, isTypingTarget } from './components/CommandPalette';

const PAGES: Record<string, React.ComponentType> = {
  Habits, Movies, Videogames, Books,
  Finance, 'Trading Journal': TradingJournal, Settings, Research,
  Health: HealthWellness, 'Travel & Bucket List': Travel,
  'Personal CRM': PersonalCRM
};

function Shell() {
  const { updateSettings, data, loading, undo, redo, canUndo, canRedo, exportBackup, syncNow, syncStatus, isSyncConfigured } = useStore();
  const syncDescription = useSyncDescription();
  const isMobile = useIsMobile();
  const [page, setPage] = useState('Dashboard');
  // A landing tab for pages that have their own internal tabs (currently just Second Brain) —
  // set alongside the page so a specific click-through (e.g. a goal from the Calendar) can open
  // straight to the relevant tab instead of always landing on that page's default view.
  const [navTab, setNavTab] = useState<string | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // A note to open in Second Brain; `n` changes on every request so re-picking the same note
  // (or picking one while Second Brain is already mounted) still takes effect.
  const [focusNote, setFocusNote] = useState<{ id: string; n: number } | undefined>(undefined);
  const navigate = useCallback((next: string, tab?: string) => { setPage(next); setNavTab(tab); }, []);
  const openNote = useCallback((id: string, workspaceId?: string) => {
    if (workspaceId && workspaceId !== data?.settings?.activeSecondBrainWorkspaceId) {
      void updateSettings({ activeSecondBrainWorkspaceId: workspaceId });
    }
    setPage('Second Brain');
    setNavTab(undefined);
    setFocusNote(prev => ({ id, n: (prev?.n ?? 0) + 1 }));
  }, [data?.settings?.activeSecondBrainWorkspaceId, updateSettings]);

  // Global shortcuts: Ctrl+K palette, Alt+1…9 pages, Ctrl+, Settings, ? cheat sheet.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && key === 'k') { e.preventDefault(); setShortcutsOpen(false); setPaletteOpen(o => !o); return; }
      if (mod && !e.altKey && key === ',') { e.preventDefault(); navigate('Settings'); return; }
      if (e.altKey && !mod && /^Digit[1-9]$/.test(e.code)) {
        const target = PAGE_SHORTCUT_PAGES[Number(e.code.slice(5)) - 1];
        if (target) { e.preventDefault(); navigate(target); }
        return;
      }
      if (e.key === '?' && !mod && !e.altKey && !isTypingTarget(document.activeElement) && !document.querySelector('.modal-overlay')) {
        e.preventDefault(); setPaletteOpen(false); setShortcutsOpen(true);
      }
    };
    // Pages can open the palette too (e.g. Second Brain's "Jump to…" button).
    const openPalette = () => { setShortcutsOpen(false); setPaletteOpen(true); };
    window.addEventListener('keydown', handler);
    window.addEventListener('lifeos:open-palette', openPalette);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('lifeos:open-palette', openPalette);
    };
  }, [navigate]);

  const saveNow = () => {
    exportBackup();
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1800);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNow();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportBackup]);

  if (loading) {
    return <div className="app-loading">Loading your data…</div>;
  }

  const Page = PAGES[page];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><Sparkles size={20} /><span>Life OS</span></div>
        <button type="button" className="sidebar-search" onClick={() => setPaletteOpen(true)} title="Command palette (Ctrl+K)">
          <Search size={15} /><span>Search…</span><kbd>Ctrl K</kbd>
        </button>
        <nav>
          {NAV_SECTIONS.map((section, index) => (
            <div className="nav-section" key={section.label || `section-${index}`}>
              {section.label && <span className="nav-section-label">{section.label}</span>}
              {section.items.map(item => (
                <button
                  type="button"
                  key={item.page}
                  className={`nav-item ${page === item.page ? 'active' : ''}`}
                  onClick={() => navigate(item.page)}
                >
                  <item.icon size={17} />
                  <span>{item.page}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main-content">
        {isMobile && <SyncBanner />}
        {page === 'Dashboard' ? <Dashboard navigate={navigate} />
          : page === 'Calendar' ? <Calendar navigate={navigate} />
          : page === 'Second Brain' ? <SecondBrain initialTab={navTab as ParaTab | undefined} focusNote={focusNote} />
          : Page ? <Page /> : null}
      </main>
      <div className="history-controls">
        <button
          type="button"
          className={`history-btn sync-btn sync-tone-${syncDescription.tone} ${syncStatus === 'syncing' ? 'syncing' : ''} ${syncStatus === 'error' ? 'sync-error' : ''}`}
          onClick={() => void syncNow(true)}
          disabled={!isSyncConfigured || syncStatus === 'syncing'}
          title={syncDescription.long}
          aria-label={`Sync — ${syncDescription.short}`}
        >
          <RefreshCw size={17} />
          {/* Amber: changes waiting to sync · red: not connected or failed. */}
          {(syncDescription.tone === 'pending' || syncDescription.tone === 'warn' || syncDescription.tone === 'error') && <i className="sync-btn-dot" aria-hidden="true" />}
        </button>
        <span className="history-divider" />
        <button type="button" className={`history-btn ${justSaved ? 'saved' : ''}`} onClick={saveNow} title="Save a backup file (Ctrl+S)">
          {justSaved ? <Check size={17} /> : <Save size={17} />}
        </button>
        <span className="history-divider" />
        <button type="button" className="history-btn" disabled={!canUndo} onClick={() => void undo()} title="Undo (Ctrl+Z)">
          <Undo2 size={17} />
        </button>
        <button type="button" className="history-btn" disabled={!canRedo} onClick={() => void redo()} title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={17} />
        </button>
      </div>
      <MobileNav page={page} navigate={navigate} />
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          navigate={navigate}
          onOpenNote={openNote}
          onShowShortcuts={() => setShortcutsOpen(true)}
          onSave={saveNow}
        />
      )}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
      <UndoToast />
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
