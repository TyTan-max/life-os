// Every note typed anywhere in the app — a sleep night, a workout, a trading day, a bill — as one
// flat list, for the All Notes page. Second Brain notes aren't included: those are documents with
// their own home, not notes attached to a logged record.
import type { AppData, CollectionName } from '../types';
import type { Jump } from './jumpTo';
import { formatHours, isNap, sleepHours, sleepMinutes } from './sleep';

export type NoteArea = 'Journal' | 'Health' | 'Trading' | 'Finance' | 'People' | 'Backlog' | 'Plan';
export const NOTE_AREAS: NoteArea[] = ['Journal', 'Health', 'Trading', 'Finance', 'People', 'Backlog', 'Plan'];
/** What each area gathers — shown on a chip that has nothing in it yet. */
export const NOTE_AREA_HINTS: Record<NoteArea, string> = {
  Journal: 'notes you write on this page',
  Health: 'sleep, workouts, weigh-ins, glucose, medications',
  Trading: 'trading days',
  Finance: 'transactions, bills, accounts, savings goals',
  People: 'check-ins and contact notes in Personal CRM',
  Backlog: 'movies, games, books, bucket list',
  Plan: 'tasks, goals, calendar events'
};

/** Where a note's text is stored, so it can be edited from the All Notes page. */
export type NoteTarget =
  | { kind: 'field'; collection: CollectionName; id: string; field: string }
  | { kind: 'exerciseLog'; routineId: string; exerciseId: string; date: string };

export interface NotePart {
  /** Set when a card holds several notes (a workout's exercises). */
  label?: string;
  text: string;
  /** The original formatted version, when the note was written in a rich-text box. */
  html?: string;
  target?: NoteTarget;
}

export interface LoggedNote {
  id: string;
  area: NoteArea;
  /** What kind of record it's on: "Sleep", "Workout", "Trading day"… */
  source: string;
  /** The day it belongs to (YYYY-MM-DD). Standing notes carry when the record was last edited. */
  date: string;
  /** False for notes on things with no day of their own (an account, a medication, a program). */
  dated: boolean;
  /** One line saying which record: "5.2h sleep", "Netflix · $15.49"… */
  context: string;
  /** A short highlighted figure next to the context, e.g. a trading day's result. */
  badge?: { text: string; tone: 'pos' | 'neg' };
  /** Pictures that belong with the note (a trading day's screenshots). */
  images?: { src: string; label?: string }[];
  /** Cover art for the thing the note is about (a movie, game, book, bucket-list item). */
  cover?: string;
  parts: NotePart[];
  /** All parts as plain text, for searching and copying. */
  text: string;
  /** Where tapping it goes. */
  jump: Jump;
}

const day = (iso?: string) => (iso ?? '').slice(0, 10);
const has = (s?: string): s is string => Boolean(s && s.trim());
const money = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isHtml = (text: string) => /<[a-z][^>]*>/i.test(text);

