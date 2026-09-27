import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, CheckSquare, CornerDownLeft, FileText, Keyboard, RefreshCw, Save, Search, Target, TrendingUp, Undo2, User
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useStore } from '../store';
import { ALL_NAV_ITEMS, navIconFor } from '../navigation';

// App-wide Ctrl+K palette: jump to any page, or straight to a record (note, task, contact,
// backlog item, trading day…), or run a shell action. Records open their page; notes open
// themselves in Second Brain (see `onOpenNote`).

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon?: LucideIcon;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

// Alt+1…9 → the first nine sidebar pages, in sidebar order. Alt rather than Ctrl because
// browsers reserve Ctrl+1…9 for switching tabs.
export const PAGE_SHORTCUT_PAGES = ALL_NAV_ITEMS.slice(0, 9).map(item => item.page);

export const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  { title: 'Anywhere', items: [
    ['Ctrl K', 'Command palette — search pages, notes, tasks, contacts…'],
    ['Alt 1 – 9', 'Jump to the first nine sidebar pages'],
    ['Ctrl ,', 'Open Settings'],
    ['?', 'Show this cheat sheet'],
    ['Ctrl S', 'Save a backup file'],
    ['Ctrl Z / Ctrl Y', 'Undo / redo'],
    ['Esc', 'Close a dialog or panel']
  ] },
  { title: 'Command palette', items: [
    ['↑ ↓', 'Move through results'],
    ['Enter', 'Open the highlighted result']
  ] },
  { title: 'Second Brain', items: [
    ['J / K', 'Next / previous note in the list'],
    ['Enter', 'Open the first note'],
    ['1 – 4', 'File an Inbox note: Project, Area, Resource, Archive'],
    ['Ctrl Shift A', 'Archive / unarchive the open note'],
    ['Ctrl \\', 'Collapse / expand the side panel'],
    ['Ctrl N', 'New note'],
    ['Ctrl Enter', 'Save a quick capture'],
    ['Ctrl click', 'Follow a link inside a note']
  ] },
  { title: 'Dashboard', items: [
    ['Ctrl Enter', 'Send Quick capture to Second Brain']
  ] }
];

export function isTypingTarget(el: Element | null): boolean {
  return el instanceof HTMLElement && (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  );
}

function score(cmd: PaletteCommand, terms: string[]): number {
  const label = cmd.label.toLowerCase();
  const hay = `${label} ${(cmd.hint ?? '').toLowerCase()} ${(cmd.keywords ?? '').toLowerCase()} ${cmd.group.toLowerCase()}`;
  let total = 0;
  for (const t of terms) {
    if (!hay.includes(t)) return 0;
    total += label.startsWith(t) ? 3 : label.includes(t) ? 2 : 1;
  }
  return total;
}

const GROUP_ORDER = ['Pages', 'Actions', 'Notes', 'Tasks', 'Goals', 'Events', 'Contacts', 'Movies & TV', 'Videogames', 'Books', 'Bucket list', 'Trading days'];
const RECORD_LIMIT_PER_GROUP = 6;

