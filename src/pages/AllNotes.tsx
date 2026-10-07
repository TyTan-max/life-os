import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowUp, ArrowUpRight, Bell, BookmarkPlus, CalendarDays, CalendarRange, Check, CheckSquare, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardCopy, FileText, ListChecks, ListTodo, NotebookText, Pencil, Plus, Search, Share, SlidersHorizontal, Square, Star, Trash2, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Modal, PageHeader } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor, isEmptyHtml, sanitizeHtml } from '../components/RichTextEditor';
import { DEFAULT_WORKSPACE_ID } from '../storage';
import { HASHTAG, NOTE_AREAS, NOTE_AREA_HINTS, collectLoggedNotes, tagsOf, type LoggedNote, type NoteArea, type NotePart, type NoteTarget } from '../lib/loggedNotes';
import { escapeHtml } from '../lib/markdown';
import type { CollectionName, CollectionRecord, DayNote, Note, Task, WorkoutRoutine } from '../types';

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
  area: NoteArea | 'All'; source: string; tag: string; query: string; range: Range; from: string; to: string;
  oldestFirst: boolean; starredOnly: boolean; compact: boolean;
  openMonths: string[]; closedMonths: string[]; standingOpen: boolean; scrollY: number;
}
// Kept for the session, so coming back from a note you jumped to lands where you left off.
let saved: ViewState = {
  area: 'All', source: '', tag: '', query: '', range: 'all', from: '', to: '', oldestFirst: false, starredOnly: false, compact: false,
  openMonths: [], closedMonths: [], standingOpen: false, scrollY: 0
};

// How you like to read the list sticks between visits and reloads.
const PREFS_KEY = 'lifeos.allnotes.prefs';
try {
  const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as { compact?: boolean; oldestFirst?: boolean } | null;
  if (prefs) saved = { ...saved, compact: Boolean(prefs.compact), oldestFirst: Boolean(prefs.oldestFirst) };
} catch { /* storage unavailable — defaults it is */ }

// Open with the "write a note" box showing (the Dashboard's "+ Note").
let composeRequested = false;
export function requestCompose(): void {
  composeRequested = true;
}

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

// Note text with the search match highlighted and any #tags turned into tappable filters.
function renderText(text: string, q: string, onTag: (tag: string) => void): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(HASHTAG)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start > last) out.push(<Fragment key={`t${last}`}>{highlight(text.slice(last, start), q)}</Fragment>);
    const tag = m[2];
    out.push(
      <button type="button" key={`h${start}`} className="allnotes-hashtag" onClick={e => { e.stopPropagation(); onTag(tag.slice(1).toLowerCase()); }} title={`Show notes tagged ${tag}`}>{tag}</button>
    );
    last = start + tag.length;
  }
  if (!out.length) return highlight(text, q);
  if (last < text.length) out.push(<Fragment key={`t${last}`}>{highlight(text.slice(last), q)}</Fragment>);
  return out;
}

