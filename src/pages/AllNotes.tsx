import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ArrowUpRight, Check, ChevronDown, ChevronRight, ClipboardCopy, Pencil, Search, Star, X } from 'lucide-react';
import { useStore } from '../store';
import { PageHeader } from '../components/UI';
import { sanitizeHtml } from '../components/RichTextEditor';
import { NOTE_AREAS, collectLoggedNotes, type LoggedNote, type NoteArea, type NotePart, type NoteTarget } from '../lib/loggedNotes';
import type { CollectionName, CollectionRecord, WorkoutRoutine } from '../types';

const PAGE_SIZE = 150;
// Notes longer than this (characters or lines) fold behind "Show more".
const LONG_CHARS = 420;
const LONG_LINES = 7;
const isLong = (text: string) => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;

type Range = 'all' | 'week' | 'month' | '3m' | 'custom';
const RANGES: { value: Range; label: string }[] = [
  { value: 'all', label: 'All time' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' },
  { value: '3m', label: 'Last 3 months' }, { value: 'custom', label: 'Custom…' }
];

interface ViewState {
  area: NoteArea | 'All'; source: string; query: string; range: Range; from: string; to: string;
  oldestFirst: boolean; starredOnly: boolean; openMonths: string[]; closedMonths: string[]; standingOpen: boolean; scrollY: number;
}
// Kept for the session, so coming back from a note you jumped to lands where you left off.
let saved: ViewState = {
  area: 'All', source: '', query: '', range: 'all', from: '', to: '', oldestFirst: false, starredOnly: false,
  openMonths: [], closedMonths: [], standingOpen: false, scrollY: 0
};

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function rangeBounds(range: Range, from: string, to: string): [string, string] | null {
  const now = new Date();
  if (range === 'all') return null;
  if (range === 'custom') return [from || '0000-00-00', to || '9999-99-99'];
  const start = new Date(now);
  if (range === 'week') start.setDate(now.getDate() - now.getDay());
  else if (range === 'month') start.setDate(1);
  else start.setMonth(now.getMonth() - 3);
  return [isoOf(start), '9999-99-99'];
}

function dayHeading(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  if (d.toDateString() === today.toDateString()) return `Today · ${label}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${label}`;
  return label;
}
const monthLabel = (key: string) => new Date(`${key}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const shortDate = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function highlight(text: string, q: string): ReactNode {
  if (!q) return text;
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, from)) {
    if (i > from) out.push(text.slice(from, i));
    out.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    from = i + q.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function scrollerOf(el: HTMLElement | null): HTMLElement | Window {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return window;
}

// Every note written anywhere in the app. Tapping a note opens the place it was written; the
// pencil edits it right here.
export function AllNotes({ onOpen }: { onOpen: (note: LoggedNote) => void }) {
  const { data, upsert, updateSettings } = useStore();
  const [view, setViewRaw] = useState<ViewState>(saved);
  const setView = (patch: Partial<ViewState>) => setViewRaw(prev => { saved = { ...prev, ...patch, scrollY: saved.scrollY }; return saved; });
  const [shown, setShown] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { area, source, query, range, from, to, oldestFirst, starredOnly, standingOpen } = view;

  // Back where you were after visiting a note's page.
  useLayoutEffect(() => {
    const scroller = scrollerOf(rootRef.current);
    if (saved.scrollY) scroller.scrollTo(0, saved.scrollY);
    const remember = () => { saved.scrollY = scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop; };
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, []);

  const all = useMemo(() => collectLoggedNotes(data), [data]);
  const starred = useMemo(() => new Set(data.settings.starredNoteIds ?? []), [data.settings.starredNoteIds]);
  const toggleStar = (id: string) => {
    const next = new Set(starred);
    if (next.has(id)) next.delete(id); else next.add(id);
    void updateSettings({ starredNoteIds: Array.from(next) });
  };

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of all) c.set(n.area, (c.get(n.area) ?? 0) + 1);
    return c;
  }, [all]);
  const sources = useMemo(() => {
    if (area === 'All') return [];
    const c = new Map<string, number>();
    for (const n of all) if (n.area === area) c.set(n.source, (c.get(n.source) ?? 0) + 1);
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1]);
  }, [all, area]);
  const starredCount = useMemo(() => all.filter(n => starred.has(n.id)).length, [all, starred]);

  const q = query.trim().toLowerCase();
  const bounds = rangeBounds(range, from, to);
  const matches = (n: LoggedNote) =>
    (area === 'All' || n.area === area)
    && (!source || n.source === source)
    && (!starredOnly || starred.has(n.id))
    && (!q || n.text.toLowerCase().includes(q) || n.context.toLowerCase().includes(q) || n.source.toLowerCase().includes(q));
  const timeline = useMemo(() => {
    const list = all.filter(n => n.dated && matches(n) && (!bounds || (n.date >= bounds[0] && n.date <= bounds[1])));
    return oldestFirst ? [...list].reverse() : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, area, source, starredOnly, q, range, from, to, oldestFirst, starred]);
  // Standing notes have no day, so a date filter leaves them out.
  const standing = useMemo(() => (bounds ? [] : all.filter(n => !n.dated && matches(n)).sort((a, b) => a.area.localeCompare(b.area) || a.context.localeCompare(b.context))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, area, source, starredOnly, q, range, from, to, starred]);

  // Months: the two most recent with notes are open; older ones fold to a single line. While
  // searching or filtering, everything is open — you're looking for something.
  const narrowing = Boolean(q || source || starredOnly || bounds);
  const months = useMemo(() => {
    const groups: { key: string; total: number; days: { date: string; notes: LoggedNote[] }[] }[] = [];
    for (const n of timeline) {
      const key = n.date.slice(0, 7);
      let m = groups[groups.length - 1];
      if (!m || m.key !== key) { m = { key, total: 0, days: [] }; groups.push(m); }
      m.total++;
      const d = m.days[m.days.length - 1];
      if (d && d.date === n.date) d.notes.push(n); else m.days.push({ date: n.date, notes: [n] });
    }
    return groups;
  }, [timeline]);
  const recentMonths = useMemo(() => new Set([...new Set(timeline.map(n => n.date.slice(0, 7)))].sort().reverse().slice(0, 2)), [timeline]);
  const monthOpen = (key: string) => narrowing || (recentMonths.has(key) ? !view.closedMonths.includes(key) : view.openMonths.includes(key));
  const toggleMonth = (key: string) => {
    const flip = (list: string[]) => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]);
    if (recentMonths.has(key)) setView({ closedMonths: flip(view.closedMonths) }); else setView({ openMonths: flip(view.openMonths) });
  };

  // "Show older notes" pages through the open months' notes.
  let budget = shown;

  const save = async (target: NoteTarget, draft: string) => {
    const value = draft.trim();
    if (target.kind === 'field') {
      const record = (data[target.collection] as CollectionRecord[]).find(r => r.id === target.id);
      if (!record) return;
      if (!value && target.field === 'summary') return; // a check-in needs its summary
      await upsert(target.collection as CollectionName, { ...record, [target.field]: value || undefined } as never);
    } else {
      const routine = data.workoutRoutines.find(r => r.id === target.routineId) as WorkoutRoutine | undefined;
      if (!routine) return;
      const exerciseLogs = routine.exerciseLogs
        .map(l => (l.exerciseId === target.exerciseId && l.date === target.date ? { ...l, notes: value || undefined } : l))
        .filter(l => l.notes || l.lastReps != null || l.weights.some(w => w != null));
      await upsert('workoutRoutines', { ...routine, exerciseLogs });
    }
  };

  const copyShown = () => {
    const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = [...timeline, ...standing].map(n => [n.dated ? n.date : '', n.area, n.source, n.context + (n.badge ? ` ${n.badge.text}` : ''), n.text].map(cell).join('\t'));
    void navigator.clipboard?.writeText(['Date\tArea\tType\tAbout\tNote', ...rows].join('\n')).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  const renderPart = (n: LoggedNote, p: NotePart, i: number) => {
    const key = `${n.id}#${i}`;
    const isEditing = editing?.key === key;
    const long = isLong(p.text);
    const open = expanded.has(key);
    const toggle = () => setExpanded(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    // Formatted notes are edited in their own editor (there's no rich-text box here).
    const editable = Boolean(p.target) && !p.html;
    return (
      <div className="allnotes-part" key={key}>
        {(p.label || editable) && (
          <span className="allnotes-part-head">
            {p.label && <b>{highlight(p.label, q)}</b>}
            {editable && !isEditing && (
              <button type="button" className="allnotes-icon" onClick={e => { e.stopPropagation(); setEditing({ key, draft: p.text }); }} aria-label="Edit this note" title="Edit here">
                <Pencil size={13} />
              </button>
            )}
          </span>
        )}
        {isEditing ? (
          <div className="allnotes-edit" onClick={e => e.stopPropagation()}>
            <textarea
              autoFocus
              rows={Math.min(10, Math.max(2, editing.draft.split('\n').length + 1))}
              value={editing.draft}
              onChange={e => setEditing({ key, draft: e.target.value })}
              onKeyDown={e => {
                e.stopPropagation();
                if (e.key === 'Escape') setEditing(null);
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { void save(p.target!, editing.draft); setEditing(null); }
              }}
            />
            <div className="allnotes-edit-actions">
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => { void save(p.target!, editing.draft); setEditing(null); }}>Save</button>
            </div>
          </div>
        ) : p.html && !q ? (
          <div className={`allnotes-text allnotes-rich ${long && !open ? 'clamped-rich' : ''}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(p.html) }} />
        ) : (
          <span className={`allnotes-text ${long && !open ? 'clamped' : ''}`}>{highlight(p.text, q)}</span>
        )}
        {long && !isEditing && (
          <button type="button" className="text-btn allnotes-toggle" onClick={e => { e.stopPropagation(); toggle(); }}>
            {open ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    );
  };

  const renderNote = (n: LoggedNote) => {
    const isStarred = starred.has(n.id);
    return (
      <div
        key={n.id}
        className={`allnotes-item ${isStarred ? 'starred' : ''}`}
        role="button"
        tabIndex={0}
        onClick={e => { if ((e.target as HTMLElement).closest('a')) return; onOpen(n); }}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(n); } }}
        title={`Open in ${n.jump.page}${n.jump.tab ? ` → ${n.jump.tab}` : ''}`}
      >
        <span className="allnotes-meta">
          <button
            type="button"
            className={`allnotes-icon allnotes-star ${isStarred ? 'on' : ''}`}
            onClick={e => { e.stopPropagation(); toggleStar(n.id); }}
            aria-pressed={isStarred}
            aria-label={isStarred ? 'Remove star' : 'Star this note'}
            title={isStarred ? 'Starred — tap to remove' : 'Star this note'}
          >
            <Star size={14} fill={isStarred ? 'currentColor' : 'none'} />
          </button>
          <span className={`allnotes-tag area-${n.area.toLowerCase()}`}>{n.source}</span>
          <span className="allnotes-context">
            {highlight(n.context, q)}
            {n.badge && <b className={`allnotes-badge ${n.badge.tone}`}>{n.badge.text}</b>}
          </span>
          <ArrowUpRight size={14} className="allnotes-go" />
        </span>
        {n.parts.map((p, i) => renderPart(n, p, i))}
      </div>
    );
  };

  const nothing = !timeline.length && !standing.length;
  const shownTotal = timeline.length + standing.length;

  return (
    <div ref={rootRef}>
      <PageHeader
        title="All Notes"
        subtitle={`Every note you've written across the app, in one place — ${all.length} so far. Tap one to open where it was written.`}
        action={shownTotal > 0 ? (
          <button type="button" className="btn ghost" onClick={copyShown} title="Copy the notes shown (date, area, type, about, note) — pastes into a spreadsheet">
            {copied ? <Check size={16} /> : <ClipboardCopy size={16} />} {copied ? 'Copied' : `Copy ${shownTotal}`}
          </button>
        ) : undefined}
      />

      <div className="allnotes-sticky">
        <label className="allnotes-search">
          <Search size={15} />
          <input type="search" value={query} onChange={e => { setView({ query: e.target.value }); setShown(PAGE_SIZE); }} placeholder="Search inside your notes…" aria-label="Search notes" />
          {query && <button type="button" onClick={() => setView({ query: '' })} aria-label="Clear search"><X size={14} /></button>}
        </label>
        <div className="allnotes-chips">
          <button type="button" className={`chip ${area === 'All' && !starredOnly ? 'active' : ''}`} onClick={() => { setView({ area: 'All', source: '', starredOnly: false }); setShown(PAGE_SIZE); }}>All <i>{all.length}</i></button>
          {starredCount > 0 && (
            <button type="button" className={`chip allnotes-chip-star ${starredOnly ? 'active' : ''}`} onClick={() => { setView({ starredOnly: !starredOnly }); setShown(PAGE_SIZE); }}>
              <Star size={12} fill="currentColor" /> Starred <i>{starredCount}</i>
            </button>
          )}
          {NOTE_AREAS.filter(a => counts.get(a)).map(a => (
            <button type="button" key={a} className={`chip ${area === a ? 'active' : ''}`} onClick={() => { setView({ area: a, source: '' }); setShown(PAGE_SIZE); }}>{a} <i>{counts.get(a)}</i></button>
          ))}
        </div>
      </div>

      <div className="allnotes-tools">
        {sources.length > 1 && (
          <div className="allnotes-chips allnotes-subchips">
            {sources.map(([s, count]) => (
              <button type="button" key={s} className={`chip ${source === s ? 'active' : ''}`} onClick={() => { setView({ source: source === s ? '' : s }); setShown(PAGE_SIZE); }}>{s} <i>{count}</i></button>
            ))}
          </div>
        )}
        <div className="allnotes-controls">
          <select value={range} onChange={e => { setView({ range: e.target.value as Range }); setShown(PAGE_SIZE); }} aria-label="Date range">
            {RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          {range === 'custom' && (
            <>
              <input type="date" value={from} onChange={e => setView({ from: e.target.value })} aria-label="From date" />
              <span className="muted">to</span>
              <input type="date" value={to} onChange={e => setView({ to: e.target.value })} aria-label="To date" />
            </>
          )}
          <button type="button" className="btn ghost allnotes-sort" onClick={() => setView({ oldestFirst: !oldestFirst })} title="Switch the order">
            {oldestFirst ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />} {oldestFirst ? 'Oldest first' : 'Newest first'}
          </button>
        </div>
      </div>

      {nothing && (
        <p className="muted empty-state">
          {all.length ? 'No notes match that.' : 'No notes yet. Anything you type into a Notes box — on a sleep night, a workout, a trading day, a bill — shows up here.'}
        </p>
      )}

      <div className="allnotes-days">
        {months.map(m => {
          const open = monthOpen(m.key);
          if (open && budget <= 0) return null;
          return (
            <section key={m.key} className="allnotes-month">
              <button type="button" className="allnotes-month-head" onClick={() => toggleMonth(m.key)} aria-expanded={open} disabled={narrowing}>
                {!narrowing && (open ? <ChevronDown size={15} /> : <ChevronRight size={15} />)}
                <b>{monthLabel(m.key)}</b>
                <span>{m.total} note{m.total === 1 ? '' : 's'}</span>
              </button>
              {open && m.days.map(g => {
                if (budget <= 0) return null;
                const notes = g.notes.slice(0, budget);
                budget -= notes.length;
                return (
                  <div key={g.date} className="allnotes-day">
                    <h2>{dayHeading(g.date)}</h2>
                    <div className="allnotes-list">{notes.map(renderNote)}</div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {budget <= 0 && timeline.length > shown && (
        <button type="button" className="btn ghost allnotes-more" onClick={() => setShown(s => s + PAGE_SIZE)}>Show older notes</button>
      )}

      {standing.length > 0 && (
        <section className="allnotes-standing">
          <button type="button" className="allnotes-month-head" onClick={() => setView({ standingOpen: !standingOpen })} aria-expanded={standingOpen || Boolean(q)} disabled={Boolean(q)}>
            {!q && (standingOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />)}
            <b>Standing notes</b>
            <span>{standing.length} · on things with no date of their own (accounts, bills, programs, people…)</span>
          </button>
          {(standingOpen || q) && (
            <div className="allnotes-list">
              {standing.map(n => (
                <div key={n.id} className="allnotes-standing-row">
                  {renderNote(n)}
                  <small className="allnotes-edited">Last edited {shortDate(n.date)}</small>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** The most recent dated notes, for the Dashboard card. */
export function useRecentNotes(limit: number): { recent: LoggedNote[]; total: number } {
  const { data } = useStore();
  return useMemo(() => {
    const all = collectLoggedNotes(data);
    return { recent: all.filter(n => n.dated).slice(0, limit), total: all.length };
  }, [data, limit]);
}
