import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  AlertTriangle, ArrowUpDown, Check, ChevronLeft, ChevronRight, Image as ImageIcon, MapPin,
  Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, Trophy, Upload, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { BucketListCategory, BucketListItem, BucketListStatus, BucketListSubtask, CostTier } from '../types';
import { Card, EmptyState, Modal, PageHeader, ProgressBar, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor } from '../components/RichTextEditor';
import { generateId } from '../utils/id';
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

// Editorial asymmetry: celebrate what's done, and spotlight what's actively being
// pursued toward a real date — vague "someday" dreams stay small until they earn it.
function isFeatured(item: BucketListItem): boolean {
  return item.status === 'Achieved' || (item.status === 'Planning' && Boolean(item.targetDate));
}

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
  const items = data.bucketList;

  const [statusTab, setStatusTab] = useState<StatusTab>('All');
  const [categoryTab, setCategoryTab] = useState<BucketListCategory | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortByState] = useState<SortBy>(loadSavedSort);
  const setSortBy = (next: SortBy) => {
    setSortByState(next);
    window.localStorage.setItem(SORT_STORAGE_KEY, next);
  };
  const [flippedIds, setFlippedIds] = useState<Set<string>>(new Set());
  const [formItem, setFormItem] = useState<BucketListItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [photoDrafts, setPhotoDrafts] = useState<Record<string, string>>({});
  const [deckOpen, setDeckOpen] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<BucketListItem | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items
      .filter(i => statusTab === 'All' || i.status === statusTab)
      .filter(i => !categoryTab || i.category === categoryTab)
      .filter(i => !q || i.title.toLowerCase().includes(q) || (i.location ?? '').toLowerCase().includes(q));
    const sorted = list.slice();
    if (sortBy === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title));
    else if (sortBy === 'target') sorted.sort((a, b) => (a.targetDate ?? '9999-99-99').localeCompare(b.targetDate ?? '9999-99-99'));
    else if (sortBy === 'custom') sorted.sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
    else sorted.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return sorted;
  }, [items, statusTab, categoryTab, search, sortBy]);

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
    const next = [...ordered];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, dragId);
    await Promise.all(next.map((id, index) => {
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
    setFlippedIds(prev => new Set(prev).add(item.id));
  };

  const toggleFlip = (id: string) => {
    setFlippedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const addPhoto = (item: BucketListItem) => {
    const url = (photoDrafts[item.id] ?? '').trim();
    if (!url) return;
    patchItem(item, { memoryPhotos: [...(item.memoryPhotos ?? []), url] });
    setPhotoDrafts(prev => ({ ...prev, [item.id]: '' }));
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
      /* unreadable file — silently skip rather than block the rest of the card */
    } finally {
      setUploadingFor(null);
    }
  };

  const startAdd = () => { setFormItem(null); setShowForm(true); };
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

  const deleteItem = (id: string) => {
    if (!window.confirm('Delete this goal? This cannot be undone.')) return;
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

  return (
    <>
      <PageHeader
        title="Travel & Bucket List"
        subtitle="Trips to plan, places to go, things to do before you die."
        action={
          <div className="bucket-header-actions">
            <button className="btn ghost" onClick={() => setDeckOpen(true)}><Sparkles size={16} /> Discover</button>
            <button className="btn primary" onClick={startAdd}><Plus size={16} /> Add goal</button>
          </div>
        }
      />

      <div className="bucket-toolbar">
        <div className="segmented">
          {STATUS_TABS.map(tab => (
            <button type="button" key={tab} className={statusTab === tab ? 'on' : ''} onClick={() => setStatusTab(tab)}>{tab}</button>
          ))}
        </div>
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
        <div className="bucket-toolbar-right">
          <div className="bucket-search">
            <Search size={14} />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search goals…" />
          </div>
          <div className="bucket-sort">
            <ArrowUpDown size={13} />
            <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)} aria-label="Sort goals">
              <option value="recent">Recently updated</option>
              <option value="title">Title A–Z</option>
              <option value="target">Target date</option>
              <option value="custom">Custom order</option>
            </select>
          </div>
        </div>
      </div>

      {filtered.length ? (
        <div className="bucket-grid">
          {filtered.map(item => {
            const flipped = flippedIds.has(item.id);
            const { done, total } = subtaskProgress(item);
            const featured = isFeatured(item);
            return (
              <div
                className={`bucket-card ${flipped ? 'flipped' : ''} ${featured ? 'featured' : ''} ${dragId === item.id ? 'dragging' : ''}`}
                key={item.id}
                onDragOver={e => e.preventDefault()}
                onDrop={() => void handleDrop(item.id)}
              >
                <div className="bucket-card-inner">
                  <div
                    className="bucket-card-face bucket-card-front"
                    draggable
                    title="Drag to reorder"
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
                      <span className={`bucket-status-pill status-${item.status.toLowerCase()}`}>{item.status}</span>
                      {item.costTier && <span className="bucket-cost-pill">{item.costTier}</span>}
                    </div>
                    <div className="bucket-card-actions">
                      <button type="button" className="icon-btn" onClick={() => startEdit(item)} aria-label={`Edit ${item.title}`}><Pencil size={13} /></button>
                      <button type="button" className="icon-btn danger" onClick={() => deleteItem(item.id)} aria-label={`Delete ${item.title}`}><Trash2 size={13} /></button>
                    </div>
                    <div className="bucket-card-body">
                      <b>{item.title}</b>
                      {item.location && <small><MapPin size={11} /> {item.location}</small>}
                      {item.targetDate && item.status !== 'Achieved' && <small>Target: {formatDate(item.targetDate)}</small>}
                      {total > 0 && (
                        <div className="bucket-card-progress">
                          <ProgressBar value={total ? (done / total) * 100 : 0} />
                          <small>{done}/{total} steps</small>
                        </div>
                      )}
                    </div>
                    <div className="bucket-card-footer">
                      {item.status === 'Achieved' ? (
                        <button type="button" className="bucket-action-btn" onClick={() => toggleFlip(item.id)}>
                          <ImageIcon size={13} /> View memory
                        </button>
                      ) : (
                        <button type="button" className="bucket-action-btn achieve" onClick={() => markAchieved(item)}>
                          <Trophy size={13} /> Mark achieved
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="bucket-card-face bucket-card-back">
                    <div className="bucket-journal-head">
                      <Trophy size={16} />
                      <b>{item.title}</b>
                      <button type="button" className="icon-btn" onClick={() => toggleFlip(item.id)} aria-label="Flip back"><RotateCcw size={14} /></button>
                    </div>
                    <label className="bucket-journal-date">
                      <span>Achieved</span>
                      <DatePicker value={item.achievedAt} onChange={v => patchItem(item, { achievedAt: v })} placeholder="Set date" />
                    </label>
                    <RichTextEditor
                      value={item.reflection ?? ''}
                      onChange={v => patchItem(item, { reflection: v })}
                      placeholder="How did it feel? What will you remember?"
                    />
                    <div className="bucket-journal-photos">
                      {(item.memoryPhotos ?? []).map(url => (
                        <div className="bucket-journal-photo" key={url}>
                          <button type="button" className="bucket-journal-photo-expand" onClick={() => setLightboxUrl(url)} aria-label="View full-size photo">
                            <img src={url} alt="" />
                          </button>
                          <button type="button" className="bucket-journal-photo-remove" onClick={() => removePhoto(item, url)} aria-label="Remove photo"><X size={11} /></button>
                        </div>
                      ))}
                    </div>
                    <div className="bucket-journal-add-photo">
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => triggerPhotoUpload(item)}
                        disabled={uploadingFor === item.id}
                        title="Upload a photo from your device"
                      >
                        <Upload size={13} /> {uploadingFor === item.id ? 'Uploading…' : 'Upload'}
                      </button>
                      <input
                        type="text"
                        value={photoDrafts[item.id] ?? ''}
                        onChange={e => setPhotoDrafts(prev => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="…or paste a photo URL"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPhoto(item); } }}
                      />
                      <button type="button" className="btn ghost small" onClick={() => addPhoto(item)}>Add</button>
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
