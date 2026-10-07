import { useEffect, useMemo, useRef, useState } from 'react';
import { takeJumpFor } from '../lib/jumpTo';
import type { ChangeEvent } from 'react';
import {
  AlertTriangle, ArrowUp, ArrowUpDown, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Columns3, Globe, GripVertical, Image as ImageIcon,
  ImageOff, Images, LayoutGrid, List as ListIcon, MapPin, Pencil, PiggyBank, Plus, Search, Sparkles, Star, Trash2, Trophy, Undo2, Upload, Wallet, X,
  Copy as CopyIcon, Layers, Grid3x3
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { BucketListCategory, BucketListItem, BucketListStatus, BucketListSubtask, CostTier, FinanceGoal } from '../types';
import { Card, EmptyState, Modal, PageHeader, ProgressBar, formatCurrency, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor } from '../components/RichTextEditor';
import { toPlainText } from '../lib/loggedNotes';
import { continentOf, locate } from '../lib/worldMap';
import { BucketMap, type MapEntry } from '../components/BucketMap';
import { requestJump } from '../lib/jumpTo';
import { generateId } from '../utils/id';
import { useIsMobile } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';
import { useContextMenu } from '../components/ContextMenu';
import type { ContextMenuItem } from '../components/ContextMenu';
import { DISCOVERY_DECK, buildDeckPrompt, DECK_SYSTEM_PROMPT, parseDeckIdeas, type DeckIdea } from '../lib/bucketListDeck';
import { complete, loadSavedEngine, ENGINE_LABELS, ENGINE_STORAGE_KEY, type Engine } from '../lib/aiEngine';
import { coverQuery, isUnsplashConfigured, resolveCover, searchPhotos, type PhotoOption } from '../lib/unsplash';

const GENERATE_COUNT = 6;

const CATEGORIES: BucketListCategory[] = ['Travel', 'Experience', 'Skill', 'Other'];
const STATUSES: BucketListStatus[] = ['Someday', 'Planning', 'Achieved', 'Dropped'];
// The three a goal moves through; Dropped sits apart (no board column, not in "All").
const ACTIVE_STATUSES: BucketListStatus[] = ['Someday', 'Planning', 'Achieved'];

// With a budget on the goal, the $ / $$ / $$$ marker is worked out from it rather than set twice.
function costOf(item: Pick<BucketListItem, 'budget' | 'costTier'>): CostTier | undefined {
  if (item.budget == null || item.budget <= 0) return item.costTier;
  return item.budget < 750 ? '$' : item.budget < 3000 ? '$$' : '$$$';
}

// What you were looking at survives leaving the tab and coming back (for this session).
let savedFilters: { statusTab: 'All' | BucketListStatus; categoryTab: BucketListCategory | null; search: string } = { statusTab: 'All', categoryTab: null, search: '' };
const DECK_MODE_KEY = 'lifeos.bucketDeck.mode';
const COST_TIERS: CostTier[] = ['$', '$$', '$$$'];

type StatusTab = 'All' | BucketListStatus;
const STATUS_TABS: StatusTab[] = ['All', ...STATUSES];

type SortBy = 'smart' | 'recent' | 'title' | 'target' | 'custom';

const SORT_STORAGE_KEY = 'travel-sort-by';
const SORT_VALUES: SortBy[] = ['smart', 'recent', 'title', 'target', 'custom'];

// Sort choice lives in component state, which resets on unmount — switching tabs and back
// would otherwise silently drop back to "Recently updated" even though the underlying
// `order` values are still saved, making a custom drag order look like it didn't persist.
function loadSavedSort(): SortBy {
  const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
  return (SORT_VALUES as string[]).includes(saved ?? '') ? (saved as SortBy) : 'smart';
}

// The default order: what you're planning first (soonest date on top), then someday, then what's
// done (newest first) — with top picks leading their group. Unlike "recently updated", ticking a
// step or typing a reflection doesn't send the card to the front.
const STATUS_RANK: Record<BucketListStatus, number> = { Planning: 0, Someday: 1, Achieved: 2, Dropped: 3 };
function smartCompare(a: BucketListItem, b: BucketListItem): number {
  if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (Boolean(a.topPick) !== Boolean(b.topPick)) return a.topPick ? -1 : 1;
  if (a.status === 'Achieved') return (b.achievedAt ?? '').localeCompare(a.achievedAt ?? '');
  if (a.status === 'Planning') return (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999') || a.title.localeCompare(b.title);
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
}

const PACKING_BASICS = [
  'Passport / ID', 'Tickets & booking confirmations', 'Travel insurance', 'Phone charger & adapter',
  'Medications', 'Cards & some cash', 'Toiletries', 'Clothes for the weather'
];
const COVER_MAX_DIM = 1400;
const COVER_QUALITY = 0.82;

// A short burst when a goal is achieved. Skipped for anyone who's asked for less motion.
function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 44 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 0.25, duration: 1.1 + Math.random() * 0.8,
    hue: [42, 172, 238, 12, 280][i % 5], drift: (Math.random() - 0.5) * 160, spin: Math.random() * 720 - 360
  })), []);
  return (
    <div className="bucket-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{ left: `${p.left}%`, background: `hsl(${p.hue} 85% 62%)`, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s`,
          ['--drift' as string]: `${p.drift}px`, ['--spin' as string]: `${p.spin}deg` }} />
      ))}
    </div>
  );
}

function localIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function subtaskProgress(item: BucketListItem): { done: number; total: number } {
  const list = item.subtasks ?? [];
  return { done: list.filter(t => t.done).length, total: list.length };
}

const dayMs = 24 * 60 * 60 * 1000;
const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((new Date(`${toIso}T12:00:00`).getTime() - new Date(`${fromIso}T12:00:00`).getTime()) / dayMs);

// "in 95 days" reads better than a bare date, and says when it's getting close or has slipped.
function targetLabel(item: BucketListItem, today: string): { text: string; tone: 'ok' | 'soon' | 'late' } | null {
  if (!item.targetDate || item.status === 'Achieved' || item.status === 'Dropped') return null;
  const days = daysBetween(today, item.targetDate);
  const when = formatDate(item.targetDate);
  if (days < 0) return { text: `${when} · ${-days} day${days === -1 ? '' : 's'} overdue`, tone: 'late' };
  if (days === 0) return { text: `${when} · today`, tone: 'soon' };
  return { text: `${when} · in ${days} day${days === 1 ? '' : 's'}`, tone: days <= 14 ? 'soon' : 'ok' };
}

// The one goal worth the big card: what you're actively planning that comes up soonest.
function nextUp(items: BucketListItem[]): BucketListItem | null {
  return items
    .filter(i => i.status === 'Planning' && i.targetDate)
    .sort((a, b) => (a.targetDate ?? '').localeCompare(b.targetDate ?? ''))[0] ?? null;
}

type Layout = 'gallery' | 'list' | 'board' | 'map' | 'memories';
const LAYOUT_KEY = 'lifeos.view.bucketList';

function emptyForm(status: BucketListStatus = 'Someday'): Partial<BucketListItem> {
  return { title: '', category: 'Travel', status, subtasks: [] };
}

const MEMORY_PHOTO_MAX_DIM = 1600;
const MEMORY_PHOTO_QUALITY = 0.85;

// Downscales + re-encodes an uploaded photo to a JPEG data URL before it's stored — an
// unprocessed phone photo can be 10+ MB, which is a lot to keep raw in IndexedDB per item.
function fileToDataUrl(file: File, maxDim = MEMORY_PHOTO_MAX_DIM, quality = MEMORY_PHOTO_QUALITY): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(reader.result as string); return; }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Loads a photo from a link and re-encodes it as a data URL, so the memory keeps its own copy and
// can't lose the picture when the link dies. Only works where the site permits cross-site reads;
// where it doesn't, this rejects and the link is kept as it was.
function urlToDataUrl(url: string, maxDim = MEMORY_PHOTO_MAX_DIM, quality = MEMORY_PHOTO_QUALITY): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => reject(new Error('Could not copy this image'));
    img.onload = () => {
      try {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('No canvas')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Could not copy this image'));
      }
    };
    img.src = url;
  });
}