const weekStartOf = (d: Date) => { const s = new Date(d); s.setHours(12, 0, 0, 0); s.setDate(s.getDate() - s.getDay()); return s; };

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
  const [view, setViewRaw] = useState<ViewState>(() => (focusId ? { ...saved, area: 'All', source: '', tag: '', query: '', range: 'all', starredOnly: false } : saved));
  const setView = (patch: Partial<ViewState>) => setViewRaw(prev => {
    saved = { ...prev, ...patch, scrollY: saved.scrollY };
    if ('compact' in patch || 'oldestFirst' in patch) {
      try { localStorage.setItem(PREFS_KEY, JSON.stringify({ compact: saved.compact, oldestFirst: saved.oldestFirst })); } catch { /* ignore */ }
    }
    return saved;
  });
  const [shown, setShown] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // `rich`: the note is formatted text, edited in the formatting editor. `date`: a day note's day.
  const [editing, setEditing] = useState<{ key: string; draft: string; rich?: boolean; date?: string } | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<string | null>(null);
  const [showTop, setShowTop] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: { src: string; label?: string }[]; index: number } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(() => saved.range === 'custom');
  const [otdOpen, setOtdOpen] = useState(false);
  const stickyRef = useRef<HTMLDivElement>(null);
  // Read here, cleared after mount: React's dev mode runs this initializer twice.
  const [composing, setComposing] = useState(() => composeRequested);
  useEffect(() => { composeRequested = false; }, []);
  const [draft, setDraft] = useState('');
  const [draftDate, setDraftDate] = useState(() => isoOf(new Date()));
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const standingRef = useRef<HTMLElement>(null);
  const { area, source, tag, query, range, from, to, oldestFirst, starredOnly, standingOpen, compact } = view;

  const all = useMemo(() => collectLoggedNotes(data), [data]);
  const noteDates = useMemo(() => [...new Set(all.filter(n => n.dated).map(n => n.date))], [all]);

  // Back where you were after visiting a note's page — unless a specific note was asked for.
  useLayoutEffect(() => {
    const scroller = scrollerOf(rootRef.current);
    if (saved.scrollY && !focusId) scroller.scrollTo(0, saved.scrollY);
    const remember = () => {
      saved.scrollY = scroller === window ? window.scrollY : (scroller as HTMLElement).scrollTop;
      setShowTop(saved.scrollY > 700);
    };
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

  // "/" jumps to the search box; j / k step through the notes; s stars and e edits the focused one.
  const keyActions = useRef<{ star: (id: string) => void; edit: (id: string) => void }>({ star: () => {}, edit: () => {} });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(document.activeElement) || document.querySelector('.modal-overlay')) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      const key = e.key.toLowerCase();
      if (!['j', 'k', 's', 'e'].includes(key)) return;
      const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.allnotes-item') ?? []);
      if (!items.length) return;
      const current = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.allnotes-item') ?? null;
      const index = current ? items.indexOf(current) : -1;
      if (key === 'j' || key === 'k') {
        e.preventDefault();
        const next = items[Math.max(0, Math.min(items.length - 1, index < 0 ? 0 : index + (key === 'j' ? 1 : -1)))];
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest' });
        return;
      }
      const id = current?.dataset.noteId;
      if (!id) return;
      e.preventDefault();
      if (key === 's') keyActions.current.star(id); else keyActions.current.edit(id);
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

  // #tags found anywhere in your notes, most used first.
  const tagCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of all) for (const t of tagsOf(n.text)) c.set(t, (c.get(t) ?? 0) + 1);
    return Array.from(c.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [all]);
  const pickTag = (t: string) => { setView({ tag: tag === t ? '' : t }); setShown(PAGE_SIZE); };

  const q = query.trim().toLowerCase();
  const bounds = rangeBounds(range, from, to);
  const matches = (n: LoggedNote) =>
    (area === 'All' || n.area === area)
    && (!source || n.source === source)
    && (!starredOnly || starred.has(n.id))
    && (!tag || tagsOf(n.text).includes(tag))
    && (!q || n.text.toLowerCase().includes(q) || n.context.toLowerCase().includes(q) || n.source.toLowerCase().includes(q)
      || (n.dated && dateWords(n.date).includes(q)));
  const timeline = useMemo(() => {
    const list = all.filter(n => n.dated && matches(n) && (!bounds || (n.date >= bounds[0] && n.date <= bounds[1])));
    return oldestFirst ? [...list].reverse() : list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, area, source, tag, starredOnly, q, range, from, to, oldestFirst, starred]);
  // Standing notes have no day, so a date filter leaves them out.
  const standing = useMemo(() => (bounds ? [] : all.filter(n => !n.dated && matches(n)).sort((a, b) => a.area.localeCompare(b.area) || a.context.localeCompare(b.context))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, area, source, tag, starredOnly, q, range, from, to, starred]);

  // Months: the two most recent with notes are open; older ones fold to a single line. While
  // searching or filtering, everything is open — you're looking for something.
  const narrowing = Boolean(q || source || tag || starredOnly || bounds);
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

  const save = async (target: NoteTarget, text: string, opts: { rich?: boolean; date?: string } = {}) => {
    const value = opts.rich ? (isEmptyHtml(text) ? '' : text) : text.trim();
    if (!value) {
      // A check-in needs its summary; anything else, make sure emptying it was meant.
      if (target.kind === 'field' && target.field === 'summary') return;
      if (!window.confirm('Remove this note? Saving it empty deletes the note’s text.')) return;
    }
    if (target.kind === 'field') {
      if (target.collection === 'dayNotes' && !value) { await remove('dayNotes', target.id); return; }
      const record = (data[target.collection] as CollectionRecord[]).find(r => r.id === target.id);
      if (!record) return;
      const moved = target.collection === 'dayNotes' && opts.date ? { date: opts.date } : {};
      await upsert(target.collection as CollectionName, { ...record, [target.field]: value || undefined, ...moved } as never);
    } else {
      const routine = data.workoutRoutines.find(r => r.id === target.routineId) as WorkoutRoutine | undefined;
      if (!routine) return;
      const exerciseLogs = routine.exerciseLogs
        .map(l => (l.exerciseId === target.exerciseId && l.date === target.date ? { ...l, notes: value || undefined } : l))
        .filter(l => l.notes || l.lastReps != null || l.weights.some(w => w != null));
      await upsert('workoutRoutines', { ...routine, exerciseLogs });
    }
  };

  const beginEdit = (key: string, p: NotePart) => {
    const t = p.target;
    const dayNote = t?.kind === 'field' && t.collection === 'dayNotes' ? data.dayNotes.find(d => d.id === t.id) : undefined;
    setEditing({ key, draft: p.html ?? p.text, rich: Boolean(p.html), date: dayNote?.date });
  };
  const commitEdit = (p: NotePart) => {
    if (!editing || !p.target) return;
    void save(p.target, editing.draft, { rich: editing.rich, date: editing.date });
    setEditing(null);
  };
  const deleteDayNote = (id: string) => {
    if (!window.confirm('Delete this note?')) return;
    void remove('dayNotes', id);
    setEditing(null);
  };
  keyActions.current = {
    star: id => toggleStar(id),
    edit: id => {
      const note = all.find(n => n.id === id);
      const i = note ? note.parts.findIndex(p => p.target) : -1;
      if (note && i >= 0) beginEdit(`${id}#${i}`, note.parts[i]);
    }
  };

  const addTask = (n: LoggedNote) => {
    const firstLine = n.parts[0].text.split('\n')[0].replace(/\s+/g, ' ').trim();
    const task = newRecord<Task>({
      title: firstLine.length > 120 ? `${firstLine.slice(0, 117).trimEnd()}…` : firstLine,
      status: 'Not Started', priority: 'Medium', dueDate: isoOf(new Date()),
      notes: `From a ${n.source.toLowerCase()} note${n.dated ? ` on ${shortDate(n.date)}` : ''}${n.context ? ` (${n.context})` : ''}:\n${n.text}`,
      workspaceId: data.settings.activeSecondBrainWorkspaceId ?? DEFAULT_WORKSPACE_ID
    });
    void upsert('tasks', task);
    flashDone('Task added — it’s in Second Brain → Tasks');
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
  const chosen = picked.size ? showing.filter(n => picked.has(n.id)) : showing;
  const togglePick = (id: string) => setPicked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const stopSelecting = () => { setSelecting(false); setPicked(new Set()); };
  const flashDone = (label: string) => { setDone(label); setMenuOpen(false); window.setTimeout(() => setDone(null), 2000); };
  const about = (n: LoggedNote) => [n.context, n.badge?.text].filter(Boolean).join(' ');
  const copyRows = () => {
    const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const rows = chosen.map(n => [n.dated ? n.date : '', n.area, n.source, about(n), n.text].map(cell).join('\t'));
    void navigator.clipboard?.writeText(['Date\tArea\tType\tAbout\tNote', ...rows].join('\n')).then(() => flashDone('Copied'));
  };
  const copyText = () => {
    const lines: string[] = [];
    let lastHeading = '';
    for (const n of chosen) {
      const heading = n.dated ? longDate(n.date) : 'Standing notes';
      if (heading !== lastHeading) { if (lines.length) lines.push(''); lines.push(heading); lastHeading = heading; }
      lines.push(`• ${n.source}${about(n) ? ` — ${about(n)}` : ''}`);
      for (const line of n.text.split('\n')) lines.push(`  ${line}`);
    }
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => flashDone('Copied'));
  };
  const filterLabel = [starredOnly ? 'Starred' : '', area !== 'All' ? area : '', source, tag ? `#${tag}` : '', q ? `“${query.trim()}”` : '', bounds ? RANGES.find(r => r.value === range)!.label : '']
    .filter(Boolean).join(' · ') || 'All notes';
  // One Second Brain note per title: saving the same view again refreshes that note.
  const saveNote = (title: string, body: string) => {
    const workspaceId = data.settings.activeSecondBrainWorkspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = data.notes.find(x => x.title === title && (x.tags ?? []).includes('all-notes') && (x.workspaceId ?? DEFAULT_WORKSPACE_ID) === workspaceId);
    if (existing) void upsert('notes', { ...existing, body });
    else void upsert('notes', newRecord<Note>({ title, body, tags: ['all-notes'], pinned: false, workspaceId }));
    flashDone(existing ? 'Second Brain note updated' : 'Saved to Second Brain');
  };
  const stamp = (count: number) => `<p><em>Updated ${escapeHtml(shortDate(isoOf(new Date())))} · ${count} note${count === 1 ? '' : 's'}</em></p>`;
  const saveToSecondBrain = () => {
    const parts: string[] = [stamp(chosen.length)];
    let lastHeading = '';
    for (const n of chosen) {
      const heading = n.dated ? longDate(n.date) : 'Standing notes';
      if (heading !== lastHeading) { parts.push(`<h3>${escapeHtml(heading)}</h3>`); lastHeading = heading; }
      parts.push(`<p><strong>${escapeHtml(n.source)}${about(n) ? ` — ${escapeHtml(about(n))}` : ''}</strong><br>${escapeHtml(n.text).replace(/\n/g, '<br>')}</p>`);
    }
    saveNote(`Notes — ${picked.size ? `${picked.size} picked from ${filterLabel}` : filterLabel}`, parts.join(''));
  };

  // ---- Weekly review: one week's notes, laid out by area ----
  const reviewNotes = useMemo(() => {
    if (!review) return [];
    const end = new Date(dateOf(review)); end.setDate(end.getDate() + 6);
    const endIso = isoOf(end);
    return all.filter(n => n.dated && n.date >= review && n.date <= endIso).sort((a, b) => a.date.localeCompare(b.date));
  }, [all, review]);
  const reviewByArea = NOTE_AREAS.map(a => ({ area: a, notes: reviewNotes.filter(n => n.area === a) })).filter(g => g.notes.length);
  const reviewTitle = review ? `Week of ${shortDate(review)}` : '';
  const shiftReview = (days: number) => { if (!review) return; const d = dateOf(review); d.setDate(d.getDate() + days); setReview(isoOf(d)); };
  const copyReview = () => {
    const lines: string[] = [reviewTitle];
    for (const g of reviewByArea) {
      lines.push('', g.area.toUpperCase());
      for (const n of g.notes) {
        lines.push(`• ${dateOf(n.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${n.source}${about(n) ? ` (${about(n)})` : ''}`);
        for (const line of n.text.split('\n')) lines.push(`  ${line}`);
      }
    }
    void navigator.clipboard?.writeText(lines.join('\n')).then(() => flashDone('Week copied'));
  };
  const saveReview = () => {
    const parts: string[] = [stamp(reviewNotes.length)];
    for (const g of reviewByArea) {
      parts.push(`<h3>${escapeHtml(g.area)}</h3>`);
      for (const n of g.notes) {
        const when = dateOf(n.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        parts.push(`<p><strong>${escapeHtml(when)} — ${escapeHtml(n.source)}${about(n) ? ` (${escapeHtml(about(n))})` : ''}</strong><br>${escapeHtml(n.text).replace(/\n/g, '<br>')}</p>`);
      }
    }
    saveNote(`Weekly review — ${reviewTitle}`, parts.join(''));
  };

  const renderPart = (n: LoggedNote, p: NotePart, i: number, single: boolean) => {
    const key = `${n.id}#${i}`;
    const isEditing = editing?.key === key;
    const long = isLong(p.text, compact);
    const open = expanded.has(key);
    const toggle = () => setExpanded(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    const editable = Boolean(p.target);
    const dayNoteId = p.target?.kind === 'field' && p.target.collection === 'dayNotes' ? p.target.id : null;
    const clamp = long && !open ? (compact ? 'clamped-1' : 'clamped') : '';
    // Short notes under an exercise ("10-10" per set) read better on one line beside its name.
    const lines = p.text.split('\n');
    if (p.label && !isEditing && !p.html && lines.length <= 6 && lines.every(l => l.length <= 16)) {
      return (
        <div className="allnotes-part inline" key={key}>
          <b>{highlight(p.label, q)}</b>
          <span className="allnotes-text">{renderText(lines.join('  ·  '), q, pickTag)}</span>
          {editable && (
            <button type="button" className="allnotes-icon" onClick={e => { e.stopPropagation(); beginEdit(key, p); }} aria-label="Edit this note" title="Edit here">
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
              <button type="button" className="allnotes-icon" onClick={e => { e.stopPropagation(); beginEdit(key, p); }} aria-label="Edit this note" title="Edit here">
                <Pencil size={13} />
              </button>
            )}
          </span>
        )}
        {isEditing ? (
          <div className="allnotes-edit" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            {editing.rich ? (
              <RichTextEditor value={editing.draft} onChange={html => setEditing(prev => (prev ? { ...prev, draft: html } : prev))} />
            ) : (
              <textarea
                autoFocus
                rows={Math.min(10, Math.max(2, editing.draft.split('\n').length + 1))}
                value={editing.draft}
                onChange={e => setEditing({ ...editing, draft: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Escape') setEditing(null);
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitEdit(p);
                }}
              />
            )}
            <div className="allnotes-edit-actions">
              {dayNoteId && (
                <>
                  <span className="allnotes-range"><DatePicker value={editing.date} onChange={v => setEditing({ ...editing, date: v || editing.date })} /></span>
                  <button type="button" className="btn ghost danger allnotes-edit-delete" onClick={() => deleteDayNote(dayNoteId)}><Trash2 size={14} /> Delete</button>
                </>
              )}
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => commitEdit(p)}>Save</button>
            </div>
          </div>
        ) : p.html && !q && !compact ? (
          <div className={`allnotes-text allnotes-rich ${long && !open ? 'clamped-rich' : ''}`} dangerouslySetInnerHTML={{ __html: sanitizeHtml(p.html) }} />
        ) : (
          <span className={`allnotes-text ${clamp}`}>{renderText(p.text, q, pickTag)}</span>
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
    const canEditFirst = single && Boolean(first.target);
    const startEdit = () => beginEdit(`${n.id}#0`, first);
    const isPicked = picked.has(n.id);
    const activate = () => { if (selecting) togglePick(n.id); else if (own) { if (canEditFirst) startEdit(); } else onOpen(n); };
    return (
      <div
        key={n.id}
        data-note-id={n.id}
        className={`allnotes-item ${isStarred ? 'starred' : ''} ${flashId === n.id ? 'flash' : ''} ${own ? 'own' : ''} ${isPicked ? 'picked' : ''}`}
        role="button"
        tabIndex={0}
        onClick={e => {
          // A link inside the note, or dragging to select its text, isn't a tap on the card.
          if ((e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
          if (editing?.key.startsWith(`${n.id}#`)) return;
          activate();
        }}
        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } }}
        title={selecting ? 'Tap to pick' : own ? 'Tap to edit' : `Open in ${n.jump.page}${n.jump.tab ? ` → ${n.jump.tab}` : ''}`}
      >
        {n.cover && !compact && <img className="allnotes-cover" src={n.cover} alt="" loading="lazy" />}
        <div className="allnotes-body">
        <span className="allnotes-meta">
          {selecting && (
            <span className={`allnotes-pick ${isPicked ? 'on' : ''}`} aria-hidden="true">{isPicked ? <CheckSquare size={16} /> : <Square size={16} />}</span>
          )}
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
            <button type="button" className="allnotes-icon" onClick={e => { e.stopPropagation(); addTask(n); }} aria-label="Add this as a task" title="Add as a task">
              <ListTodo size={13} />
            </button>
            {!own && <ArrowUpRight size={14} className="allnotes-go" />}
          </span>
        </span>
        {n.parts.map((p, i) => renderPart(n, p, i, single))}
        {n.images && !compact && (
          <span className="allnotes-images">
            {n.images.slice(0, 3).map((img, i) => (
              <button type="button" key={i} onClick={e => { e.stopPropagation(); setLightbox({ images: n.images!, index: i }); }} title={img.label || 'Screenshot — tap to enlarge'} aria-label={img.label || `Screenshot ${i + 1}`}>
                {/* A picture whose link has died hides its tile rather than showing a broken image. */}
                <img src={img.src} alt={img.label ?? ''} loading="lazy" onError={e => { const tile = e.currentTarget.closest('button'); if (tile) tile.style.display = 'none'; }} />
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
  const clearFilters = () => { setView({ area: 'All', source: '', tag: '', query: '', range: 'all', from: '', to: '', starredOnly: false }); setShown(PAGE_SIZE); };
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
  const listKey = `${area}|${source}|${tag}|${range}|${from}|${to}|${starredOnly}|${oldestFirst}|${compact}`;

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
                  <span className="allnotes-menu-title">{picked.size ? `${picked.size} picked` : `${showing.length} note${showing.length === 1 ? '' : 's'} showing`}</span>
                  <button type="button" role="menuitem" onClick={copyText}><FileText size={15} /> Copy as text</button>
                  <button type="button" role="menuitem" onClick={copyRows}><ClipboardCopy size={15} /> Copy for a spreadsheet</button>
                  <button type="button" role="menuitem" onClick={saveToSecondBrain}><BookmarkPlus size={15} /> Save as a Second Brain note</button>
                  <hr />
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); if (selecting) stopSelecting(); else setSelecting(true); }}>
                    <ListChecks size={15} /> {selecting ? 'Stop picking' : 'Pick specific notes…'}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setReview(isoOf(weekStartOf(new Date()))); }}>
                    <CalendarRange size={15} /> Weekly review
                  </button>
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
          {months.length > 1 && (
            <label className="btn ghost allnotes-bar-btn allnotes-jump" title="Jump to a month">
              <CalendarDays size={15} />
              <select
                value="" aria-label="Jump to a month"
                onChange={e => { const v = e.target.value; if (v === 'standing') goToStanding(); else if (v) goToMonth(v); }}
              >
                <option value="">Jump to…</option>
                {months.map(m => <option key={m.key} value={m.key}>{monthLabel(m.key)} ({m.total})</option>)}
                {standing.length > 0 && <option value="standing">Standing notes ({standing.length})</option>}
              </select>
            </label>
          )}
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

      {tagCounts.length > 0 && (
        <div className="allnotes-chips allnotes-subchips allnotes-tagchips">
          {tagCounts.slice(0, 24).map(([t, count]) => (
            <button type="button" key={t} className={`chip ${tag === t ? 'active' : ''}`} onClick={() => pickTag(t)}>#{t} <i>{count}</i></button>
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
          <label className="allnotes-remind">
            <Bell size={14} />
            <span>Remind me at</span>
            <input type="time" value={data.settings.dayNoteReminderTime ?? ''} onChange={e => void updateSettings({ dayNoteReminderTime: e.target.value || undefined })} aria-label="Reminder time" />
            <span>if I haven’t written one</span>
            {data.settings.dayNoteReminderTime && (
              <button type="button" className="text-btn" onClick={() => void updateSettings({ dayNoteReminderTime: undefined })}>Off</button>
            )}
            {data.settings.dayNoteReminderTime && !data.settings.notificationsEnabled && <em>Turn on notifications in Settings for this to fire.</em>}
          </label>
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
                  {standing.map((n, i) => (
                    <Fragment key={n.id}>
                      {(i === 0 || standing[i - 1].area !== n.area) && <h3 className="allnotes-standing-area">{n.area}</h3>}
                      <div className="allnotes-standing-row">
                        {renderNote(n)}
                        <small className="allnotes-edited">Last edited {shortDate(n.date)}</small>
                      </div>
                    </Fragment>
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

      {selecting && (
        <div className="allnotes-selectbar" role="toolbar" aria-label="Picked notes">
          <b>{picked.size ? `${picked.size} picked` : 'Tap notes to pick them'}</b>
          <button type="button" className="btn ghost" disabled={!picked.size} onClick={copyText}><FileText size={14} /> <span>Copy</span></button>
          <button type="button" className="btn ghost" disabled={!picked.size} onClick={copyRows}><ClipboardCopy size={14} /> <span>Spreadsheet</span></button>
          <button type="button" className="btn ghost" disabled={!picked.size} onClick={saveToSecondBrain}><BookmarkPlus size={14} /> <span>Save</span></button>
          <button type="button" className="btn primary" onClick={stopSelecting}>Done</button>
        </div>
      )}

      {showTop && !selecting && (
        <button type="button" className="allnotes-top" onClick={() => scrollerOf(rootRef.current).scrollTo({ top: 0, behavior: 'smooth' })} aria-label="Back to top" title="Back to top">
          <ArrowUp size={18} />
        </button>
      )}

      {review && (
        <Modal
          title="Weekly review" eyebrow={`${shortDate(review)} – ${(() => { const e = dateOf(review); e.setDate(e.getDate() + 6); return shortDate(isoOf(e)); })()}`}
          onClose={() => setReview(null)} size="wide"
          footer={<>
            <button type="button" className="btn ghost" disabled={!reviewNotes.length} onClick={copyReview}><FileText size={15} /> Copy</button>
            <button type="button" className="btn ghost" disabled={!reviewNotes.length} onClick={saveReview}><BookmarkPlus size={15} /> Save to Second Brain</button>
            <button type="button" className="btn primary" onClick={() => setReview(null)}>Done</button>
          </>}
        >
          <div className="allnotes-review">
            <div className="allnotes-review-nav">
              <button type="button" className="btn ghost" onClick={() => shiftReview(-7)}><ChevronLeft size={15} /> Earlier</button>
              <span>{reviewNotes.length} note{reviewNotes.length === 1 ? '' : 's'} this week</span>
              <button type="button" className="btn ghost" onClick={() => shiftReview(7)} disabled={review >= isoOf(weekStartOf(new Date()))}>Later <ChevronRight size={15} /></button>
            </div>
            {done && <p className="allnotes-done" role="status"><Check size={14} /> {done}</p>}
            {!reviewNotes.length && <p className="muted empty-state">Nothing written this week.</p>}
            {reviewByArea.map(g => (
              <section key={g.area}>
                <h3><span className={`allnotes-tag area-${g.area.toLowerCase()}`}>{g.area}</span> {g.notes.length}</h3>
                {g.notes.map(n => (
                  <div key={n.id} className="allnotes-review-note">
                    <small>{dateOf(n.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · {n.source}{about(n) ? ` · ${about(n)}` : ''}</small>
                    <p>{n.text}</p>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </Modal>
      )}

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
