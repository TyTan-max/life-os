import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUpRight, BookmarkPlus, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardCopy,
  FileText, NotebookText, Pencil, Plus, Search, Share, SlidersHorizontal, Star, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import { PageHeader } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { sanitizeHtml } from '../components/RichTextEditor';
import { DEFAULT_WORKSPACE_ID } from '../storage';
import { NOTE_AREAS, NOTE_AREA_HINTS, collectLoggedNotes, type LoggedNote, type NoteArea, type NotePart, type NoteTarget } from '../lib/loggedNotes';
import { escapeHtml } from '../lib/markdown';
import type { CollectionName, CollectionRecord, DayNote, Note, WorkoutRoutine } from '../types';

const PAGE_SIZE = 150;
// Notes longer than this (characters or lines) fold behind "Show more".
const LONG_CHARS = 420;
const LONG_LINES = 7;
const isLong = (text: string, compact: boolean) =>
  (compact ? text.length > 90 || text.includes('\n') : text.length > LONG_CHARS || text.split('\n').length > LONG_LINES);

type Range = 'all' | 'week' | 'month' | '3m' | 'custom';
const RANGES: { value: Range; label: string }[] = [
  { value: 'all', label: 'All time' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' },
  { value: '3m', label: 'Last 3 months' }, { value: 'custom', label: 'Custom…' }
];

interface ViewState {
  area: NoteArea | 'All'; source: string; query: string; range: Range; from: string; to: string;
  oldestFirst: boolean; starredOnly: boolean; compact: boolean;
  openMonths: string[]; closedMonths: string[]; standingOpen: boolean; scrollY: number;
}
// Kept for the session, so coming back from a note you jumped to lands where you left off.
let saved: ViewState = {
  area: 'All', source: '', query: '', range: 'all', from: '', to: '', oldestFirst: false, starredOnly: false, compact: false,
  openMonths: [], closedMonths: [], standingOpen: false, scrollY: 0
};

// A note to scroll to and flash when the page opens (the Dashboard's "Recent notes" card).
let focusId: string | null = null;
export function requestNoteFocus(id: string): void {
  focusId = id;
}

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (iso: string) => new Date(`${iso}T12:00:00`);

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
  const d = dateOf(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  if (d.toDateString() === today.toDateString()) return `Today · ${label}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${label}`;
  return label;
}
const monthLabel = (key: string) => dateOf(`${key}-15`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const shortDate = (iso: string) => dateOf(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const longDate = (iso: string) => dateOf(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

// The ways someone might type a day into the search box: "sep 29", "september 29", "monday", "9/29", "2026-09-29".
const dateWordsCache = new Map<string, string>();
function dateWords(iso: string): string {
  let words = dateWordsCache.get(iso);
  if (!words) {
    const d = dateOf(iso);
    words = Number.isNaN(d.getTime()) ? iso : [
      iso,
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
    ].join(' | ').replace(/,/g, '').toLowerCase();
    dateWordsCache.set(iso, words);
  }
  return words;
}

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

const isTyping = (el: Element | null) =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

// Every note written anywhere in the app. Tapping a note opens the place it was written; the
// pencil edits it right here; "+ Note for today" writes one that lives on this page.
export function AllNotes({ onOpen }: { onOpen: (note: LoggedNote) => void }) {
  const { data, upsert, remove, updateSettings } = useStore();
  const [view, setViewRaw] = useState<ViewState>(() => (focusId ? { ...saved, area: 'All', source: '', query: '', range: 'all', starredOnly: false } : saved));
  const setView = (patch: Partial<ViewState>) => setViewRaw(prev => { saved = { ...prev, ...patch, scrollY: saved.scrollY }; return saved; });
  const [shown, setShown] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: { src: string; label?: string }[]; index: number } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => saved.range === 'custom');
  const [otdOpen, setOtdOpen] = useState(false);
  const stickyRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftDate, setDraftDate] = useState(() => isoOf(new Date()));
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const standingRef = useRef<HTMLElement>(null);
  const { area, source, query, range, from, to, oldestFirst, starredOnly, standingOpen, compact } = view;

  const all = useMemo(() => collectLoggedNotes(data), [data]);
  const noteDates = useMemo(() => [...new Set(all.filter(n => n.dated).map(n => n.date))], [all]);

  // Back where you were after visiting a note's page — unless a specific note was asked for.
  useLayoutEffect(() => {
    const scroller = scrollerOf(rootRef.current);
    if (saved.scrollY && !focusId) scroller.scrollTo(0, saved.scrollY);
    const remember = () => { saved.scrollY = scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop; };
    scroller.addEventListener('scroll', remember, { passive: true });
    return () => scroller.removeEventListener('scroll', remember);
  }, []);

  // Scrolls to one note and flashes it, opening whatever section it's folded inside.
  const reveal = (id: string) => {
    const note = all.find(n => n.id === id);
    if (!note) return;
    if (note.dated) {
      const key = note.date.slice(0, 7);
      setView({ openMonths: [...new Set([...view.openMonths, key])], closedMonths: view.closedMonths.filter(k => k !== key) });
    } else {
      setView({ standingOpen: true });
    }
    window.setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-note-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashId(id);
      window.setTimeout(() => setFlashId(prev => (prev === id ? null : prev)), 1700);
    }, 80);
  };
  useEffect(() => {
    if (!focusId) return;
    const id = focusId;
    focusId = null;
    reveal(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On a phone the search + chips bar is pinned; month headers pin just under it.
  useLayoutEffect(() => {
    const bar = stickyRef.current;
    const root = rootRef.current;
    if (!bar || !root) return;
    const measure = () => root.style.setProperty('--allnotes-top', getComputedStyle(bar).position === 'sticky' ? `${bar.offsetHeight}px` : '0px');
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Screenshot viewer: arrows step through a day's screenshots, Esc closes.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowRight') setLightbox(l => (l ? { ...l, index: (l.index + 1) % l.images.length } : l));
      if (e.key === 'ArrowLeft') setLightbox(l => (l ? { ...l, index: (l.index - 1 + l.images.length) % l.images.length } : l));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // "/" jumps to the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement)) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
    && (!q || n.text.toLowerCase().includes(q) || n.context.toLowerCase().includes(q) || n.source.toLowerCase().includes(q)
      || (n.dated && dateWords(n.date).includes(q)));
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

  // What you wrote a week, a month and a year ago today — only when there's something.
  const onThisDay = useMemo(() => {
    const now = new Date();
    const back = (fn: (d: Date) => void) => { const d = new Date(now); fn(d); return isoOf(d); };
    const marks: [string, string][] = [
      ['A week ago', back(d => d.setDate(d.getDate() - 7))],
      ['A month ago', back(d => d.setMonth(d.getMonth() - 1))],
      ['A year ago', back(d => d.setFullYear(d.getFullYear() - 1))]
    ];
    return marks.flatMap(([label, iso]) => all.filter(n => n.dated && n.date === iso).map(note => ({ label, note })));
  }, [all]);

  // "Show older notes" pages through the open months' notes.
  let budget = shown;

  const save = async (target: NoteTarget, text: string) => {
    const value = text.trim();
    if (!value) {
      // A check-in needs its summary; anything else, make sure emptying it was meant.
      if (target.kind === 'field' && target.field === 'summary') return;
      if (!window.confirm('Remove this note? Saving it empty deletes the note’s text.')) return;
    }
    if (target.kind === 'field') {
      if (target.collection === 'dayNotes' && !value) { await remove('dayNotes', target.id); return; }
      const record = (data[target.collection] as CollectionRecord[]).find(r => r.id === target.id);
      if (!record) return;
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

  const addDayNote = () => {
    const text = draft.trim();
    if (!text) return;
    const record = newRecord<DayNote>({ date: draftDate || isoOf(new Date()), text });
    void upsert('dayNotes', record);
    setDraft('');
    setComposing(false);
    requestAnimationFrame(() => reveal(`day:${record.id}`));
  };

  // ---- Copy / save what's showing ----
  const showing = [...timeline, ...standing];
  const flashDone = (label: string) => { setDone(label); setMenuOpen(false); window.setTimeout(() => setDone(null), 2000); };
  const about = (n: LoggedNote) => [n.context, n.badge?.text].filter(Boolean).join(' ');
  const copyRows = () => {
    const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = showing.map(n => [n.dated ? n.date : '', n.area, n.source, about(n), n.text].map(cell).join('\t'));
    void navigator.clipboard?.writeText(['Date\tArea\tType\tAbout\tNote', ...rows].join('\n')).then(() => flashDone('Copied'));
  };
  const copyText = () => {
    const lines: string[] = [];
    let lastHeading = '';
    for (const n of showing) {
      const heading = n.dated ? longDate(n.date) : 'Standing notes';
      if (heading !== lastHeading) { if (lines.length) lines.push(''); lines.push(heading); lastHeading = heading; }
      lines.push(`• ${n.source}${about(n) ? ` — ${about(n)}` : ''}`);
      for (const line of n.text.split('\n')) lines.push(`  ${line}`);
    }
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => flashDone('Copied'));
  };
  const filterLabel = [starredOnly ? 'Starred' : '', area !== 'All' ? area : '', source, q ? `“${query.trim()}”` : '', bounds ? RANGES.find(r => r.value === range)!.label : '']
    .filter(Boolean).join(' · ') || 'All notes';
  const saveToSecondBrain = () => {
    const parts: string[] = [];
    let lastHeading = '';
    for (const n of showing) {
      const heading = n.dated ? longDate(n.date) : 'Standing notes';
      if (heading !== lastHeading) { parts.push(`<h3>${escapeHtml(heading)}</h3>`); lastHeading = heading; }
      parts.push(`<p><strong>${escapeHtml(n.source)}${about(n) ? ` — ${escapeHtml(about(n))}` : ''}</strong><br>${escapeHtml(n.text).replace(/\n/g, '<br>')}</p>`);
    }
    const note = newRecord<Note>({
      title: `Notes — ${filterLabel} (${shortDate(isoOf(new Date()))})`, body: parts.join(''), tags: ['all-notes'], pinned: false,
      workspaceId: data.settings.activeSecondBrainWorkspaceId ?? DEFAULT_WORKSPACE_ID
    });
    void upsert('notes', note);
    flashDone('Saved to Second Brain');
  };

  const renderPart = (n: LoggedNote, p: NotePart, i: number, single: boolean) => {
    const key = `${n.id}#${i}`;
    const isEditing = editing?.key === key;
    const long = isLong(p.text, compact);
    const open = expanded.has(key);
    const toggle = () => setExpanded(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    // Formatted notes are edited in their own editor (there's no rich-text box here).
    const editable = Boolean(p.target) && !p.html;
    const clamp = long && !open ? (compact ? 'clamped-1' : 'clamped') : '';
    // Short notes under an exercise ("10-10" per set) read better on one line beside its name.
    const lines = p.text.split('\n');
    if (p.label && !isEditing && !p.html && lines.length <= 6 && lines.every(l => l.length <= 16)) {
      return (
        <div className="allnotes-part inline" key={key}>
          <b>{highlight(p.label, q)}</b>
          <span className="allnotes-text">{highlight(lines.join('  ·  '), q)}</span>
          {editable && (
            <button type="button" className="allnotes-icon" onClick={e => { e.stopPropagation(); setEditing({ key, draft: p.text }); }} aria-label="Edit this note" title="Edit here">
              <Pencil size={13} />
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="allnotes-part" key={key}>
        {/* A card's only note keeps its pencil up in the header row; a workout's exercises each get their own. */}
        {(p.label || (editable && !single)) && (
          <span className="allnotes-part-head">
            {p.label && <b>{highlight(p.label, q)}</b>}
            {editable && !single && !isEditing && (
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
        ) : p.html && !q && !compact ? (
          <div className={`allnotes-text allnotes-rich ${long && !open ? 'clamped-rich' : ''}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(p.html) }} />
        ) : (
          <span className={`allnotes-text ${clamp}`}>{highlight(p.text, q)}</span>
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
    const single = n.parts.length === 1;
    const first = n.parts[0];
    const own = n.jump.page === 'All Notes'; // a day note: it lives here, so tapping edits it
    const canEditFirst = single && Boolean(first.target) && !first.html;
    const startEdit = () => setEditing({ key: `${n.id}#0`, draft: first.text });
    const activate = () => { if (own) { if (canEditFirst) startEdit(); } else onOpen(n); };
    return (
      <div
        key={n.id}
        data-note-id={n.id}
        className={`allnotes-item ${isStarred ? 'starred' : ''} ${flashId === n.id ? 'flash' : ''} ${own ? 'own' : ''}`}
        role="button"
        tabIndex={0}
        onClick={e => {
          // A link inside the note, or dragging to select its text, isn't a tap on the card.
          if ((e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
          if (editing?.key.startsWith(`${n.id}#`)) return;
          activate();
        }}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } }}
        title={own ? 'Tap to edit' : `Open in ${n.jump.page}${n.jump.tab ? ` → ${n.jump.tab}` : ''}`}
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
          <span className="allnotes-actions">
            {canEditFirst && (
              <button type="button" className="allnotes-icon" onClick={e => { e.stopPropagation(); startEdit(); }} aria-label="Edit this note" title="Edit here">
                <Pencil size={13} />
              </button>
            )}
            {!own && <ArrowUpRight size={14} className="allnotes-go" />}
          </span>
        </span>
        {n.parts.map((p, i) => renderPart(n, p, i, single))}
        {n.images && !compact && (
          <span className="allnotes-images">
            {n.images.slice(0, 3).map((img, i) => (
              <button type="button" key={i} onClick={e => { e.stopPropagation(); setLightbox({ images: n.images!, index: i }); }} title={img.label || 'Screenshot — tap to enlarge'} aria-label={img.label || `Screenshot ${i + 1}`}>
                <img src={img.src} alt={img.label ?? ''} loading="lazy" />
              </button>
            ))}
            {n.images.length > 3 && (
              <button type="button" className="allnotes-images-more" onClick={e => { e.stopPropagation(); setLightbox({ images: n.images!, index: 3 }); }} aria-label={`${n.images.length - 3} more screenshots`}>
                +{n.images.length - 3}
              </button>
            )}
          </span>
        )}
      </div>
    );
  };

  const nothing = !timeline.length && !standing.length;
  const standingTotal = useMemo(() => all.filter(n => !n.dated).length, [all]);
  const goToStanding = () => {
    setView({ standingOpen: true, range: 'all' });
    window.setTimeout(() => standingRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
  };

  const activeFilters = (range !== 'all' ? 1 : 0) + (oldestFirst ? 1 : 0) + (compact ? 1 : 0);
  const clearFilters = () => { setView({ area: 'All', source: '', query: '', range: 'all', from: '', to: '', starredOnly: false }); setShown(PAGE_SIZE); };
  const liveAreas = NOTE_AREAS.filter(a => counts.get(a));
  const emptyAreas = NOTE_AREAS.filter(a => !counts.get(a));
  const starredNotes = useMemo(() => all.filter(n => starred.has(n.id)), [all, starred]);
  const goToMonth = (key: string) => {
    if (!monthOpen(key)) toggleMonth(key);
    window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>(`[data-month="${key}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60);
  };
  const dayLabel = (iso: string): [string, string] => {
    const d = dateOf(iso);
    const today = new Date();
    const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
    if (d.toDateString() === today.toDateString()) return ['Today', `${wd}, ${md}`];
    if (d.toDateString() === yesterday.toDateString()) return ['Yesterday', `${wd}, ${md}`];
    return [wd, md];
  };
  // Changing a filter re-keys the list so it fades in rather than snapping (typing in search doesn't).
  const listKey = `${area}|${source}|${range}|${from}|${to}|${starredOnly}|${oldestFirst}|${compact}`;

  return (
    <div ref={rootRef} className={`allnotes-root ${compact ? 'allnotes-compact' : ''}`}>
      <PageHeader
        title="All Notes"
        subtitle={`Every note you've written across the app, in one place — ${all.length} so far. Tap one to open where it was written.`}
        action={showing.length > 0 ? (
          <div className="allnotes-menu-wrap">
            <button type="button" className="icon-btn allnotes-share" onClick={() => setMenuOpen(o => !o)} aria-haspopup="menu" aria-expanded={menuOpen}
              aria-label={`Copy or save the ${showing.length} notes showing`} title={done ?? `Copy or save the ${showing.length} notes showing`}>
              {done ? <Check size={17} /> : <Share size={17} />}
            </button>
            {menuOpen && (
              <>
                <div className="allnotes-menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="allnotes-menu" role="menu">
                  <span className="allnotes-menu-title">{showing.length} note{showing.length === 1 ? '' : 's'} showing</span>
                  <button type="button" role="menuitem" onClick={copyText}><FileText size={15} /> Copy as text</button>
                  <button type="button" role="menuitem" onClick={copyRows}><ClipboardCopy size={15} /> Copy for a spreadsheet</button>
                  <button type="button" role="menuitem" onClick={saveToSecondBrain}><BookmarkPlus size={15} /> Save as a Second Brain note</button>
                </div>
              </>
            )}
          </div>
        ) : undefined}
      />
      {done && <p className="allnotes-done" role="status"><Check size={14} /> {done}</p>}

      <div className="allnotes-sticky" ref={stickyRef}>
        <div className="allnotes-bar">
          <label className="allnotes-search">
            <Search size={15} />
            <input
              ref={searchRef} type="search" value={query} placeholder="Search notes — words, or a day like “sep 29”" aria-label="Search notes"
              onChange={e => { setView({ query: e.target.value }); setShown(PAGE_SIZE); }}
              onKeyDown={e => { if (e.key === 'Escape') { setView({ query: '' }); e.currentTarget.blur(); } }}
            />
            {query ? <button type="button" onClick={() => setView({ query: '' })} aria-label="Clear search"><X size={14} /></button> : <kbd>/</kbd>}
          </label>
          <button type="button" className={`btn ghost allnotes-bar-btn ${filtersOpen ? 'on' : ''}`} onClick={() => setFiltersOpen(o => !o)} aria-expanded={filtersOpen} title="Date range, order and view">
            <SlidersHorizontal size={15} /> <span>Filters</span>{activeFilters > 0 && <i>{activeFilters}</i>}
          </button>
          <button type="button" className="btn primary allnotes-bar-btn" onClick={() => { setDraftDate(isoOf(new Date())); setComposing(c => !c); }} aria-expanded={composing} title="Write a note for today">
            <Plus size={16} /> <span>Note</span>
          </button>
        </div>
        <div className="allnotes-chips allnotes-chips-main">
          <button type="button" className={`chip ${area === 'All' && !starredOnly ? 'active' : ''}`} onClick={() => { setView({ area: 'All', source: '', starredOnly: false }); setShown(PAGE_SIZE); }}>All <i>{all.length}</i></button>
          {starredCount > 0 && (
            <button type="button" className={`chip allnotes-chip-star ${starredOnly ? 'active' : ''}`} onClick={() => { setView({ starredOnly: !starredOnly }); setShown(PAGE_SIZE); }}>
              <Star size={12} fill="currentColor" /> Starred <i>{starredCount}</i>
            </button>
          )}
          {liveAreas.map(a => (
            <button type="button" key={a} className={`chip ${area === a ? 'active' : ''}`} onClick={() => { setView({ area: a, source: '' }); setShown(PAGE_SIZE); }}>{a} <i>{counts.get(a)}</i></button>
          ))}
          {standingTotal > 0 && (
            <button type="button" className="chip allnotes-chip-standing" onClick={goToStanding} title="Notes on things with no date of their own — jump to them">
              Standing <i>{standingTotal}</i>
            </button>
          )}
          {/* Nothing in these yet — kept at the end so it's clear they're covered. */}
          {emptyAreas.map(a => (
            <button type="button" key={a} className="chip" disabled title={`Nothing yet — this collects ${NOTE_AREA_HINTS[a]}`}>{a}</button>
          ))}
        </div>
      </div>

      {filtersOpen && (
        <div className="allnotes-filters">
          <label>
            <span>When</span>
            <select value={range} onChange={e => { setView({ range: e.target.value as Range }); setShown(PAGE_SIZE); }} aria-label="Date range">
              {RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          {range === 'custom' && (
            <span className="allnotes-range">
              {/* The app's own calendar, with the days that have notes marked. */}
              <DatePicker value={from} onChange={v => setView({ from: v, to: to && v && to < v ? v : to })} placeholder="From" markedDates={noteDates} markedLabel="Has notes" allowClear />
              <span className="muted">to</span>
              <DatePicker value={to} onChange={v => setView({ to: v, from: from && v && from > v ? v : from })} placeholder="To" markedDates={noteDates} markedLabel="Has notes" allowClear />
            </span>
          )}
          <label>
            <span>Order</span>
            <span className="segmented">
              <button type="button" className={!oldestFirst ? 'on' : ''} onClick={() => setView({ oldestFirst: false })}>Newest</button>
              <button type="button" className={oldestFirst ? 'on' : ''} onClick={() => setView({ oldestFirst: true })}>Oldest</button>
            </span>
          </label>
          <label>
            <span>View</span>
            <span className="segmented">
              <button type="button" className={!compact ? 'on' : ''} onClick={() => setView({ compact: false })}>Full</button>
              <button type="button" className={compact ? 'on' : ''} onClick={() => setView({ compact: true })}>Compact</button>
            </span>
          </label>
          {activeFilters > 0 && (
            <button type="button" className="text-btn" onClick={() => setView({ range: 'all', from: '', to: '', oldestFirst: false, compact: false })}>Reset</button>
          )}
        </div>
      )}

      {sources.length > 1 && (
        <div className="allnotes-chips allnotes-subchips">
          {sources.map(([src, count]) => (
            <button type="button" key={src} className={`chip ${source === src ? 'active' : ''}`} onClick={() => { setView({ source: source === src ? '' : src }); setShown(PAGE_SIZE); }}>{src} <i>{count}</i></button>
          ))}
        </div>
      )}

      {composing && (
        <div className="allnotes-compose">
          <textarea
            autoFocus rows={3} value={draft} placeholder="How did today go? Anything to remember?"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addDayNote();
              if (e.key === 'Escape' && !draft.trim()) setComposing(false);
            }}
          />
          <div className="allnotes-compose-row">
            <span className="allnotes-range"><DatePicker value={draftDate} onChange={v => setDraftDate(v || isoOf(new Date()))} /></span>
            <button type="button" className="btn ghost" onClick={() => { setComposing(false); setDraft(''); }}>Cancel</button>
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={addDayNote}>Save note</button>
          </div>
        </div>
      )}

      <div className="allnotes-layout">
        <div className="allnotes-main">
          {onThisDay.length > 0 && !narrowing && area === 'All' && (
            <section className={`allnotes-onthisday ${otdOpen ? 'open' : ''}`}>
              <button type="button" className="allnotes-otd-strip" onClick={() => setOtdOpen(o => !o)} aria-expanded={otdOpen}>
                {otdOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <b>On this day</b>
                {!otdOpen && <span>{onThisDay[0].label}: {onThisDay[0].note.parts[0].text.split('\n')[0]}</span>}
                {!otdOpen && onThisDay.length > 1 && <i>+{onThisDay.length - 1}</i>}
              </button>
              {otdOpen && (
                <div className="allnotes-otd-list">
                  {onThisDay.map(({ label, note }) => (
                    <button type="button" key={note.id} className="allnotes-otd" onClick={() => reveal(note.id)}>
                      <span><b>{label}</b> · {shortDate(note.date)} · {note.source}</span>
                      <small>{note.parts[0].text}</small>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {nothing && (
            <div className="allnotes-empty">
              <NotebookText size={30} />
              <b>{all.length ? 'No notes match that' : 'No notes yet'}</b>
              <p>{all.length
                ? 'Try a different word, or loosen the filters.'
                : 'Anything you type into a Notes box — on a sleep night, a workout, a trading day, a bill — shows up here. Or write one now with “+ Note”.'}</p>
              {all.length > 0 && <button type="button" className="btn ghost" onClick={clearFilters}>Clear filters</button>}
            </div>
          )}

          <div className="allnotes-days" key={listKey}>
            {months.map(m => {
              const open = monthOpen(m.key);
              if (open && budget <= 0) return null;
              return (
                <section key={m.key} className="allnotes-month" data-month={m.key}>
                  <button type="button" className="allnotes-month-head" onClick={() => toggleMonth(m.key)} aria-expanded={open} disabled={narrowing}>
                    {!narrowing && (open ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
                    <b>{monthLabel(m.key)}</b>
                    <span>{m.total} note{m.total === 1 ? '' : 's'}</span>
                  </button>
                  {open && (
                    <div className="allnotes-list allnotes-timeline">
                      {m.days.map(g => {
                        if (budget <= 0) return null;
                        const notes = g.notes.slice(0, budget);
                        budget -= notes.length;
                        const [strong, rest] = dayLabel(g.date);
                        return (
                          <div key={g.date} className="allnotes-dayrow">
                            <div className="allnotes-date" title={dayHeading(g.date)}><b>{strong}</b><small>{rest}</small></div>
                            <div className="allnotes-daynotes">{notes.map(renderNote)}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {budget <= 0 && timeline.length > shown && (
            <button type="button" className="btn ghost allnotes-more" onClick={() => setShown(n => n + PAGE_SIZE)}>Show older notes</button>
          )}

          {standing.length > 0 && (
            <section className="allnotes-standing" ref={standingRef}>
              <button type="button" className="allnotes-month-head" onClick={() => setView({ standingOpen: !standingOpen })} aria-expanded={standingOpen || Boolean(q)} disabled={Boolean(q)}>
                {!q && (standingOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
                <b>Standing notes</b>
                <span>{standing.length} · on things with no date of their own (accounts, bills, programs, people…)</span>
              </button>
              {(standingOpen || q) && (
                <div className="allnotes-list allnotes-timeline">
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

        {/* Wide screens: the space beside the notes holds a month index and your starred notes. */}
        {(months.length > 1 || starredNotes.length > 0) && (
          <aside className="allnotes-rail" aria-label="Jump to">
            {months.length > 1 && (
              <div>
                <h3>Jump to</h3>
                {months.map(m => (
                  <button type="button" key={m.key} onClick={() => goToMonth(m.key)}><span>{monthLabel(m.key)}</span><i>{m.total}</i></button>
                ))}
                {standing.length > 0 && <button type="button" onClick={goToStanding}><span>Standing notes</span><i>{standing.length}</i></button>}
              </div>
            )}
            {starredNotes.length > 0 && (
              <div>
                <h3><Star size={12} fill="currentColor" /> Starred</h3>
                {starredNotes.slice(0, 8).map(n => (
                  <button type="button" key={n.id} className="allnotes-rail-note" onClick={() => reveal(n.id)} title={n.text}>
                    <span>{n.parts[0].text.split('\n')[0]}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>

      {lightbox && (
        <figure className="allnotes-lightbox" onClick={() => setLightbox(null)}>
          {lightbox.images.length > 1 && (
            <button type="button" className="allnotes-lightbox-nav prev" aria-label="Previous screenshot"
              onClick={e => { e.stopPropagation(); setLightbox({ ...lightbox, index: (lightbox.index - 1 + lightbox.images.length) % lightbox.images.length }); }}>
              <ChevronLeft size={22} />
            </button>
          )}
          <div>
            <img src={lightbox.images[lightbox.index].src} alt={lightbox.images[lightbox.index].label ?? 'Screenshot'} />
            <figcaption>
              {lightbox.images[lightbox.index].label}
              {lightbox.images.length > 1 && <span> {lightbox.index + 1} of {lightbox.images.length}</span>}
            </figcaption>
          </div>
          {lightbox.images.length > 1 && (
            <button type="button" className="allnotes-lightbox-nav next" aria-label="Next screenshot"
              onClick={e => { e.stopPropagation(); setLightbox({ ...lightbox, index: (lightbox.index + 1) % lightbox.images.length }); }}>
              <ChevronRight size={22} />
            </button>
          )}
        </figure>
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