/** #tags written inside a note — "#lesson", "#sleep". A leading letter, so "#1" isn't one. */
export const HASHTAG = /(^|\s)(#[a-zA-Z][\w-]{1,30})/g;
const tagCache = new Map<string, string[]>();
export function tagsOf(text: string): string[] {
  let tags = tagCache.get(text);
  if (!tags) {
    tags = [...new Set(Array.from(text.matchAll(HASHTAG), m => m[2].slice(1).toLowerCase()))];
    if (tagCache.size > 5000) tagCache.clear();
    tagCache.set(text, tags);
  }
  return tags;
}

// A few notes boxes are rich-text editors and store HTML. For searching, copying and previews
// they're flattened: block ends and table rows become line breaks, cells are spaced apart.
export function toPlainText(text: string): string {
  if (!isHtml(text)) return text.trim();
  return text
    .replace(/<\/(td|th)>/gi, '   ')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

type Draft = Omit<LoggedNote, 'text' | 'parts' | 'dated'> & { dated?: boolean; raw?: string; target?: NoteTarget; parts?: NotePart[] };

export function collectLoggedNotes(data: AppData): LoggedNote[] {
  const out: LoggedNote[] = [];
  const part = (raw: string, target?: NoteTarget, label?: string): NotePart | null => {
    if (!has(raw)) return null;
    const text = toPlainText(raw);
    if (!text) return null;
    return { label, text, html: isHtml(raw) ? raw : undefined, target };
  };
  const add = ({ raw, target, parts, dated = true, ...rest }: Draft) => {
    const list = parts ?? [part(raw ?? '', target)].filter((p): p is NotePart => p !== null);
    if (!list.length || !rest.date) return;
    out.push({ ...rest, dated, parts: list, text: list.map(p => (p.label ? `${p.label}: ${p.text}` : p.text)).join('\n') });
  };
  const field = (collection: CollectionName, id: string, name = 'notes'): NoteTarget => ({ kind: 'field', collection, id, field: name });
  const edited = (r: { updatedAt?: string; createdAt: string }) => day(r.updatedAt ?? r.createdAt);

  // ---- Journal ---- (written on the All Notes page itself; tapping one edits it there)
  for (const d of data.dayNotes ?? []) {
    add({ id: `day:${d.id}`, area: 'Journal', source: 'Day note', date: d.date, raw: d.text, target: field('dayNotes', d.id, 'text'),
      context: '', jump: { page: 'All Notes' } });
  }

  // ---- Health ----
  for (const e of data.sleepEntries) {
    add({ id: `sleep:${e.id}`, area: 'Health', source: isNap(e) ? 'Nap' : 'Sleep', date: e.date, raw: e.notes, target: field('sleepEntries', e.id),
      context: isNap(e) ? `${formatHours(sleepMinutes(e) / 60)} nap` : `${sleepHours(e)}h sleep${e.quality != null ? ` · quality ${e.quality}/10` : ''}`,
      jump: { page: 'Health', tab: 'Sleep', date: e.date } });
  }
  for (const w of data.workouts) {
    add({ id: `workout:${w.id}`, area: 'Health', source: 'Workout', date: w.date, raw: w.notes, target: field('workouts', w.id),
      context: `${w.type} · ${w.durationMin} min`, jump: { page: 'Health', tab: 'Fitness', date: w.date } });
  }
  for (const r of data.workoutRoutines) {
    const names = new Map<string, string>();
    const order = new Map<string, number>();
    for (const v of r.versions) for (const d of v.days) for (const ex of d.exercises) { names.set(ex.id, ex.name); if (!order.has(ex.id)) order.set(ex.id, order.size); }
    // One card per program per day: every exercise's note for that session together.
    const byDate = new Map<string, NotePart[]>();
    for (const l of [...r.exerciseLogs].sort((a, b) => (order.get(a.exerciseId) ?? 0) - (order.get(b.exerciseId) ?? 0))) {
      const weights = l.weights.filter(w => w != null).join(' / ');
      const p = part(l.notes ?? '', { kind: 'exerciseLog', routineId: r.id, exerciseId: l.exerciseId, date: l.date },
        `${names.get(l.exerciseId) ?? 'Exercise'}${weights ? ` · ${weights} lb` : ''}`);
      if (!p) continue;
      if (!byDate.has(l.date)) byDate.set(l.date, []);
      byDate.get(l.date)!.push(p);
    }
    for (const [date, parts] of byDate) {
      add({ id: `sets:${r.id}:${date}`, area: 'Health', source: 'Workout', date, parts,
        context: `${r.name || 'Workout program'} · ${parts.length} exercise${parts.length === 1 ? '' : 's'}`,
        jump: { page: 'Health', tab: 'Fitness', date } });
    }
    add({ id: `routine:${r.id}`, area: 'Health', source: 'Program', date: edited(r), dated: false, raw: r.progressionNotes,
      target: field('workoutRoutines', r.id, 'progressionNotes'), context: r.name || 'Workout program', jump: { page: 'Health', tab: 'Fitness' } });
  }
  for (const w of data.weightEntries) {
    add({ id: `weight:${w.id}`, area: 'Health', source: 'Weigh-in', date: w.date, raw: w.notes, target: field('weightEntries', w.id),
      context: `${w.weight} ${data.settings.weightUnit ?? 'lb'}`, jump: { page: 'Health', tab: 'Weight', date: w.date } });
  }
  for (const g of data.glucoseEntries) {
    add({ id: `glucose:${g.id}`, area: 'Health', source: 'Glucose', date: g.date, raw: g.notes, target: field('glucoseEntries', g.id),
      context: `${g.value} ${data.settings.glucoseUnit ?? 'mg/dL'}${g.context ? ` · ${g.context}` : ''}`, jump: { page: 'Health', tab: 'Weight', date: g.date } });
  }
  for (const m of data.medications) {
    add({ id: `med:${m.id}`, area: 'Health', source: 'Medication', date: edited(m), dated: false, raw: m.notes, target: field('medications', m.id),
      context: `${m.name}${m.dosage ? ` · ${m.dosage}` : ''}`, jump: { page: 'Health', tab: 'Medication' } });
  }

  // ---- Trading ----
  for (const l of data.dailyLogs) {
    add({ id: `trade:${l.id}`, area: 'Trading', source: 'Trading day', date: l.date, raw: l.notes, target: field('dailyLogs', l.id),
      context: `${l.totalTrades} trade${l.totalTrades === 1 ? '' : 's'}${l.emotion ? ` · ${l.emotion}` : ''}`,
      badge: { text: `${l.dailyPL >= 0 ? '+' : '−'}${money(l.dailyPL)}`, tone: l.dailyPL >= 0 ? 'pos' : 'neg' },
      images: l.screenshots?.length ? l.screenshots.map(s => ({ src: s.src, label: s.label })) : undefined,
      jump: { page: 'Trading Journal', collection: 'dailyLogs', id: l.id, date: l.date } });
  }

  // ---- Finance ----
  for (const t of data.transactions) {
    add({ id: `tx:${t.id}`, area: 'Finance', source: 'Transaction', date: t.date, raw: t.notes, target: field('transactions', t.id),
      context: `${t.merchant} · ${money(t.amount)}`,
      jump: { page: 'Finance', tab: 'Transactions', collection: 'transactions', id: t.id, date: t.date, search: t.merchant } });
  }
  for (const b of data.bills) {
    const sub = b.kind === 'Subscription';
    add({ id: `bill:${b.id}`, area: 'Finance', source: sub ? 'Subscription' : 'Bill', date: edited(b), dated: false, raw: b.notes, target: field('bills', b.id),
      context: `${b.name} · ${money(b.amount)}`, jump: { page: 'Finance', tab: sub ? 'Subscriptions' : 'Bills', collection: 'bills', id: b.id } });
  }
  for (const a of data.financeAccounts) {
    add({ id: `acct:${a.id}`, area: 'Finance', source: 'Account', date: edited(a), dated: false, raw: a.notes, target: field('financeAccounts', a.id),
      context: a.name, jump: { page: 'Finance', tab: 'Accounts', collection: 'financeAccounts', id: a.id } });
  }
  for (const g of data.financeGoals) {
    add({ id: `fgoal:${g.id}`, area: 'Finance', source: 'Savings goal', date: edited(g), dated: false, raw: g.notes, target: field('financeGoals', g.id),
      context: `${g.name} · ${money(g.currentAmount)} of ${money(g.targetAmount)}`, jump: { page: 'Finance', tab: 'Savings', collection: 'financeGoals', id: g.id } });
  }

  // ---- People ----
  const contactName = new Map(data.contacts.map(c => [c.id, c.name]));
  for (const i of data.contactInteractions) {
    const name = contactName.get(i.contactId) ?? 'Contact';
    const jump: Jump = { page: 'Personal CRM', collection: 'contacts', id: i.contactId };
    if (has(i.notes)) {
      add({ id: `int:${i.id}`, area: 'People', source: i.type, date: i.date, raw: i.notes, target: field('contactInteractions', i.id),
        context: `${name}${has(i.summary) ? ` — ${i.summary}` : ''}`, jump });
    } else {
      add({ id: `int:${i.id}`, area: 'People', source: i.type, date: i.date, raw: i.summary, target: field('contactInteractions', i.id, 'summary'), context: name, jump });
    }
  }
  for (const c of data.contacts) {
    const jump: Jump = { page: 'Personal CRM', collection: 'contacts', id: c.id };
    add({ id: `cp:${c.id}`, area: 'People', source: 'Personal notes', date: edited(c), dated: false, raw: c.personalNotes, target: field('contacts', c.id, 'personalNotes'), context: c.name, jump });
    add({ id: `cb:${c.id}`, area: 'People', source: 'Business notes', date: edited(c), dated: false, raw: c.businessNotes, target: field('contacts', c.id, 'businessNotes'), context: c.name, jump });
  }

  // ---- Backlog ---- (a finished item's note belongs to the day it was finished)
  for (const m of data.movies) {
    add({ id: `movie:${m.id}`, area: 'Backlog', source: m.mediaType ?? 'Movie', date: day(m.dateCompleted) || edited(m), dated: Boolean(m.dateCompleted), raw: m.notes,
      cover: m.coverArt, target: field('movies', m.id), context: `${m.title}${m.rating != null ? ` · ${m.rating}/10` : ''}`, jump: { page: 'Movies', collection: 'movies', id: m.id } });
  }
  for (const g of data.videogames) {
    add({ id: `game:${g.id}`, area: 'Backlog', source: 'Game', date: day(g.dateCompleted) || edited(g), dated: Boolean(g.dateCompleted), raw: g.notes,
      cover: g.coverArt, target: field('videogames', g.id), context: `${g.title}${g.rating != null ? ` · ${g.rating}/10` : ''}`, jump: { page: 'Videogames', collection: 'videogames', id: g.id } });
  }
  for (const b of data.books) {
    add({ id: `book:${b.id}`, area: 'Backlog', source: 'Book', date: day(b.dateFinished) || edited(b), dated: Boolean(b.dateFinished), raw: b.notes,
      cover: b.coverArt, target: field('books', b.id), context: `${b.title}${b.author ? ` · ${b.author}` : ''}`, jump: { page: 'Books', collection: 'books', id: b.id } });
  }
  for (const b of data.bucketList) {
    const jump: Jump = { page: 'Travel & Bucket List', collection: 'bucketList', id: b.id };
    add({ id: `bucket:${b.id}`, area: 'Backlog', source: 'Bucket list', date: edited(b), dated: false, raw: b.notes, cover: b.coverArt, target: field('bucketList', b.id), context: b.title, jump });
    add({ id: `reflect:${b.id}`, area: 'Backlog', source: 'Reflection', date: day(b.achievedAt) || edited(b), dated: Boolean(b.achievedAt), raw: b.reflection,
      images: b.memoryPhotos?.length ? b.memoryPhotos.map(src => ({ src })) : undefined,
      target: field('bucketList', b.id, 'reflection'), context: b.title, jump });
  }

  // ---- Plan ----
  for (const t of data.tasks) {
    add({ id: `task:${t.id}`, area: 'Plan', source: 'Task', date: edited(t), dated: false, raw: t.notes, target: field('tasks', t.id),
      context: `${t.title} · ${t.status}`, jump: { page: 'Second Brain', tab: 'Tasks' } });
  }
  for (const g of data.goals) {
    add({ id: `goal:${g.id}`, area: 'Plan', source: 'Goal', date: edited(g), dated: false, raw: g.notes, target: field('goals', g.id),
      context: g.title, jump: { page: 'Second Brain', tab: 'Goals' } });
  }
  for (const e of data.events) {
    add({ id: `event:${e.id}`, area: 'Plan', source: 'Event', date: e.date, raw: e.notes, target: field('events', e.id),
      context: `${e.title}${e.startTime ? ` · ${e.startTime}` : ''}`, jump: { page: 'Calendar', collection: 'events', id: e.id, date: e.date } });
  }

  return out.sort((a, b) => b.date.localeCompare(a.date) || a.area.localeCompare(b.area));
}