function ItemFormModal({
  item, categories, onClose, onSave
}: { item: BucketListItem | null; categories: BucketListCategory[]; onClose: () => void; onSave: (patch: Partial<BucketListItem>) => void }) {
  const coverFileRef = useRef<HTMLInputElement>(null);
  const { data, updateSettings } = useStore();
  const autoCover = data.settings.bucketAutoCover !== false;
  const [form, setForm] = useState<Partial<BucketListItem>>(item ? { ...item } : emptyForm());
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const unsplashReady = useMemo(isUnsplashConfigured, []);
  const [autoSuggesting, setAutoSuggesting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [photoQuery, setPhotoQuery] = useState('');
  const [photoResults, setPhotoResults] = useState<PhotoOption[]>([]);
  const [searching, setSearching] = useState(false);

  const set = <K extends keyof BucketListItem>(key: K, value: BucketListItem[K]) => setForm(prev => ({ ...prev, [key]: value }));

  // Auto-suggest a cover once there's enough of a title to search on — but only
  // into a genuinely empty field, so this never silently replaces a photo
  // you've already picked or pasted in.
  useEffect(() => {
    const title = (form.title ?? '').trim();
    if (!unsplashReady || !autoCover || form.coverArt || title.length < 4) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setAutoSuggesting(true);
      const url = await resolveCover(coverQuery(title, form.location), '');
      if (!cancelled) {
        setAutoSuggesting(false);
        if (url) setForm(prev => (prev.coverArt ? prev : { ...prev, coverArt: url }));
      }
    }, 700);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [form.title, form.location, form.coverArt, unsplashReady, autoCover]);

  const runPhotoSearch = async (q: string) => {
    if (!q.trim()) { setPhotoResults([]); return; }
    setSearching(true);
    setPhotoResults(await searchPhotos(q));
    setSearching(false);
  };

  const openPicker = () => {
    const q = photoQuery || form.title || '';
    setPhotoQuery(q);
    setPickerOpen(true);
    if (q.trim()) void runPhotoSearch(q);
  };

  const pickPhoto = (opt: PhotoOption) => {
    set('coverArt', opt.url);
    setPickerOpen(false);
  };

  const addSubtask = () => {
    const text = subtaskDraft.trim();
    if (!text) return;
    const next: BucketListSubtask = { id: generateId(), text, done: false };
    set('subtasks', [...(form.subtasks ?? []), next]);
    setSubtaskDraft('');
  };
  const toggleSubtask = (id: string) => {
    set('subtasks', (form.subtasks ?? []).map(t => t.id === id ? { ...t, done: !t.done } : t));
  };
  const removeSubtask = (id: string) => {
    set('subtasks', (form.subtasks ?? []).filter(t => t.id !== id));
  };

  return (
    <Modal
      eyebrow="Bucket List"
      title={item ? 'Edit goal' : 'New goal'}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn teal" disabled={!form.title?.trim()} onClick={() => onSave(form)}>Save</button>
      </>}
    >
      <div className="form-grid">
        <label className="field-full">
          <span>Title</span>
          <input type="text" value={form.title ?? ''} onChange={e => set('title', e.target.value)} placeholder="Hike Machu Picchu…" />
        </label>
        <label className="field-full">
          <span>Cover image {autoSuggesting && <em className="photo-auto-hint">finding a photo…</em>}</span>
          <div className="image-field">
            <input
              type="text"
              value={form.coverArt?.startsWith('data:') ? '' : form.coverArt ?? ''}
              onChange={e => set('coverArt', e.target.value)}
              placeholder={form.coverArt?.startsWith('data:') ? 'Using your uploaded photo' : unsplashReady ? 'Paste a URL, search, or upload…' : 'Paste a URL or upload…'}
            />
            {unsplashReady && (
              <button type="button" className="btn ghost small" onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}>
                <Search size={13} /> {pickerOpen ? 'Close' : 'Search photos'}
              </button>
            )}
            <button type="button" className="btn ghost small" onClick={() => coverFileRef.current?.click()}><Upload size={13} /> Upload</button>
            <input ref={coverFileRef} type="file" accept="image/*" hidden onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void fileToDataUrl(file, COVER_MAX_DIM, COVER_QUALITY).then(url => set('coverArt', url)).catch(() => {});
            }} />
            {Boolean(form.coverArt) && <img className="image-field-preview" src={form.coverArt} alt="" />}
          </div>
          {unsplashReady && (
            <span className="bucket-autocover">
              <input type="checkbox" checked={autoCover} onChange={e => void updateSettings({ bucketAutoCover: e.target.checked })} id="bucket-autocover" />
              <label htmlFor="bucket-autocover">Find a cover automatically as I type — this sends the goal’s title and location to Unsplash (a photo site)</label>
            </span>
          )}
          {pickerOpen && (
            <div className="photo-picker">
              <div className="photo-picker-search">
                <input
                  type="text"
                  value={photoQuery}
                  onChange={e => setPhotoQuery(e.target.value)}
                  placeholder="Search photos…"
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void runPhotoSearch(photoQuery); } }}
                />
                <button type="button" className="btn ghost small" onClick={() => void runPhotoSearch(photoQuery)} disabled={searching || !photoQuery.trim()}>
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </div>
              <div className="photo-picker-grid">
                {searching ? (
                  <p className="photo-picker-empty">Searching…</p>
                ) : photoResults.length ? photoResults.map(opt => (
                  <button
                    type="button"
                    key={opt.id}
                    className="photo-picker-thumb"
                    onClick={() => pickPhoto(opt)}
                    title={opt.credit ? `Photo by ${opt.credit} on Unsplash` : opt.alt}
                  >
                    <img src={opt.thumb} alt={opt.alt} />
                  </button>
                )) : <p className="photo-picker-empty">No results yet — try a search.</p>}
              </div>
            </div>
          )}
        </label>
        <label>
          <span>Category</span>
          <select value={form.category ?? 'Travel'} onChange={e => set('category', e.target.value as BucketListCategory)}>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select value={form.status ?? 'Someday'} onChange={e => set('status', e.target.value as BucketListStatus)}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>
          <span>Location</span>
          <input type="text" value={form.location ?? ''} onChange={e => set('location', e.target.value)} placeholder="Peru…" />
        </label>
        <label>
          <span>Cost</span>
          <select value={form.costTier ?? ''} onChange={e => set('costTier', (e.target.value || undefined) as CostTier | undefined)}>
            <option value="">Not set</option>
            {COST_TIERS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>
          <span>Target date</span>
          <DatePicker value={form.targetDate} onChange={v => set('targetDate', v)} placeholder="No target date" />
        </label>
        {(form.category ?? 'Travel') === 'Travel' && (
          <>
            <label>
              <span>Trip starts</span>
              <DatePicker value={form.tripStart} onChange={v => set('tripStart', v || undefined)} placeholder="Not set" allowClear />
            </label>
            <label>
              <span>Trip ends</span>
              <DatePicker value={form.tripEnd} onChange={v => set('tripEnd', v || undefined)} placeholder="Not set" allowClear />
            </label>
            <label>
              <span>Budget</span>
              <input type="number" inputMode="decimal" min="0" value={form.budget ?? ''} placeholder="e.g. 2500"
                onChange={e => set('budget', e.target.value === '' ? undefined : Number(e.target.value))} />
            </label>
          </>
        )}
        <label className="field-full">
          <span>Notes</span>
          <RichTextEditor value={form.notes ?? ''} onChange={v => set('notes', v)} placeholder="What makes this one matter…" />
        </label>
        <label className="field-full">
          <span>Roadmap — steps to get there</span>
          <div className="bucket-subtask-editor">
            {(form.subtasks ?? []).map(t => (
              <div className="bucket-subtask-row" key={t.id}>
                <input type="checkbox" checked={t.done} onChange={() => toggleSubtask(t.id)} />
                <span className={t.done ? 'done' : ''}>{t.text}</span>
                <button type="button" className="icon-btn" onClick={() => removeSubtask(t.id)} aria-label="Remove step"><X size={13} /></button>
              </div>
            ))}
            <div className="bucket-subtask-add">
              <input
                type="text"
                value={subtaskDraft}
                onChange={e => setSubtaskDraft(e.target.value)}
                placeholder="Add a step — e.g. Book flights"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
              />
              <button type="button" className="btn ghost small" onClick={addSubtask}>Add</button>
            </div>
          </div>
        </label>
      </div>
    </Modal>
  );
}

