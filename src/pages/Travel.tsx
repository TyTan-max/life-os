import { useEffect, useMemo, useRef, useState } from 'react';
import { takeJumpFor } from '../lib/jumpTo';
import type { ChangeEvent } from 'react';
import {
  AlertTriangle, ArrowUpDown, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Columns3, Globe, Image as ImageIcon, ImageOff, Images,
  LayoutGrid, MapPin, Pencil, Plus, Search, Sparkles, Trash2, Trophy, Upload, Wallet, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { BucketListCategory, BucketListItem, BucketListStatus, BucketListSubtask, CostTier } from '../types';
import { Card, EmptyState, Modal, PageHeader, ProgressBar, formatCurrency, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor, sanitizeHtml } from '../components/RichTextEditor';
import { toPlainText } from '../lib/loggedNotes';
import { LAND_PATH, MAP_H, MAP_W, locate, project } from '../lib/worldMap';
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
const STATUSES: BucketListStatus[] = ['Someday', 'Planning', 'Achieved'];
const COST_TIERS: CostTier[] = ['$', '$$', '$$$'];

type StatusTab = 'All' | BucketListStatus;
const STATUS_TABS: StatusTab[] = ['All', ...STATUSES];

type SortBy = 'recent' | 'title' | 'target' | 'custom';

const SORT_STORAGE_KEY = 'travel-sort-by';
const SORT_VALUES: SortBy[] = ['recent', 'title', 'target', 'custom'];

// Sort choice lives in component state, which resets on unmount — switching tabs and back
// would otherwise silently drop back to "Recently updated" even though the underlying
// `order` values are still saved, making a custom drag order look like it didn't persist.
function loadSavedSort(): SortBy {
  const saved = window.localStorage.getItem(SORT_STORAGE_KEY);
  return (SORT_VALUES as string[]).includes(saved ?? '') ? (saved as SortBy) : 'recent';
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
  if (!item.targetDate || item.status === 'Achieved') return null;
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

type Layout = 'gallery' | 'board' | 'map' | 'memories';
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

function ItemFormModal({
  item, onClose, onSave
}: { item: BucketListItem | null; onClose: () => void; onSave: (patch: Partial<BucketListItem>) => void }) {
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
    if (!unsplashReady || form.coverArt || title.length < 4) return;
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
  }, [form.title, form.location, form.coverArt, unsplashReady]);

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
              value={form.coverArt ?? ''}
              onChange={e => set('coverArt', e.target.value)}
              placeholder={unsplashReady ? 'Paste a URL, or search below…' : 'https://…'}
            />
            {unsplashReady && (
              <button type="button" className="btn ghost small" onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}>
                <Search size={13} /> {pickerOpen ? 'Close' : 'Search photos'}
              </button>
            )}
            {Boolean(form.coverArt) && <img className="image-field-preview" src={form.coverArt} alt="" />}
          </div>
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
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
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
      const avoid = [...existingTitles, ...deck.map(d => d.title.toLowerCase())];
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
        {genError && (
          <div className="deck-error"><AlertTriangle size={13} /> {genError}</div>
        )}

        {idea ? (
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
  const { data, upsert, remove } = useStore();
  const isMobile = useIsMobile();
  const items = data.bucketList;
  const today = localIso();

  const [statusTab, setStatusTab] = useState<StatusTab>('All');
  const [categoryTab, setCategoryTab] = useState<BucketListCategory | null>(null);
  const [search, setSearch] = useState('');
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
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // Photos whose link no longer loads (a pasted URL that has since died).
  const [brokenPhotos, setBrokenPhotos] = useState<Set<string>>(new Set());
  const markBroken = (url: string) => setBrokenPhotos(prev => (prev.has(url) ? prev : new Set(prev).add(url)));
  // "Did you do it?" prompts put off for this visit.
  const [snoozed, setSnoozed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!lightboxUrl) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxUrl(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxUrl]);

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
      .filter(i => statusTab === 'All' || i.status === statusTab)
      .filter(i => !categoryTab || i.category === categoryTab)
      .filter(i => matchesSearch(i, q));
    const sorted = list.slice();
    if (sortBy === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
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
    Someday: items.filter(i => i.status === 'Someday').length
  }), [items]);
  const next = useMemo(() => nextUp(items), [items]);
  const nextLabel = next ? targetLabel(next, today) : null;
  // Goals whose target date has arrived without being marked achieved.
  const duePrompts = items.filter(i => i.status !== 'Achieved' && i.targetDate && i.targetDate <= today && !snoozed.has(i.id));

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
    void upsert('bucketList', { ...item, ...patch });
  };

  const markAchieved = (item: BucketListItem) => {
    patchItem(item, { status: 'Achieved', achievedAt: item.achievedAt ?? localIso() });
    setDetailId(item.id);
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

  const addPhoto = (item: BucketListItem) => {
    const url = photoDraft.trim();
    if (!url) return;
    patchItem(item, { memoryPhotos: [...(item.memoryPhotos ?? []), url] });
    setPhotoDraft('');
  };
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
      return saved === 'board' || saved === 'map' || saved === 'memories' ? saved : 'gallery';
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
    if (detailId === id) setDetailId(null);
    void remove('bucketList', id);
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
  const placed = useMemo(() => filteredAllStatuses
    .map(item => ({ item, at: locate(item.location, item.title) }))
    .filter((p): p is { item: BucketListItem; at: NonNullable<ReturnType<typeof locate>> } => p.at !== null),
  [filteredAllStatuses]);
  const unplaced = filteredAllStatuses.filter(i => !placed.some(p => p.item.id === i.id));

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
      {(item[key] ?? []).map(t => (
        <div className="bucket-check-row" key={t.id}>
          <label>
            <input type="checkbox" checked={t.done} onChange={() => toggleEntry(item, key, t.id)} />
            <span className={t.done ? 'done' : ''}>{t.text}</span>
          </label>
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
    const packing = item.packing ?? [];
    return (
      <Modal
        eyebrow={[item.category, item.location].filter(Boolean).join(' · ')}
        title={item.title}
        onClose={closeDetail}
        size="wide"
        footer={<>
          <button type="button" className="btn ghost danger bucket-detail-delete" onClick={() => deleteItem(item.id)}><Trash2 size={14} /> Delete</button>
          <button type="button" className="btn ghost" onClick={() => { closeDetail(); startEdit(item); }}><Pencil size={14} /> Edit details</button>
          {item.status !== 'Achieved' && <button type="button" className="btn teal" onClick={() => markAchieved(item)}><Trophy size={14} /> Mark achieved</button>}
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
            {item.costTier && <span className="bucket-detail-chip">{item.costTier}</span>}
            {target && <span className={`bucket-detail-chip tone-${target.tone}`}><CalendarDays size={13} /> {target.text}</span>}
            {item.status === 'Achieved' && item.achievedAt && <span className="bucket-detail-chip tone-gold"><Trophy size={13} /> Achieved {formatDate(item.achievedAt)}</span>}
          </div>

          {item.notes && toPlainText(item.notes) && (
            <section>
              <h3>Why it matters</h3>
              <div className="bucket-detail-notes" dangerouslySetInnerHTML={{ __html: sanitizeHtml(item.notes) }} />
            </section>
          )}

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
              {item.budget != null && nights != null && nights > 0 && (
                <p className="muted bucket-trip-note">About {formatCurrency(item.budget / nights)} a night.</p>
              )}
              <h4>Pack &amp; book {packing.length > 0 && <span>{packing.filter(p => p.done).length} of {packing.length}</span>}</h4>
              {renderChecklist(item, 'packing', packDraft, setPackDraft, 'Add something — e.g. Passport, travel insurance')}
            </section>
          )}

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
                {(item.memoryPhotos ?? []).map(url => (
                  <div className={`bucket-journal-photo ${brokenPhotos.has(url) ? 'broken' : ''}`} key={url}>
                    {brokenPhotos.has(url) ? (
                      <span className="bucket-photo-missing" title="This photo's link no longer works"><ImageOff size={18} /><small>Photo unavailable</small></span>
                    ) : (
                      <button type="button" className="bucket-journal-photo-expand" onClick={() => setLightboxUrl(url)} aria-label="View full-size photo">
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
        </div>
      </Modal>
    );
  };

  // Only one big card, and only on the plain "everything" view where it has neighbours to stand out from.
  const featuredId = !isMobile && layout === 'gallery' && statusTab === 'All' && !categoryTab && !search.trim() && filtered.length > 2 ? next?.id : undefined;

  const views: { value: Layout; label: string; icon: typeof LayoutGrid }[] = [
    { value: 'gallery', label: 'Gallery', icon: LayoutGrid },
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
          <span><b>{item.title}</b> — its target date ({formatDate(item.targetDate)}) has arrived. Did you do it?</span>
          <button type="button" className="btn teal" onClick={() => markAchieved(item)}>Yes, achieved</button>
          <button type="button" className="btn ghost" onClick={() => startEdit(item)}>New date</button>
          <button type="button" className="icon-btn" onClick={() => setSnoozed(prev => new Set(prev).add(item.id))} aria-label="Ask me later" title="Ask me later"><X size={14} /></button>
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
          {layout === 'gallery' && <div className="segmented">
            {STATUS_TABS.map(tab => (
              <button type="button" key={tab} className={statusTab === tab ? 'on' : ''} onClick={() => setStatusTab(tab)}>{tab}</button>
            ))}
          </div>}
          <div className="bucket-chip-row">
            {CATEGORIES.map(cat => (
              <button
                type="button"
                key={cat}
                className={`bucket-chip ${categoryTab === cat ? 'on' : ''}`}
                onClick={() => setCategoryTab(prev => (prev === cat ? null : cat))}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
        <div className="bucket-toolbar-right">
          <div className="bucket-search">
            <Search size={14} />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search goals, notes, steps…" />
          </div>
          {layout === 'gallery' && (
            <div className="bucket-sort">
              <ArrowUpDown size={13} />
              <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)} aria-label="Sort goals">
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
          {STATUSES.map(st => {
            // The board shows every status, so it ignores the status tab but keeps category + search.
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
                            {[item.category, item.location, item.costTier].filter(Boolean).join(' · ')}
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
        <div className="bucket-map-wrap">
          <div className="bucket-map">
            <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="World map of your goals">
              <path d={LAND_PATH} className="bucket-map-land" />
              {placed.map(({ item, at }) => {
                const [x, y] = project(at.lon, at.lat);
                return (
                  <g key={item.id} className={`bucket-map-pin status-${item.status.toLowerCase()}`} transform={`translate(${x} ${y})`}
                    onClick={() => setDetailId(item.id)} role="button" tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailId(item.id); } }}>
                    <title>{`${item.title}${item.location ? ` — ${item.location}` : ''} (${item.status})`}</title>
                    <circle r="11" className="bucket-map-halo" />
                    <circle r="5.5" />
                  </g>
                );
              })}
            </svg>
            <div className="bucket-map-legend">
              <span className="status-achieved"><i /> Achieved</span>
              <span className="status-planning"><i /> Planning</span>
              <span className="status-someday"><i /> Someday</span>
            </div>
          </div>
          {placed.length > 0 && (
            <div className="bucket-map-list">
              {placed.map(({ item }) => (
                <button type="button" key={item.id} onClick={() => setDetailId(item.id)}>
                  <i className={`status-${item.status.toLowerCase()}`} /> <b>{item.title}</b> <small>{item.location ?? ''}</small>
                </button>
              ))}
            </div>
          )}
          {unplaced.length > 0 && (
            <p className="muted bucket-map-unplaced">
              Not on the map ({unplaced.length}): {unplaced.map(i => i.title).join(', ')}. Add a country or city to a goal’s Location to place it.
            </p>
          )}
          {!filteredAllStatuses.length && <Card><EmptyState>Nothing matches these filters.</EmptyState></Card>}
        </div>
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
                      <button type="button" key={item.id} className="bucket-memory" onClick={() => setDetailId(item.id)}>
                        <span className="bucket-memory-hero" style={hero ? { backgroundImage: `url(${hero})` } : undefined}>
                          {photos.length > 1 && <i>+{photos.length - 1}</i>}
                        </span>
                        <span className="bucket-memory-body">
                          <b>{item.title}</b>
                          <small><Trophy size={11} /> {item.achievedAt ? formatDate(item.achievedAt) : 'No date'}{item.location ? ` · ${item.location}` : ''}</small>
                          <span className={words ? '' : 'muted'}>{words || 'No reflection written yet — tap to add one.'}</span>
                        </span>
                      </button>
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
                      {item.costTier && <span className="bucket-cost-pill">{item.costTier}</span>}
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
      {showForm && <ItemFormModal item={formItem} onClose={closeForm} onSave={save} />}
      {deckOpen && <DiscoveryDeck existingTitles={existingTitles} onAdd={addFromDeck} onClose={() => setDeckOpen(false)} />}
      {lightboxUrl && (
        <div className="photo-lightbox-overlay" onClick={() => setLightboxUrl(null)}>
          <button type="button" className="photo-lightbox-close" onClick={() => setLightboxUrl(null)} aria-label="Close">
            <X size={20} />
          </button>
          <img src={lightboxUrl} alt="" className="photo-lightbox-image" onClick={e => e.stopPropagation()} />
        </div>
      )}
      <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={e => void onPhotoFileSelected(e)} />
    </>
  );
}
