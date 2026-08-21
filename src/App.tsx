import React, { useEffect, useState } from 'react';
import { Check, RefreshCw, Redo2, Save, Sparkles, Undo2 } from 'lucide-react';
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
import { YouTubeAnalytics } from './pages/YouTubeAnalytics';
import { Settings } from './pages/Settings';
import { Research } from './pages/Research';
import { SecondBrain } from './pages/SecondBrain';
import type { ParaTab } from './pages/SecondBrain';
import { HealthWellness } from './pages/HealthWellness';
import { Travel } from './pages/Travel';
import { PersonalCRM } from './pages/PersonalCRM';
import { UndoToast } from './components/UndoToast';

const PAGES: Record<string, React.ComponentType> = {
  Habits, Movies, Videogames, Books,
  Finance, 'Trading Journal': TradingJournal, 'YouTube Analytics': YouTubeAnalytics, Settings, Research,
  Health: HealthWellness, 'Travel & Bucket List': Travel,
  'Personal CRM': PersonalCRM
};

function Shell() {
  const { loading, undo, redo, canUndo, canRedo, exportBackup, syncNow, syncStatus, syncError, lastSyncedAt, isSyncConfigured } = useStore();
  const [page, setPage] = useState('Dashboard');
  // A landing tab for pages that have their own internal tabs (currently just Second Brain) —
  // set alongside the page so a specific click-through (e.g. a goal from the Calendar) can open
  // straight to the relevant tab instead of always landing on that page's default view.
  const [navTab, setNavTab] = useState<string | undefined>(undefined);
  const [justSaved, setJustSaved] = useState(false);
  const navigate = (next: string, tab?: string) => { setPage(next); setNavTab(tab); };

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
        {page === 'Dashboard' ? <Dashboard navigate={navigate} />
          : page === 'Calendar' ? <Calendar navigate={navigate} />
          : page === 'Second Brain' ? <SecondBrain initialTab={navTab as ParaTab | undefined} />
          : Page ? <Page /> : null}
      </main>
      <div className="history-controls">
        <button
          type="button"
          className={`history-btn ${syncStatus === 'syncing' ? 'syncing' : ''} ${syncStatus === 'error' ? 'sync-error' : ''}`}
          onClick={() => void syncNow(true)}
          disabled={!isSyncConfigured || syncStatus === 'syncing'}
          title={
            !isSyncConfigured ? 'Google Drive sync isn’t configured (see googleDriveSync.ts)'
              : syncStatus === 'error' ? `Sync failed: ${syncError}`
              : syncStatus === 'syncing' ? 'Syncing…'
              : lastSyncedAt ? `Sync with Google Drive — last synced ${new Date(lastSyncedAt).toLocaleTimeString()}`
              : 'Sync with Google Drive'
          }
        >
          <RefreshCw size={17} />
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