export function CommandPalette({
  onClose, navigate, onOpenNote, onShowShortcuts, onSave
}: {
  onClose: () => void;
  navigate: (page: string) => void;
  onOpenNote: (noteId: string, workspaceId?: string) => void;
  onShowShortcuts: () => void;
  onSave: () => void;
}) {
  const { data, undo, syncNow, isSyncConfigured } = useStore();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo<PaletteCommand[]>(() => {
    const go = (page: string) => () => navigate(page);
    const out: PaletteCommand[] = [];
    ALL_NAV_ITEMS.forEach(item => {
      const idx = PAGE_SHORTCUT_PAGES.indexOf(item.page);
      out.push({ id: `page:${item.page}`, label: item.page, group: 'Pages', icon: item.icon, shortcut: idx >= 0 ? `Alt ${idx + 1}` : item.page === 'Settings' ? 'Ctrl ,' : undefined, run: go(item.page) });
    });
    out.push(
      { id: 'act:shortcuts', label: 'Keyboard shortcuts', group: 'Actions', icon: Keyboard, shortcut: '?', keywords: 'help cheat sheet keys', run: onShowShortcuts },
      { id: 'act:save', label: 'Save a backup file', group: 'Actions', icon: Save, shortcut: 'Ctrl S', keywords: 'export download', run: onSave },
      { id: 'act:undo', label: 'Undo last change', group: 'Actions', icon: Undo2, shortcut: 'Ctrl Z', run: () => void undo() }
    );
    if (isSyncConfigured) out.push({ id: 'act:sync', label: 'Sync with Google Drive', group: 'Actions', icon: RefreshCw, keywords: 'drive cloud', run: () => void syncNow(true) });

    data.notes.forEach(n => out.push({ id: `note:${n.id}`, label: n.title || 'Untitled', hint: n.paraType ?? 'Inbox', group: 'Notes', icon: FileText, keywords: (n.tags ?? []).join(' '), run: () => onOpenNote(n.id, n.workspaceId) }));
    data.tasks.forEach(t => out.push({ id: `task:${t.id}`, label: t.title, hint: t.status, group: 'Tasks', icon: CheckSquare, run: go('Second Brain') }));
    data.goals.forEach(g => out.push({ id: `goal:${g.id}`, label: g.title, hint: g.status, group: 'Goals', icon: Target, run: go('Second Brain') }));
    data.events.forEach(e => out.push({ id: `event:${e.id}`, label: e.title, hint: e.date, group: 'Events', icon: CalendarDays, run: go('Calendar') }));
    data.contacts.forEach(c => out.push({ id: `contact:${c.id}`, label: c.name, group: 'Contacts', icon: User, run: go('Personal CRM') }));
    const backlog: [string, string, { id: string; title: string }[]][] = [
      ['Movies & TV', 'Movies', data.movies], ['Videogames', 'Videogames', data.videogames], ['Books', 'Books', data.books], ['Bucket list', 'Travel & Bucket List', data.bucketList]
    ];
    backlog.forEach(([group, page, items]) => items.forEach(it => out.push({ id: `${page}:${it.id}`, label: it.title, group, icon: navIconFor(page), run: go(page) })));
    data.dailyLogs.forEach(l => out.push({ id: `day:${l.id}`, label: l.date, hint: `${l.totalTrades} trades`, group: 'Trading days', icon: TrendingUp, keywords: 'trade journal', run: go('Trading Journal') }));
    return out;
  }, [data, navigate, onOpenNote, onShowShortcuts, onSave, undo, syncNow, isSyncConfigured]);

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return commands.filter(c => c.group === 'Pages' || c.group === 'Actions');
    const scored = commands.map(c => ({ c, s: score(c, terms) })).filter(x => x.s > 0);
    const perGroup = new Map<string, number>();
    return scored
      .sort((a, b) => GROUP_ORDER.indexOf(a.c.group) - GROUP_ORDER.indexOf(b.c.group) || b.s - a.s)
      .filter(({ c }) => {
        if (c.group === 'Pages' || c.group === 'Actions') return true;
        const n = perGroup.get(c.group) ?? 0;
        perGroup.set(c.group, n + 1);
        return n < RECORD_LIMIT_PER_GROUP;
      })
      .map(x => x.c);
  }, [commands, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); runAt(active); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return (
    <div className="cmdk-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cmdk" role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="cmdk-input-row">
          <Search size={17} />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search pages, notes, tasks, contacts, movies…"
            aria-label="Search"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {results.length ? results.map((cmd, i) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            const Icon = cmd.icon;
            return (
              <React.Fragment key={cmd.id}>
                {header && <div className="cmdk-group">{header}</div>}
                <button
                  type="button"
                  data-idx={i}
                  className={`cmdk-item ${i === active ? 'active' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => runAt(i)}
                >
                  {Icon ? <Icon size={15} /> : <span className="cmdk-icon-gap" />}
                  <span className="cmdk-label">{cmd.label}</span>
                  {cmd.hint && <small className="cmdk-hint">{cmd.hint}</small>}
                  {cmd.shortcut ? <kbd>{cmd.shortcut}</kbd> : i === active && <CornerDownLeft size={13} className="cmdk-enter" />}
                </button>
              </React.Fragment>
            );
          }) : <p className="cmdk-empty">No matches for “{query}”.</p>}
        </div>
        <div className="cmdk-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>?</kbd> all shortcuts</span>
        </div>
      </div>
    </div>
  );
}

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="cmdk-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="shortcuts-sheet" role="dialog" aria-label="Keyboard shortcuts">
        <div className="shortcuts-head">
          <h2><Keyboard size={18} /> Keyboard shortcuts</h2>
          <kbd>Esc</kbd>
        </div>
        <div className="shortcuts-grid">
          {SHORTCUT_GROUPS.map(g => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              {g.items.map(([keys, desc]) => (
                <div className="shortcut-row" key={keys + desc}>
                  <span>{desc}</span>
                  <span className="shortcut-keys">{keys.split(' ').map((k, i) => k === '/' || k === '–' ? <i key={i}>{k}</i> : <kbd key={i}>{k}</kbd>)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