function DiscoveryDeck({
  existingTitles, onAdd, onClose
}: { existingTitles: Set<string>; onAdd: (idea: DeckIdea) => void; onClose: () => void }) {
  const [generatedIdeas, setGeneratedIdeas] = useState<DeckIdea[]>([]);
  const [engine, setEngine] = useState<Engine>(loadSavedEngine);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [resolvedCovers, setResolvedCovers] = useState<Record<string, string>>({});

  // Curated ideas ship with a placeholder cover; swap in a real, keyword-matched
  // photo per idea once (cached by lib/unsplash.ts) if a search key is configured.
  useEffect(() => {
    if (!isUnsplashConfigured()) return;
    let cancelled = false;
    Promise.all(DISCOVERY_DECK.map(async d => {
      const url = await resolveCover(coverQuery(d.title, d.location), d.coverArt);
      return [d.id, url] as const;
    })).then(pairs => {
      if (cancelled) return;
      setResolvedCovers(prev => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => { cancelled = true; };
  }, []);

  const deck = useMemo(() => {
    const seen = new Set(existingTitles);
    const combined = [...DISCOVERY_DECK, ...generatedIdeas];
    const out: DeckIdea[] = [];
    for (const d of combined) {
      const key = d.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }, [existingTitles, generatedIdeas]);

  const [index, setIndex] = useState(0);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [mode, setModeState] = useState<'grid' | 'one'>(() => (window.localStorage.getItem(DECK_MODE_KEY) === 'one' ? 'one' : 'grid'));
  const setMode = (next: 'grid' | 'one') => { setModeState(next); window.localStorage.setItem(DECK_MODE_KEY, next); };
  const [catFilter, setCatFilter] = useState('');
  const [costFilter, setCostFilter] = useState('');
  const gridIdeas = deck.filter(d => (!catFilter || d.category === catFilter) && (!costFilter || d.costTier === costFilter));
  const addIdea = (d: DeckIdea) => { const resolved = resolvedCovers[d.id]; onAdd(resolved ? { ...d, coverArt: resolved } : d); };

  const idea = deck[index];

  const goNext = () => setIndex(i => Math.min(i + 1, deck.length - 1));
  const goPrev = () => setIndex(i => Math.max(i - 1, 0));

  const handleAdd = () => {
    if (!idea) return;
    const resolved = resolvedCovers[idea.id];
    onAdd(resolved ? { ...idea, coverArt: resolved } : idea);
    setJustAddedId(idea.id);
    window.setTimeout(() => {
      setJustAddedId(null);
      setIndex(i => Math.min(i + 1, deck.length - 1));
    }, 650);
  };

  const changeEngine = (next: Engine) => {
    setEngine(next);
    window.localStorage.setItem(ENGINE_STORAGE_KEY, next);
  };

  const generateMore = async () => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    const jumpTo = deck.length;
    try {
      // Your own goals stay on this device when the cloud engine (Google) is in use: it's only told
      // about the ideas already in this deck. Repeats of your goals are filtered out here afterwards.
      const deckTitles = [...DISCOVERY_DECK, ...generatedIdeas].map(d => d.title.toLowerCase());
      const avoid = engine === 'cloud' ? deckTitles : [...existingTitles, ...deckTitles];
      const raw = await complete(engine, DECK_SYSTEM_PROMPT, buildDeckPrompt(GENERATE_COUNT, avoid));
      let parsed = parseDeckIdeas(raw);
      if (!parsed.length) throw new Error('Got a response but couldn’t make sense of it as ideas — try again, or switch engines.');
      if (isUnsplashConfigured()) {
        parsed = await Promise.all(parsed.map(async idea => ({
          ...idea, coverArt: await resolveCover(coverQuery(idea.title, idea.location), idea.coverArt)
        })));
      }
      setGeneratedIdeas(prev => [...prev, ...parsed]);
      setIndex(jumpTo);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Something went wrong generating ideas.');
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <div className="deck-overlay" onClick={onClose}>
      <div className="deck-panel" onClick={e => e.stopPropagation()}>
        <div className="deck-header">
          <div>
            <span className="modal-eyebrow">Someday Discovery Deck</span>
            <h2>Need a little inspiration?</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="deck-generate-row">
          <select
            className="deck-engine-select"
            value={engine}
            onChange={e => changeEngine(e.target.value as Engine)}
            disabled={generating}
            aria-label="AI engine"
          >
            <option value="local">{ENGINE_LABELS.local}</option>
            <option value="cloud">{ENGINE_LABELS.cloud}</option>
          </select>
          <button type="button" className="btn ghost small" onClick={() => void generateMore()} disabled={generating}>
            <Sparkles size={13} /> {generating ? 'Generating…' : 'Generate new ideas'}
          </button>
        </div>
        <p className="deck-privacy">
          {engine === 'cloud'
            ? 'Cloud: none of your goals are sent — only the ideas already in this deck, so it doesn’t repeat them.'
            : 'Local: runs on this computer. Your goal titles are used to avoid repeats and never leave it.'}
        </p>
        {genError && (
          <div className="deck-error"><AlertTriangle size={13} /> {genError}</div>
        )}

        <div className="deck-mode-row">
          <div className="view-toggle-btns">
            <button type="button" className={mode === 'grid' ? 'on' : ''} onClick={() => setMode('grid')} aria-label="Browse all ideas" title="Browse all"><Grid3x3 size={15} /></button>
            <button type="button" className={mode === 'one' ? 'on' : ''} onClick={() => setMode('one')} aria-label="One idea at a time" title="One at a time"><Layers size={15} /></button>
          </div>
          {mode === 'grid' && (
            <>
              <select value={catFilter} onChange={e => setCatFilter(e.target.value)} aria-label="Category">
                <option value="">Any category</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={costFilter} onChange={e => setCostFilter(e.target.value)} aria-label="Cost">
                <option value="">Any cost</option>
                {COST_TIERS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="deck-count">{gridIdeas.length} idea{gridIdeas.length === 1 ? '' : 's'}</span>
            </>
          )}
        </div>

        {mode === 'grid' && deck.length > 0 ? (
          gridIdeas.length ? (
            <div className="deck-grid">
              {gridIdeas.map(d => (
                <div className="deck-tile" key={d.id}>
                  <span className="deck-tile-cover" style={{ backgroundImage: `url(${resolvedCovers[d.id] ?? d.coverArt})` }}>
                    <span className="bucket-status-pill status-someday">{d.category}</span>
                    <span className="bucket-cost-pill">{d.costTier}</span>
                  </span>
                  <span className="deck-tile-body">
                    <b>{d.title}</b>
                    {d.location && <small><MapPin size={11} /> {d.location}</small>}
                    <p>{d.blurb}</p>
                  </span>
                  <button type="button" className="btn ghost small" onClick={() => addIdea(d)}><Plus size={13} /> Add to my list</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="deck-empty"><p>No ideas match those filters.</p></div>
          )
        ) : idea ? (
          <>
            <div className="deck-stage">
              <button type="button" className="deck-nav" onClick={goPrev} disabled={index === 0} aria-label="Previous idea"><ChevronLeft size={20} /></button>
              <div className="deck-card" key={idea.id} style={{ backgroundImage: `url(${resolvedCovers[idea.id] ?? idea.coverArt})` }}>
                <span className="deck-card-scrim" aria-hidden="true" />
                <div className="deck-card-top">
                  <span className="bucket-status-pill status-someday">{idea.category}</span>
                  <span className="bucket-cost-pill">{idea.costTier}</span>
                  {idea.id.startsWith('ai-') && <span className="bucket-cost-pill deck-ai-badge"><Sparkles size={10} /> AI</span>}
                </div>
                <div className="deck-card-body">
                  {idea.location && <small><MapPin size={12} /> {idea.location}</small>}
                  <b>{idea.title}</b>
                  <p>{idea.blurb}</p>
                </div>
              </div>
              <button type="button" className="deck-nav" onClick={goNext} disabled={index === deck.length - 1} aria-label="Next idea"><ChevronRight size={20} /></button>
            </div>
            <div className="deck-footer">
              <span className="deck-count">{index + 1} of {deck.length}</span>
              <div className="deck-actions">
                <button type="button" className="btn ghost" onClick={goNext} disabled={index === deck.length - 1}>Skip</button>
                <button type="button" className="btn teal" onClick={handleAdd} disabled={justAddedId === idea.id}>
                  {justAddedId === idea.id ? <><Check size={15} /> Added</> : <><Plus size={15} /> Add to my list</>}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="deck-empty">
            <Sparkles size={26} />
            <p>You’ve added every idea in the deck — nice.</p>
            <button type="button" className="btn teal" onClick={() => void generateMore()} disabled={generating}>
              <Sparkles size={14} /> {generating ? 'Generating…' : 'Generate new ideas'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Travel() {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  const items = data.bucketList;
  const today = localIso();
  const thisYear = today.slice(0, 4);

  // Built-in categories, the ones you've added, and any a goal already carries.
  const customCategories = data.settings.bucketCategories ?? [];
  const allCategories: BucketListCategory[] = useMemo(
    () => [...new Set<string>([...CATEGORIES, ...customCategories, ...items.map(i => i.category).filter(Boolean)])],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customCategories.join('|'), items]
  );
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState('');
  const addCategory = () => {
    const name = categoryDraft.trim();
    if (name && !allCategories.some(c => c.toLowerCase() === name.toLowerCase())) void updateSettings({ bucketCategories: [...customCategories, name] });
    setCategoryDraft('');
    setAddingCategory(false);
  };
  const removeCategory = (name: string) => {
    void updateSettings({ bucketCategories: customCategories.filter(c => c !== name) });
    if (categoryTab === name) setCategoryTab(null);
  };

  const [statusTab, setStatusTab] = useState<StatusTab>(savedFilters.statusTab);
  const [categoryTab, setCategoryTab] = useState<BucketListCategory | null>(savedFilters.categoryTab);
  const [search, setSearch] = useState(savedFilters.search);
  useEffect(() => { savedFilters = { statusTab, categoryTab, search }; }, [statusTab, categoryTab, search]);
  const [sortBy, setSortByState] = useState<SortBy>(loadSavedSort);
  const setSortBy = (next: SortBy) => {
    setSortByState(next);
    window.localStorage.setItem(SORT_STORAGE_KEY, next);
  };
  // Arriving from All Notes or the Calendar opens that goal.
  const [jumpItem] = useState(() => { const j = takeJumpFor('bucketList'); return (j && items.find(i => i.id === j.id)) || null; });
  const [detailId, setDetailId] = useState<string | null>(jumpItem?.id ?? null);
  const [formItem, setFormItem] = useState<BucketListItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [photoDraft, setPhotoDraft] = useState('');
  const [stepDraft, setStepDraft] = useState('');
  const [packDraft, setPackDraft] = useState('');
  const [deckOpen, setDeckOpen] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<BucketListItem | null>(null);
  // The photo viewer steps through one goal's photos.
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [checkDrag, setCheckDrag] = useState<{ key: 'subtasks' | 'packing'; id: string } | null>(null);
  const coverFileRef = useRef<HTMLInputElement>(null);
  const coverTargetRef = useRef<string | null>(null);
  const [celebrate, setCelebrate] = useState(0);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState('');
  // Photos whose link no longer loads (a pasted URL that has since died).
  const [brokenPhotos, setBrokenPhotos] = useState<Set<string>>(new Set());
  const markBroken = (url: string) => setBrokenPhotos(prev => (prev.has(url) ? prev : new Set(prev).add(url)));
  // Memory photos are checked as soon as the page opens — not only when a goal's panel happens to
  // show one — so the Memories view can fall back to the cover instead of drawing a dead link blank.
  const photoUrls = useMemo(() => [...new Set(items.flatMap(i => i.memoryPhotos ?? []))].filter(u => !u.startsWith('data:')), [items]);
  // "Did you do it?" prompts put off for this visit.
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
      if (e.key === 'ArrowRight') setLightbox(l => (l ? { ...l, index: (l.index + 1) % l.urls.length } : l));
      if (e.key === 'ArrowLeft') setLightbox(l => (l ? { ...l, index: (l.index - 1 + l.urls.length) % l.urls.length } : l));
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightbox]);

  useEffect(() => {
    if (!celebrate) return;
    const timer = window.setTimeout(() => setCelebrate(0), 2200);
    return () => window.clearTimeout(timer);
  }, [celebrate]);

  const existingTitles = useMemo(
    () => new Set(items.map(i => i.title.trim().toLowerCase())),
    [items]
  );

  // Search looks through everything written on a goal, not just its title.
  const matchesSearch = (i: BucketListItem, q: string) => !q || [
    i.title, i.location ?? '', toPlainText(i.notes ?? ''), toPlainText(i.reflection ?? ''),
    ...(i.subtasks ?? []).map(t => t.text), ...(i.packing ?? []).map(t => t.text)
  ].some(text => text.toLowerCase().includes(q));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items
      // "All" means everything you're still after or have done — dropped goals have their own tab.
      .filter(i => (statusTab === 'All' ? i.status !== 'Dropped' : i.status === statusTab))
      .filter(i => !categoryTab || i.category === categoryTab)
      .filter(i => matchesSearch(i, q));
    const sorted = list.slice();
    if (sortBy === 'smart') sorted.sort(smartCompare);
    else if (sortBy === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sortBy === 'target') sorted.sort((a, b) => (a.targetDate ?? '9999-99-99').localeCompare(b.targetDate ?? '9999-99-99'));
    else if (sortBy === 'custom') sorted.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    else sorted.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return sorted;
  }, [items, statusTab, categoryTab, search, sortBy]);

  const filteredAllStatuses = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter(i => !categoryTab || i.category === categoryTab)
      .filter(i => matchesSearch(i, q))
      .sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [items, categoryTab, search]);

  const counts = useMemo(() => ({
    Achieved: items.filter(i => i.status === 'Achieved').length,
    Planning: items.filter(i => i.status === 'Planning').length,
    Someday: items.filter(i => i.status === 'Someday').length,
    Dropped: items.filter(i => i.status === 'Dropped').length
  }), [items]);
  const next = useMemo(() => nextUp(items), [items]);
  const nextLabel = next ? targetLabel(next, today) : null;
  const achievedThisYear = items.filter(i => i.status === 'Achieved' && (i.achievedAt ?? '').startsWith(thisYear)).length;
  const yearTarget = data.settings.bucketYearTarget;
  const saveYearTarget = () => {
    const n = Math.round(Number(targetDraft));
    void updateSettings({ bucketYearTarget: Number.isFinite(n) && n > 0 ? n : undefined });
    setEditingTarget(false);
  };
  // Goals whose target date has arrived without being marked achieved (and not put off).
  // A trip you're back from counts as well as a passed target date.
  const backFrom = (i: BucketListItem) => Boolean(i.tripEnd && i.tripEnd < today && (!i.tripStart || i.tripStart <= i.tripEnd));
  const duePrompts = items.filter(i => i.status !== 'Achieved' && i.status !== 'Dropped' && !snoozed.has(i.id) && !(i.askAgainOn && i.askAgainOn > today)
    && ((i.targetDate && i.targetDate <= today) || backFrom(i)));
  const askInAWeek = (item: BucketListItem) => {
    const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() + 7);
    patchItem(item, { askAgainOn: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` });
  };

  // Dragging always works, regardless of which sort is currently active — starting a drag is a
  // clear enough signal of intent to take manual control that it switches to "Custom order"
  // itself, rather than requiring an extra click first and then having the drop immediately
  // look like it did nothing under whatever sort was previously selected.
  const handleDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ordered = filtered.map(i => i.id);
    const fromIndex = ordered.indexOf(dragId);
    const toIndex = ordered.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) { setDragId(null); return; }
    const reordered = [...ordered];
    reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, dragId);
    await Promise.all(reordered.map((id, index) => {
      const item = items.find(i => i.id === id);
      if (!item || item.order === index) return Promise.resolve();
      return upsert('bucketList', { ...item, order: index });
    }));
    if (sortBy !== 'custom') setSortBy('custom');
    setDragId(null);
  };

  const patchItem = (item: BucketListItem, patch: Partial<BucketListItem>) => {
    const updated = { ...item, ...patch };
    void upsert('bucketList', updated);
    // A linked savings goal in Finance follows the trip: its amount, its date, and (unless you've
    // renamed it there) its name.
    const goal = updated.savingsGoalId ? data.financeGoals.find(g => g.id === updated.savingsGoalId) : undefined;
    if (goal && updated.budget) {
      const date = updated.tripStart ?? updated.targetDate;
      const name = goal.name === `Trip: ${item.title}` ? `Trip: ${updated.title}` : goal.name;
      if (goal.targetAmount !== updated.budget || goal.targetDate !== date || goal.name !== name) {
        void upsert('financeGoals', { ...goal, targetAmount: updated.budget, targetDate: date, name });
      }
    }
  };

  // Achieving something gets a moment: confetti, and the memory section ready to write in.
  const markAchieved = (item: BucketListItem) => {
    if (item.status !== 'Achieved') setCelebrate(Date.now());
    patchItem(item, { status: 'Achieved', achievedAt: item.achievedAt ?? localIso() });
    setDetailId(item.id);
    window.setTimeout(() => {
      const memory = document.querySelector<HTMLElement>('.bucket-detail-memory');
      memory?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      memory?.querySelector<HTMLElement>('[contenteditable]')?.focus({ preventScroll: true });
    }, 350);
  };

  // Steps and the packing list are the same kind of checklist.
  type ListKey = 'subtasks' | 'packing';
  const toggleEntry = (item: BucketListItem, key: ListKey, id: string) =>
    patchItem(item, { [key]: (item[key] ?? []).map(t => (t.id === id ? { ...t, done: !t.done } : t)) });
  const removeEntry = (item: BucketListItem, key: ListKey, id: string) =>
    patchItem(item, { [key]: (item[key] ?? []).filter(t => t.id !== id) });
  const addEntry = (item: BucketListItem, key: ListKey, text: string) => {
    const value = text.trim();
    if (!value) return;
    patchItem(item, { [key]: [...(item[key] ?? []), { id: generateId(), text: value, done: false }] });
  };
  const renameEntry = (item: BucketListItem, key: ListKey, id: string, text: string) =>
    patchItem(item, { [key]: (item[key] ?? []).map(t => (t.id === id ? { ...t, text } : t)) });
  // Moves one entry to sit where another is (drag), or one place up/down (the arrow, Alt+↑/↓).
  const moveEntry = (item: BucketListItem, key: ListKey, id: string, toIndex: number) => {
    const list = [...(item[key] ?? [])];
    const from = list.findIndex(t => t.id === id);
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (from < 0 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    patchItem(item, { [key]: list });
  };
  const addPackingBasics = (item: BucketListItem) => {
    const have = new Set((item.packing ?? []).map(p => p.text.trim().toLowerCase()));
    const fresh = PACKING_BASICS.filter(text => !have.has(text.toLowerCase())).map(text => ({ id: generateId(), text, done: false }));
    if (fresh.length) patchItem(item, { packing: [...(item.packing ?? []), ...fresh] });
  };

  // A trip's budget can become a savings goal in Finance, and report its progress back here.
  const savingsGoalOf = (item: BucketListItem) => (item.savingsGoalId ? data.financeGoals.find(g => g.id === item.savingsGoalId) : undefined);
  const startSaving = (item: BucketListItem) => {
    if (!item.budget) return;
    const goal = newRecord<FinanceGoal>({
      name: `Trip: ${item.title}`, category: 'Vacation', targetAmount: item.budget, currentAmount: 0,
      targetDate: item.tripStart ?? item.targetDate, notes: 'Created from Travel & Bucket List.'
    });
    void upsert('financeGoals', goal);
    patchItem(item, { savingsGoalId: goal.id });
  };
  const openFinanceSavings = () => {
    requestJump({ page: 'Finance', tab: 'Savings' });
    window.dispatchEvent(new CustomEvent('lifeos:navigate', { detail: { page: 'Finance', tab: 'Savings' } }));
  };

  const triggerCoverUpload = (item: BucketListItem) => {
    coverTargetRef.current = item.id;
    coverFileRef.current?.click();
  };
  const onCoverFileSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const id = coverTargetRef.current;
    coverTargetRef.current = null;
    if (!file || !id) return;
    try {
      const dataUrl = await fileToDataUrl(file, COVER_MAX_DIM, COVER_QUALITY);
      const latest = items.find(i => i.id === id);
      if (latest) patchItem(latest, { coverArt: dataUrl });
    } catch { /* unreadable file — leave the cover as it was */ }
  };

  // Swaps a linked memory photo for a saved copy. Quietly does nothing if the site won't allow it.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const copyTried = useRef<Set<string>>(new Set());
  const keepCopy = async (itemId: string, url: string) => {
    if (!/^https?:/i.test(url) || copyTried.current.has(url)) return;
    copyTried.current.add(url);
    try {
      const dataUrl = await urlToDataUrl(url);
      const latest = itemsRef.current.find(i => i.id === itemId);
      if (latest?.memoryPhotos?.includes(url)) {
        void upsert('bucketList', { ...latest, memoryPhotos: latest.memoryPhotos.map(p => (p === url ? dataUrl : p)) });
      }
    } catch { /* the link stays as it was */ }
  };
  const addPhoto = (item: BucketListItem) => {
    const url = photoDraft.trim();
    if (!url) return;
    patchItem(item, { memoryPhotos: [...(item.memoryPhotos ?? []), url] });
    setPhotoDraft('');
    void keepCopy(item.id, url);
  };
  // Photos linked before this existed get the same treatment, once, while their links still work.
  useEffect(() => {
    for (const item of items) for (const url of item.memoryPhotos ?? []) void keepCopy(item.id, url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const removePhoto = (item: BucketListItem, url: string) => {
    patchItem(item, { memoryPhotos: (item.memoryPhotos ?? []).filter(p => p !== url) });
  };

  const triggerPhotoUpload = (item: BucketListItem) => {
    uploadTargetRef.current = item;
    fileInputRef.current?.click();
  };

  const onPhotoFileSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    const target = uploadTargetRef.current;
    uploadTargetRef.current = null;
    if (!file || !target) return;
    setUploadingFor(target.id);
    try {
      const dataUrl = await fileToDataUrl(file);
      // Re-read the current record rather than trusting the closed-over `target` —
      // other fields (e.g. the reflection text) may have changed since the click.
      const latest = items.find(i => i.id === target.id) ?? target;
      patchItem(latest, { memoryPhotos: [...(latest.memoryPhotos ?? []), dataUrl] });
    } catch {
      /* unreadable file — silently skip rather than block the rest of the panel */
    } finally {
      setUploadingFor(null);
    }
  };

  // ---- Views: Gallery, Board (desktop), Map, Memories ----
  const [layoutRaw, setLayoutState] = useState<Layout>(() => {
    try {
      const saved = window.localStorage.getItem(LAYOUT_KEY);
      return saved === 'list' || saved === 'board' || saved === 'map' || saved === 'memories' ? saved : 'gallery';
    } catch { return 'gallery'; }
  });
  const setLayout = (value: Layout) => {
    setLayoutState(value);
    try { window.localStorage.setItem(LAYOUT_KEY, value); } catch { /* not remembered */ }
  };
  // The board needs room for three columns side by side.
  const layout: Layout = isMobile && layoutRaw === 'board' ? 'gallery' : layoutRaw;
  const boardMode = layout === 'board';
  const [boardOver, setBoardOver] = useState<BucketListStatus | null>(null);
  const moveToStatus = (id: string, status: BucketListStatus) => {
    const item = items.find(i => i.id === id);
    if (!item || item.status === status) return;
    if (status === 'Achieved') patchItem(item, { status, achievedAt: item.achievedAt ?? localIso() });
    else patchItem(item, { status });
  };

  // Right-click a goal (desktop), or tap its status pill anywhere: move between statuses, edit, delete.
  const { menu: contextMenu, openMenu } = useContextMenu();
  const statusMenu = (item: BucketListItem): ContextMenuItem[] => [
    { heading: 'Status' },
    ...STATUSES.map(st => ({ label: st, checked: item.status === st, onSelect: () => moveToStatus(item.id, st) }))
  ];
  const goalMenu = (item: BucketListItem): ContextMenuItem[] => [
    { label: 'Open', icon: ImageIcon, onSelect: () => setDetailId(item.id) },
    { label: 'Edit…', icon: Pencil, onSelect: () => startEdit(item) },
    { label: 'Duplicate', icon: CopyIcon, onSelect: () => duplicateItem(item) },
    'separator',
    ...statusMenu(item),
    'separator',
    { label: 'Delete', icon: Trash2, danger: true, onSelect: () => deleteItem(item.id) }
  ];

  const startAdd = () => { setFormItem(null); setShowForm(true); };
  useFabAction('Travel & Bucket List', 'Add goal', startAdd);
  const startEdit = (item: BucketListItem) => { setFormItem(item); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setFormItem(null); };

  const save = (patch: Partial<BucketListItem>) => {
    if (formItem) {
      void upsert('bucketList', { ...formItem, ...patch } as BucketListItem);
    } else {
      const record = newRecord<BucketListItem>({ subtasks: [], ...patch } as Partial<BucketListItem>);
      void upsert('bucketList', record);
    }
    closeForm();
  };

  // No "are you sure?" box: the Undo toast (and Ctrl+Z) brings a deleted goal straight back.
  const deleteItem = (id: string) => {
    const item = items.find(i => i.id === id);
    const goal = item?.savingsGoalId ? data.financeGoals.find(g => g.id === item.savingsGoalId) : undefined;
    // The one question worth asking: money is being saved toward this in Finance.
    if (goal && window.confirm(`“${item!.title}” has a savings goal in Finance (${formatCurrency(goal.currentAmount)} saved of ${formatCurrency(goal.targetAmount)}).\n\nOK — delete the savings goal too.\nCancel — keep the savings goal, delete only this goal.`)) {
      void remove('financeGoals', goal.id);
    }
    if (detailId === id) setDetailId(null);
    void remove('bucketList', id);
  };

  // A fresh copy to plan again: same details, steps and packing (unticked), none of the history.
  const duplicateItem = (item: BucketListItem) => {
    const untick = (list?: BucketListSubtask[]) => list?.map(t => ({ ...t, id: generateId(), done: false }));
    const copy = newRecord<BucketListItem>({
      title: `${item.title} (copy)`, category: item.category, status: item.status === 'Planning' ? 'Planning' : 'Someday',
      coverArt: item.coverArt, location: item.location, costTier: item.costTier, notes: item.notes, pin: item.pin,
      budget: item.budget, subtasks: untick(item.subtasks) ?? [], packing: untick(item.packing)
    });
    void upsert('bucketList', copy);
    setDetailId(copy.id);
  };
  const setItineraryDay = (item: BucketListItem, date: string, patch: { plan?: string; ref?: string }) => {
    const day = { ...(item.itinerary?.[date] ?? {}), ...patch };
    const itinerary = { ...(item.itinerary ?? {}) };
    if (day.plan || day.ref) itinerary[date] = day; else delete itinerary[date];
    patchItem(item, { itinerary: Object.keys(itinerary).length ? itinerary : undefined });
  };

  const addFromDeck = (idea: DeckIdea) => {
    const record = newRecord<BucketListItem>({
      title: idea.title, category: idea.category, status: 'Someday',
      costTier: idea.costTier, location: idea.location, coverArt: idea.coverArt,
      notes: idea.blurb, subtasks: []
    });
    void upsert('bucketList', record);
  };

  // ---- Map ----
  const mapItems = useMemo(() => filteredAllStatuses.filter(i => i.status !== 'Dropped'), [filteredAllStatuses]);
  const placed: MapEntry[] = useMemo(() => mapItems.flatMap((item): MapEntry[] => {
    if (item.pin) return [{ item, lon: item.pin.lon, lat: item.pin.lat, manual: true }];
    const at = locate(item.location, item.title);
    return at ? [{ item, lon: at.lon, lat: at.lat, manual: false }] : [];
  }), [mapItems]);
  const unplaced = mapItems.filter(i => !placed.some(p => p.item.id === i.id));
  // Where you've actually been: achieved Travel goals that are on the map.
  const visitedStat = useMemo(() => {
    const visited = items.filter(i => i.status === 'Achieved' && i.category === 'Travel').flatMap(i => {
      if (i.pin) return [{ key: `${Math.round(i.pin.lon)}:${Math.round(i.pin.lat)}`, lon: i.pin.lon, lat: i.pin.lat }];
      const at = locate(i.location, i.title);
      return at ? [{ key: at.name, lon: at.lon, lat: at.lat }] : [];
    });
    if (!visited.length) return undefined;
    const places = new Set(visited.map(v => v.key)).size;
    const continents = new Set(visited.map(v => continentOf(v.lon, v.lat))).size;
    return `${places} place${places === 1 ? '' : 's'} visited · ${continents} continent${continents === 1 ? '' : 's'}`;
  }, [items]);

  // ---- Memories: what you've done, by year ----
  const memoryYears = useMemo(() => {
    const done = filteredAllStatuses.filter(i => i.status === 'Achieved')
      .sort((a, b) => (b.achievedAt ?? '').localeCompare(a.achievedAt ?? ''));
    const years = new Map<string, BucketListItem[]>();
    for (const i of done) {
      const year = (i.achievedAt ?? '').slice(0, 4) || 'Undated';
      if (!years.has(year)) years.set(year, []);
      years.get(year)!.push(i);
    }
    return Array.from(years.entries());
  }, [filteredAllStatuses]);

  const detail = detailId ? items.find(i => i.id === detailId) ?? null : null;
  const closeDetail = () => { setDetailId(null); setStepDraft(''); setPackDraft(''); setPhotoDraft(''); };

  const renderChecklist = (item: BucketListItem, key: ListKey, draft: string, setDraft: (v: string) => void, placeholder: string) => (
    <div className="bucket-checklist">
      {(item[key] ?? []).map((t, index) => (
        <div
          className={`bucket-check-row ${checkDrag?.id === t.id ? 'dragging' : ''}`} key={t.id}
          onDragOver={e => { if (checkDrag?.key === key) e.preventDefault(); }}
          onDrop={e => { e.preventDefault(); if (checkDrag?.key === key) moveEntry(item, key, checkDrag.id, index); setCheckDrag(null); }}
        >
          <span
            className="bucket-check-grip" draggable title="Drag to reorder"
            onDragStart={e => { setCheckDrag({ key, id: t.id }); e.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setCheckDrag(null)}
          ><GripVertical size={13} /></span>
          <input type="checkbox" checked={t.done} onChange={() => toggleEntry(item, key, t.id)} aria-label={`Done: ${t.text}`} />
          <input
            type="text" className={`bucket-check-text ${t.done ? 'done' : ''}`} value={t.text} aria-label="Step"
            onChange={e => renameEntry(item, key, t.id, e.target.value)}
            onKeyDown={e => {
              if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveEntry(item, key, t.id, index - 1); }
              if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveEntry(item, key, t.id, index + 1); }
            }}
          />
          {index > 0 && (
            <button type="button" className="icon-btn bucket-check-up" onClick={() => moveEntry(item, key, t.id, index - 1)} aria-label={`Move ${t.text} up`} title="Move up"><ArrowUp size={13} /></button>
          )}
          <button type="button" className="icon-btn" onClick={() => removeEntry(item, key, t.id)} aria-label={`Remove ${t.text}`}><X size={13} /></button>
        </div>
      ))}
      <div className="bucket-subtask-add">
        <input
          type="text" value={draft} placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntry(item, key, draft); setDraft(''); } }}
        />
        <button type="button" className="btn ghost small" onClick={() => { addEntry(item, key, draft); setDraft(''); }}>Add</button>
      </div>
    </div>
  );

  const renderDetail = (item: BucketListItem) => {
    const { done, total } = subtaskProgress(item);
    const target = targetLabel(item, today);
    const nights = item.tripStart && item.tripEnd ? daysBetween(item.tripStart, item.tripEnd) : null;
    const fromBudget = item.budget != null && item.budget > 0;
    // One line per day of the trip (kept to sane lengths so a typo'd year can't draw a wall of rows).
    const tripDays: string[] = [];
    if (item.tripStart && nights != null && nights >= 0 && nights <= 45) {
      const d = new Date(`${item.tripStart}T12:00:00`);
      for (let n = 0; n <= nights; n++) {
        tripDays.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
        d.setDate(d.getDate() + 1);
      }
    }
    const packing = item.packing ?? [];
    const savings = savingsGoalOf(item);
    const photos = item.memoryPhotos ?? [];
    const uploadedCover = item.coverArt?.startsWith('data:');
    const planningSections = (
      <>
          <section>
            <h3>Details</h3>
            <div className="bucket-detail-fields">
              <label className="wide"><span>Title</span><input type="text" value={item.title} onChange={e => patchItem(item, { title: e.target.value })} placeholder="What's the goal?" /></label>
              <label><span>Location</span><input type="text" value={item.location ?? ''} onChange={e => patchItem(item, { location: e.target.value || undefined })} placeholder="Country or city" /></label>
              <label>
                <span>Category</span>
                <select value={item.category} onChange={e => patchItem(item, { category: e.target.value })}>
                  {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label><span>Target date</span><DatePicker value={item.targetDate} onChange={v => patchItem(item, { targetDate: v || undefined, askAgainOn: undefined })} placeholder="No target date" allowClear /></label>
              <label>
                <span>Cost{fromBudget ? ' (from the budget)' : ''}</span>
                <select value={costOf(item) ?? ''} disabled={fromBudget} title={fromBudget ? 'Worked out from the trip budget' : undefined}
                  onChange={e => patchItem(item, { costTier: (e.target.value || undefined) as CostTier | undefined })}>
                  <option value="">Not set</option>
                  {COST_TIERS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="wide">
                <span>Cover photo</span>
                <span className="bucket-cover-edit">
                  <input type="text" value={uploadedCover ? '' : item.coverArt ?? ''} placeholder={uploadedCover ? 'Using your uploaded photo' : 'Paste an image link…'}
                    onChange={e => patchItem(item, { coverArt: e.target.value || undefined })} />
                  <button type="button" className="btn ghost small" onClick={() => triggerCoverUpload(item)}><Upload size={13} /> Upload</button>
                  <button type="button" className="btn ghost small" onClick={() => { closeDetail(); startEdit(item); }} title="Search for a photo in the full form"><Search size={13} /> Search</button>
                  {item.coverArt && <button type="button" className="btn ghost small" onClick={() => patchItem(item, { coverArt: undefined })}>Remove</button>}
                </span>
              </label>
            </div>
          </section>

          <section>
            <h3>Why it matters</h3>
            <RichTextEditor value={item.notes ?? ''} onChange={v => patchItem(item, { notes: v })} placeholder="What makes this one matter…" />
          </section>

          <section>
            <h3>Steps to get there {total > 0 && <span>{done} of {total} done</span>}</h3>
            {total > 0 && <ProgressBar value={(done / total) * 100} />}
            {renderChecklist(item, 'subtasks', stepDraft, setStepDraft, 'Add a step — e.g. Book flights')}
          </section>

          {item.category === 'Travel' && (
            <section>
              <h3>Trip plan {nights != null && nights >= 0 && <span>{nights} night{nights === 1 ? '' : 's'}</span>}</h3>
              <div className="bucket-trip-grid">
                <label><span>Leaving</span><DatePicker value={item.tripStart} onChange={v => patchItem(item, { tripStart: v || undefined })} placeholder="Not set" allowClear /></label>
                <label><span>Back</span><DatePicker value={item.tripEnd} onChange={v => patchItem(item, { tripEnd: v || undefined })} placeholder="Not set" allowClear /></label>
                <label>
                  <span><Wallet size={12} /> Budget</span>
                  <input type="number" inputMode="decimal" min="0" value={item.budget ?? ''} placeholder="e.g. 2500"
                    onChange={e => patchItem(item, { budget: e.target.value === '' ? undefined : Number(e.target.value) })} />
                </label>
              </div>
              {nights != null && nights < 0 && (
                <p className="bucket-trip-warn"><AlertTriangle size={13} /> “Back” is before “Leaving” — fix one of the dates and the trip will show on the Calendar.</p>
              )}
              {item.budget != null && nights != null && nights > 0 && (
                <p className="muted bucket-trip-note">About {formatCurrency(item.budget / nights)} a night.</p>
              )}
              {item.budget != null && item.budget > 0 && (savings ? (
                <div className="bucket-savings">
                  <span><PiggyBank size={14} /> Saved <b>{formatCurrency(savings.currentAmount)}</b> of {formatCurrency(savings.targetAmount)}</span>
                  <ProgressBar value={savings.targetAmount > 0 ? Math.min(100, (savings.currentAmount / savings.targetAmount) * 100) : 0} />
                  <button type="button" className="text-btn" onClick={openFinanceSavings}>Open in Finance</button>
                </div>
              ) : (
                <button type="button" className="btn ghost small bucket-savings-start" onClick={() => startSaving(item)}>
                  <PiggyBank size={14} /> Save for this in Finance
                </button>
              ))}
              {tripDays.length > 0 && (
                <>
                  <h4>Day by day <span>{tripDays.filter(d => item.itinerary?.[d]?.plan || item.itinerary?.[d]?.ref).length} of {tripDays.length} planned</span></h4>
                  <div className="bucket-itinerary">
                    {tripDays.map((date, i) => (
                      <div className="bucket-itinerary-day" key={date}>
                        <span><b>Day {i + 1}</b><small>{new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</small></span>
                        <input type="text" value={item.itinerary?.[date]?.plan ?? ''} placeholder={i === 0 ? 'e.g. Fly out, check in' : 'What’s the plan?'} aria-label={`Plan for day ${i + 1}`}
                          onChange={e => setItineraryDay(item, date, { plan: e.target.value || undefined })} />
                        <input type="text" className="ref" value={item.itinerary?.[date]?.ref ?? ''} placeholder="Booking ref" aria-label={`Booking reference for day ${i + 1}`}
                          onChange={e => setItineraryDay(item, date, { ref: e.target.value || undefined })} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              <h4>
                Pack &amp; book {packing.length > 0 && <span>{packing.filter(p => p.done).length} of {packing.length}</span>}
                <button type="button" className="text-btn bucket-basics" onClick={() => addPackingBasics(item)}>+ Add the basics</button>
              </h4>
              {renderChecklist(item, 'packing', packDraft, setPackDraft, 'Add something — e.g. Passport, travel insurance')}
            </section>
          )}

      </>
    );
    const memorySection = (
      <>
          {item.status === 'Achieved' && (
            <section className="bucket-detail-memory">
              <h3><Trophy size={14} /> Memory</h3>
              <label className="bucket-journal-date">
                <span>Achieved on</span>
                <DatePicker value={item.achievedAt} onChange={v => patchItem(item, { achievedAt: v })} placeholder="Set date" />
              </label>
              <RichTextEditor
                value={item.reflection ?? ''}
                onChange={v => patchItem(item, { reflection: v })}
                placeholder="How did it feel? What will you remember?"
              />
              <div className="bucket-journal-photos">
                {photos.map(url => (
                  <div className={`bucket-journal-photo ${brokenPhotos.has(url) ? 'broken' : ''}`} key={url}>
                    {brokenPhotos.has(url) ? (
                      <span className="bucket-photo-missing" title="This photo's link no longer works"><ImageOff size={18} /><small>Photo unavailable</small></span>
                    ) : (
                      <button type="button" className="bucket-journal-photo-expand" onClick={() => { const ok = photos.filter(u => !brokenPhotos.has(u)); setLightbox({ urls: ok, index: Math.max(0, ok.indexOf(url)) }); }} aria-label="View full-size photo">
                        <img src={url} alt="" onError={() => markBroken(url)} />
                      </button>
                    )}
                    <button type="button" className="bucket-journal-photo-remove" onClick={() => removePhoto(item, url)} aria-label="Remove photo"><X size={11} /></button>
                  </div>
                ))}
              </div>
              <div className="bucket-journal-add-photo">
                <button type="button" className="btn ghost small" onClick={() => triggerPhotoUpload(item)} disabled={uploadingFor === item.id} title="Upload a photo from your device">
                  <Upload size={13} /> {uploadingFor === item.id ? 'Uploading…' : 'Upload'}
                </button>
                <input
                  type="text" value={photoDraft} placeholder="…or paste a photo URL"
                  onChange={e => setPhotoDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPhoto(item); } }}
                />
                <button type="button" className="btn ghost small" onClick={() => addPhoto(item)}>Add</button>
              </div>
            </section>
          )}
      </>
    );
    return (
      <Modal
        eyebrow={[item.category, item.location].filter(Boolean).join(' · ')}
        title={item.title}
        onClose={closeDetail}
        size="wide"
        footer={<>
          <button type="button" className="btn ghost danger bucket-detail-delete" onClick={() => deleteItem(item.id)}><Trash2 size={14} /> Delete</button>
          <button type="button" className="btn ghost" onClick={() => duplicateItem(item)} title="Make a copy to plan again"><CopyIcon size={14} /> Duplicate</button>
          {item.status === 'Dropped' && <button type="button" className="btn ghost" onClick={() => moveToStatus(item.id, 'Someday')}><Undo2 size={14} /> Bring back</button>}
          {item.status !== 'Achieved' && item.status !== 'Dropped' && <button type="button" className="btn teal" onClick={() => markAchieved(item)}><Trophy size={14} /> Mark achieved</button>}
          <button type="button" className="btn primary" onClick={closeDetail}>Done</button>
        </>}
      >
        <div className="bucket-detail">
          {item.coverArt && <div className="bucket-detail-cover" style={{ backgroundImage: `url(${item.coverArt})` }} />}

          <div className="bucket-detail-meta">
            <div className="segmented" role="group" aria-label="Status">
              {STATUSES.map(st => (
                <button type="button" key={st} className={item.status === st ? 'on' : ''} onClick={() => moveToStatus(item.id, st)}>{st}</button>
              ))}
            </div>
            <button type="button" className={`bucket-detail-chip bucket-pick-chip ${item.topPick ? 'on' : ''}`} onClick={() => patchItem(item, { topPick: !item.topPick })} aria-pressed={Boolean(item.topPick)}>
              <Star size={13} fill={item.topPick ? 'currentColor' : 'none'} /> Top pick
            </button>
            {target && <span className={`bucket-detail-chip tone-${target.tone}`}><CalendarDays size={13} /> {target.text}</span>}
            {item.status === 'Achieved' && item.achievedAt && <span className="bucket-detail-chip tone-gold"><Trophy size={13} /> Achieved {formatDate(item.achievedAt)}</span>}
          </div>

          {item.status === 'Achieved' ? (
            <>
              {memorySection}
              {/* Done is done: the planning side folds away under the memory. */}
              <details className="bucket-detail-fold">
                <summary>Details, steps and plan</summary>
                <div className="bucket-detail-fold-body">{planningSections}</div>
              </details>
            </>
          ) : planningSections}
        </div>
      </Modal>
    );
  };

  // Only one big card, and only on the plain "everything" view where it has neighbours to stand out from.
  const featuredId = !isMobile && layout === 'gallery' && statusTab === 'All' && !categoryTab && !search.trim() && filtered.length > 2 ? next?.id : undefined;

  const views: { value: Layout; label: string; icon: typeof LayoutGrid }[] = [
    { value: 'gallery', label: 'Gallery', icon: LayoutGrid },
    { value: 'list', label: 'List — compact, more on screen', icon: ListIcon },
    ...(isMobile ? [] : [{ value: 'board' as Layout, label: 'Board — drag between statuses', icon: Columns3 }]),
    { value: 'map', label: 'Map', icon: Globe },
    { value: 'memories', label: 'Memories — what you’ve done, by year', icon: Images }
  ];

  return (
    <>
      <PageHeader
        title="Travel & Bucket List"
        subtitle="Trips to plan, places to go, things to do before you die."
        action={
          <div className="bucket-header-actions">
            <button className="btn ghost" onClick={() => setDeckOpen(true)}><Sparkles size={16} /> Discover</button>
            {!isMobile && <button className="btn primary" onClick={startAdd}><Plus size={16} /> Add goal</button>}
          </div>
        }
      />

      {items.length > 0 && (
        <div className="bucket-summary">
          {(['Achieved', 'Planning', 'Someday'] as const).map(st => (
            <button type="button" key={st} className={`bucket-summary-stat status-${st.toLowerCase()} ${statusTab === st ? 'on' : ''}`} onClick={() => setStatusTab(statusTab === st ? 'All' : st)}>
              <b>{counts[st]}</b> {st.toLowerCase()}
            </button>
          ))}
          {counts.Dropped > 0 && (
            <button type="button" className={`bucket-summary-stat status-dropped ${statusTab === 'Dropped' ? 'on' : ''}`} onClick={() => setStatusTab(statusTab === 'Dropped' ? 'All' : 'Dropped')}>
              <b>{counts.Dropped}</b> dropped
            </button>
          )}
          {editingTarget ? (
            <span className="bucket-year editing">
              <input type="number" min="1" max="99" autoFocus value={targetDraft} placeholder="e.g. 4" aria-label="Goals to achieve each year"
                onChange={e => setTargetDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveYearTarget(); if (e.key === 'Escape') setEditingTarget(false); }} />
              <span>a year</span>
              <button type="button" className="text-btn" onClick={saveYearTarget}>Set</button>
            </span>
          ) : (
            <button type="button" className="bucket-year" onClick={() => { setTargetDraft(yearTarget ? String(yearTarget) : ''); setEditingTarget(true); }}
              title={yearTarget ? 'Change your yearly target' : 'Set how many you want to achieve each year'}>
              {yearTarget ? (
                <>
                  <svg viewBox="0 0 36 36" aria-hidden="true">
                    <circle cx="18" cy="18" r="15" className="track" />
                    <circle cx="18" cy="18" r="15" className="fill" strokeDasharray={`${Math.min(1, achievedThisYear / yearTarget) * 94.2} 94.2`} />
                  </svg>
                  <b>{achievedThisYear}</b> of {yearTarget} in {thisYear}
                </>
              ) : (
                <>+ Yearly target</>
              )}
            </button>
          )}
          {next && nextLabel && (
            <button type="button" className={`bucket-summary-next tone-${nextLabel.tone}`} onClick={() => setDetailId(next.id)}>
              <span>Next up</span> <b>{next.title}</b> <i>{nextLabel.text}</i>
            </button>
          )}
        </div>
      )}

      {duePrompts.map(item => (
        <div className="bucket-due" key={item.id}>
          <Trophy size={16} />
          <span>
            <b>{item.title}</b> — {backFrom(item)
              ? `you got back on ${formatDate(item.tripEnd)}.`
              : `its target date (${formatDate(item.targetDate)}) has arrived.`} Did you do it?
          </span>
          <button type="button" className="btn teal" onClick={() => markAchieved(item)}>Yes, achieved</button>
          <button type="button" className="btn ghost" onClick={() => setDetailId(item.id)}>Change dates</button>
          <button type="button" className="btn ghost" onClick={() => askInAWeek(item)}>Ask in a week</button>
          <button type="button" className="icon-btn" onClick={() => setSnoozed(prev => new Set(prev).add(item.id))} aria-label="Hide for now" title="Hide for now"><X size={14} /></button>
        </div>
      ))}

      <div className="bucket-toolbar has-view-toggle">
        <div className="view-toggle-btns">
          {views.map(v => (
            <button type="button" key={v.value} className={layout === v.value ? 'on' : ''} onClick={() => setLayout(v.value)} aria-label={`${v.label.split(' — ')[0]} view`} title={v.label}>
              <v.icon size={15} />
            </button>
          ))}
        </div>
        <div className="bucket-filter-row">
          {(layout === 'gallery' || layout === 'list') && <div className="segmented">
            {STATUS_TABS.filter(tab => tab !== 'Dropped' || counts.Dropped > 0 || statusTab === 'Dropped').map(tab => (
              <button type="button" key={tab} className={statusTab === tab ? 'on' : ''} onClick={() => setStatusTab(tab)}>{tab}</button>
            ))}
          </div>}
          <div className="bucket-chip-row">
            {allCategories.map(cat => {
              const removable = customCategories.includes(cat) && !items.some(i => i.category === cat);
              return (
                <span className="bucket-chip-wrap" key={cat}>
                  <button
                    type="button"
                    className={`bucket-chip ${categoryTab === cat ? 'on' : ''}`}
                    onClick={() => setCategoryTab(prev => (prev === cat ? null : cat))}
                  >
                    {cat}
                  </button>
                  {removable && <button type="button" className="bucket-chip-remove" onClick={() => removeCategory(cat)} aria-label={`Remove the ${cat} category`} title="Remove this category (no goals use it)"><X size={10} /></button>}
                </span>
              );
            })}
            {addingCategory ? (
              <input
                className="bucket-chip-input" autoFocus value={categoryDraft} placeholder="New category" aria-label="New category name"
                onChange={e => setCategoryDraft(e.target.value)}
                onBlur={addCategory}
                onKeyDown={e => { if (e.key === 'Enter') addCategory(); if (e.key === 'Escape') { setCategoryDraft(''); setAddingCategory(false); } }}
              />
            ) : (
              <button type="button" className="bucket-chip bucket-chip-add" onClick={() => setAddingCategory(true)} aria-label="Add a category" title="Add your own category"><Plus size={12} /></button>
            )}
          </div>
        </div>
        <div className="bucket-toolbar-right">
          <div className="bucket-search">
            <Search size={14} />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search goals, notes, steps…" />
          </div>
          {(layout === 'gallery' || layout === 'list') && (
            <div className="bucket-sort">
              <ArrowUpDown size={13} />
              <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)} aria-label="Sort goals">
                <option value="smart">Planning first</option>
                <option value="recent">Recently updated</option>
                <option value="title">Title A–Z</option>
                <option value="target">Target date</option>
                <option value="custom">Custom order</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {contextMenu}
      {boardMode ? (
        <div className="bucket-board">
          {ACTIVE_STATUSES.map(st => {
            // The board shows every active status, so it ignores the status tab but keeps category + search.
            const col = filteredAllStatuses.filter(i => i.status === st);
            return (
              <section
                key={st}
                className={`cp-board-col ${boardOver === st && dragId ? 'drag-over' : ''}`}
                onDragOver={e => { if (dragId) { e.preventDefault(); setBoardOver(st); } }}
                onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setBoardOver(null); }}
                onDrop={e => { e.preventDefault(); if (dragId) moveToStatus(dragId, st); setDragId(null); setBoardOver(null); }}
              >
                <header className="cp-board-head"><span className={`bucket-status-pill status-${st.toLowerCase()}`}>{st}</span><span className="cp-board-count">{col.length}</span></header>
                <div className="cp-board-list">
                  {col.map(item => {
                    const { done, total } = subtaskProgress(item);
                    const target = targetLabel(item, today);
                    return (
                      <button
                        type="button"
                        key={item.id}
                        draggable
                        className={`bucket-board-card ${dragId === item.id ? 'dragging' : ''}`}
                        onDragStart={e => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move'; }}
                        onDragEnd={() => { setDragId(null); setBoardOver(null); }}
                        onClick={() => setDetailId(item.id)}
                        onContextMenu={e => openMenu(e, goalMenu(item))}
                      >
                        <span className="bucket-board-cover" style={item.coverArt ? { backgroundImage: `url(${item.coverArt})` } : undefined} />
                        <span className="bucket-board-body">
                          <b>{item.title}</b>
                          <small>
                            {[item.category, item.location, costOf(item)].filter(Boolean).join(' · ')}
                            {target ? ` · ${target.text}` : ''}
                            {item.status === 'Achieved' && item.achievedAt ? ` · Achieved ${formatDate(item.achievedAt)}` : ''}
                          </small>
                          {total > 0 && <span className="bucket-board-progress"><ProgressBar value={(done / total) * 100} /><small>{done}/{total}</small></span>}
                        </span>
                      </button>
                    );
                  })}
                  {!col.length && <p className="cp-board-empty">Drop here</p>}
                </div>
              </section>
            );
          })}
        </div>
      ) : layout === 'map' ? (
        filteredAllStatuses.length ? (
          <BucketMap
            entries={placed}
            unplaced={unplaced}
            stat={visitedStat}
            onOpen={setDetailId}
            onPlace={(id, lon, lat) => { const item = items.find(i => i.id === id); if (item) patchItem(item, { pin: { lon, lat } }); }}
            onClearPin={id => { const item = items.find(i => i.id === id); if (item) patchItem(item, { pin: undefined }); }}
          />
        ) : (
          <Card><EmptyState>Nothing matches these filters.</EmptyState></Card>
        )
      ) : layout === 'list' ? (
        filtered.length ? (
          <div className="bucket-list">
            {filtered.map(item => {
              const { done, total } = subtaskProgress(item);
              const target = targetLabel(item, today);
              return (
                <button type="button" key={item.id} className={`bucket-list-row status-${item.status.toLowerCase()}`} onClick={() => setDetailId(item.id)} onContextMenu={e => openMenu(e, goalMenu(item))}>
                  <span className="bucket-list-thumb" style={item.coverArt ? { backgroundImage: `url(${item.coverArt})` } : undefined} />
                  <span className="bucket-list-text">
                    <b>{item.topPick && <Star size={12} fill="currentColor" />}{item.title}</b>
                    <small>
                      {[item.category, item.location, costOf(item)].filter(Boolean).join(' · ')}
                      {total > 0 ? ` · ${done}/${total} steps` : ''}
                    </small>
                  </span>
                  <span className="bucket-list-side">
                    <span className={`bucket-list-status status-${item.status.toLowerCase()}`}>{item.status}</span>
                    {target && <small className={`tone-${target.tone}`}>{target.text}</small>}
                    {item.status === 'Achieved' && item.achievedAt && <small className="tone-gold">{formatDate(item.achievedAt)}</small>}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <Card><EmptyState>{items.length ? 'Nothing matches these filters.' : 'Nothing here yet — add your first goal.'}</EmptyState></Card>
        )
      ) : layout === 'memories' ? (
        memoryYears.length ? (
          <div className="bucket-memories">
            {memoryYears.map(([year, list]) => (
              <section key={year}>
                <h2>{year} <span>{list.length} achieved</span></h2>
                <div className="bucket-memory-grid">
                  {list.map(item => {
                    const photos = (item.memoryPhotos ?? []).filter(u => !brokenPhotos.has(u));
                    const hero = photos[0] ?? item.coverArt;
                    const words = toPlainText(item.reflection ?? '');
                    return (
                      <div key={item.id} className="bucket-memory" role="button" tabIndex={0} onClick={() => setDetailId(item.id)}
                        onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDetailId(item.id); } }}>
                        {photos.length ? (
                          <button type="button" className="bucket-memory-hero" style={{ backgroundImage: `url(${hero})` }}
                            onClick={e => { e.stopPropagation(); setLightbox({ urls: photos, index: 0 }); }} aria-label={`View ${photos.length} photo${photos.length === 1 ? '' : 's'} from ${item.title}`}>
                            {photos.length > 1 && <i>+{photos.length - 1}</i>}
                          </button>
                        ) : (
                          <span className="bucket-memory-hero" style={hero ? { backgroundImage: `url(${hero})` } : undefined} />
                        )}
                        <span className="bucket-memory-body">
                          <b>{item.title}</b>
                          <small><Trophy size={11} /> {item.achievedAt ? formatDate(item.achievedAt) : 'No date'}{item.location ? ` · ${item.location}` : ''}</small>
                          <span className={words ? '' : 'muted'}>{words || 'No reflection written yet — tap to add one.'}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <Card><EmptyState>Nothing achieved yet — your memories will collect here, year by year.</EmptyState></Card>
        )
      ) : filtered.length ? (
        <div className="bucket-grid">
          {filtered.map(item => {
            const { done, total } = subtaskProgress(item);
            const featured = item.id === featuredId;
            const target = targetLabel(item, today);
            return (
              <div
                className={`bucket-card status-${item.status.toLowerCase()} ${featured ? 'featured' : ''} ${dragId === item.id ? 'dragging' : ''}`}
                key={item.id}
                onContextMenu={e => openMenu(e, goalMenu(item))}
                onDragOver={e => e.preventDefault()}
                onDrop={() => void handleDrop(item.id)}
              >
                <div className="bucket-card-inner">
                  <div
                    className="bucket-card-face bucket-card-front"
                    draggable
                    role="button"
                    tabIndex={0}
                    title="Open — or drag to reorder"
                    onClick={() => setDetailId(item.id)}
                    onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setDetailId(item.id); } }}
                    onDragStart={e => {
                      setDragId(item.id);
                      e.dataTransfer.effectAllowed = 'move';
                      const card = e.currentTarget.closest('.bucket-card');
                      if (card instanceof HTMLElement) e.dataTransfer.setDragImage(card, 20, 20);
                    }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <div
                      className="bucket-card-cover"
                      style={item.coverArt ? { backgroundImage: `url(${item.coverArt})` } : undefined}
                    >
                      {!item.coverArt && <div className="bucket-card-fallback" />}
                    </div>
                    <span className="bucket-card-scrim" aria-hidden="true" />
                    <div className="bucket-card-top">
                      <button
                        type="button"
                        className={`bucket-status-pill status-${item.status.toLowerCase()}`}
                        onClick={e => { e.stopPropagation(); openMenu(e, statusMenu(item)); }}
                        aria-label={`Status: ${item.status}. Change status`}
                        title="Change status"
                      >
                        {item.status === 'Achieved' && <Trophy size={9} />}{item.status} <ChevronDown size={9} />
                      </button>
                      <span className="bucket-card-top-right">
                        <button type="button" className={`bucket-pick ${item.topPick ? 'on' : ''}`} onClick={e => { e.stopPropagation(); patchItem(item, { topPick: !item.topPick }); }}
                          aria-pressed={Boolean(item.topPick)} aria-label={item.topPick ? 'Remove from top picks' : 'Make this a top pick'} title={item.topPick ? 'Top pick — tap to remove' : 'Make this a top pick'}>
                          <Star size={12} fill={item.topPick ? 'currentColor' : 'none'} />
                        </button>
                        {costOf(item) && <span className="bucket-cost-pill">{costOf(item)}</span>}
                      </span>
                    </div>
                    <div className="bucket-card-actions">
                      <button type="button" className="icon-btn" onClick={e => { e.stopPropagation(); startEdit(item); }} aria-label={`Edit ${item.title}`}><Pencil size={13} /></button>
                      <button type="button" className="icon-btn danger" onClick={e => { e.stopPropagation(); deleteItem(item.id); }} aria-label={`Delete ${item.title}`}><Trash2 size={13} /></button>
                    </div>
                    <div className="bucket-card-body">
                      <b>{item.title}</b>
                      {item.location && <small><MapPin size={11} /> {item.location}</small>}
                      {target && <small className={`bucket-target tone-${target.tone}`}><CalendarDays size={11} /> {target.text}</small>}
                      {item.status === 'Achieved' && item.achievedAt && <small className="bucket-achieved-on"><Trophy size={11} /> Achieved {formatDate(item.achievedAt)}</small>}
                      {total > 0 && (
                        <div className="bucket-card-progress">
                          <ProgressBar value={(done / total) * 100} />
                          <small>{done}/{total} steps</small>
                        </div>
                      )}
                    </div>
                    <div className="bucket-card-footer">
                      {item.status === 'Achieved' ? (
                        <button type="button" className="bucket-action-btn" onClick={e => { e.stopPropagation(); setDetailId(item.id); }}>
                          <ImageIcon size={13} /> Memory
                        </button>
                      ) : item.status === 'Dropped' ? (
                        <button type="button" className="bucket-action-btn" onClick={e => { e.stopPropagation(); moveToStatus(item.id, 'Someday'); }}>
                          <Undo2 size={13} /> Bring back
                        </button>
                      ) : (
                        <button type="button" className="bucket-action-btn achieve" onClick={e => { e.stopPropagation(); markAchieved(item); }}>
                          <Trophy size={13} /> Mark achieved
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Card><EmptyState>{items.length ? 'Nothing matches these filters.' : 'Nothing here yet — add your first goal.'}</EmptyState></Card>
      )}

      {detail && renderDetail(detail)}
      {showForm && <ItemFormModal item={formItem} categories={allCategories} onClose={closeForm} onSave={save} />}
      {deckOpen && <DiscoveryDeck existingTitles={existingTitles} onAdd={addFromDeck} onClose={() => setDeckOpen(false)} />}
      {lightbox && lightbox.urls.length > 0 && (
        <div className="photo-lightbox-overlay" onClick={() => setLightbox(null)}>
          <button type="button" className="photo-lightbox-close" onClick={() => setLightbox(null)} aria-label="Close">
            <X size={20} />
          </button>
          {lightbox.urls.length > 1 && (
            <button type="button" className="photo-lightbox-nav prev" aria-label="Previous photo"
              onClick={e => { e.stopPropagation(); setLightbox({ ...lightbox, index: (lightbox.index - 1 + lightbox.urls.length) % lightbox.urls.length }); }}>
              <ChevronLeft size={22} />
            </button>
          )}
          <img src={lightbox.urls[lightbox.index]} alt="" className="photo-lightbox-image" onClick={e => e.stopPropagation()} />
          {lightbox.urls.length > 1 && (
            <>
              <button type="button" className="photo-lightbox-nav next" aria-label="Next photo"
                onClick={e => { e.stopPropagation(); setLightbox({ ...lightbox, index: (lightbox.index + 1) % lightbox.urls.length }); }}>
                <ChevronRight size={22} />
              </button>
              <span className="photo-lightbox-count">{lightbox.index + 1} of {lightbox.urls.length}</span>
            </>
          )}
        </div>
      )}
      {celebrate > 0 && <Confetti key={celebrate} />}
      <input ref={coverFileRef} type="file" accept="image/*" hidden onChange={e => void onCoverFileSelected(e)} />
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={e => void onPhotoFileSelected(e)} />
      {/* Off-screen copies of every linked memory photo: one that fails to load is marked broken. */}
      <div className="bucket-photo-probes" aria-hidden="true">
        {photoUrls.filter(u => !brokenPhotos.has(u)).map(u => <img key={u} src={u} alt="" onError={() => markBroken(u)} />)}
      </div>
    </>
  );
}
