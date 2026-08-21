import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown01, ArrowDownAZ, ArrowUp01, ArrowUpZA, Check, ChevronDown, Copy, Dices, Eye, EyeOff,
  LayoutGrid, List as ListIcon, ListTodo, Pencil, Plus, Search, Shuffle, Trash2, Upload, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { CollectionName, CollectionRecord } from '../types';
import { Card, EmptyState, Modal, PageHeader, formatDate } from './UI';
import { DatePicker } from './DatePicker';
import { RichTextEditor } from './RichTextEditor';

export type FieldType = 'text' | 'textarea' | 'richtext' | 'number' | 'date' | 'select' | 'checkbox' | 'tags' | 'image' | 'multiselect' | 'color';

export type SelectOption = string | { label: string; value: string };

function optValue(opt: SelectOption): string { return typeof opt === 'string' ? opt : opt.value; }
function optLabel(opt: SelectOption): string { return typeof opt === 'string' ? opt : opt.label; }

export interface FieldConfig<T> {
  key: keyof T & string;
  label: string;
  type: FieldType;
  options?: SelectOption[];
  placeholder?: string;
}

export interface GalleryConfig<T> {
  coverKey: keyof T & string;
  coverAccent: string;
  badge?: (record: T) => string | undefined;
  rating?: (record: T) => number | undefined;
  meta?: (record: T) => string | undefined;
}

export interface StatusFilterConfig<T> {
  key: keyof T & string;
  groups: { label: string; values: string[] }[];
  // When true, "All" excludes anything covered by a group — so a record only shows in
  // its specific tab once categorized, and "All" is left as the default/uncategorized bucket.
  allExcludesGrouped?: boolean;
}

export interface GenreFilterConfig<T> {
  key: keyof T & string;
  label?: string;
}

export interface AutofillResult {
  label: string;
  cover?: string;
  resolvePatch: () => Promise<Record<string, unknown>>;
}

export interface AutofillConfig<T> {
  titleKey: keyof T & string;
  search: (query: string) => Promise<AutofillResult[]>;
  disabledReason?: string;
}

export interface TableColumn<T> {
  key: string;
  label: string;
  align?: 'left' | 'right';
  render: (record: T) => ReactNode;
}

export interface TableConfig<T> {
  columns: TableColumn<T>[];
}

interface CollectionPageProps<T extends CollectionRecord> {
  collection: CollectionName;
  title: string;
  subtitle?: string;
  itemLabel?: string;
  fields: FieldConfig<T>[];
  defaults: Omit<T, 'id' | 'createdAt' | 'updatedAt'>;
  renderTitle: (record: T) => string;
  renderSubtitle?: (record: T) => string;
  sortBy?: (a: T, b: T) => number;
  gallery?: GalleryConfig<T>;
  statusFilter?: StatusFilterConfig<T>;
  genreFilter?: GenreFilterConfig<T>;
  autofill?: AutofillConfig<T>;
  leading?: (record: T) => ReactNode;
  table?: TableConfig<T>;
  embedded?: boolean;
  onFieldChange?: (key: string, value: unknown, form: Partial<T>) => Partial<T> | void;
  // A boolean field marking records bulk-import couldn't find a match for — they're held out
  // of the normal grid/list and surfaced in their own "Needs Info" tab instead.
  needsReviewKey?: keyof T & string;
  // Extra action(s) rendered in the header next to Bulk import/Add — e.g. a "Discover" button
  // that owns its own open/close state and modal, fully controlled by the calling page.
  headerExtra?: ReactNode;
  // Field the Oldest/Newest sort button uses instead of createdAt (when set) — e.g. a game's
  // actual release date rather than when it was added to your list. Records missing a value
  // for this field always sort to the end, regardless of direction.
  dateSortKey?: keyof T & string;
  // Label shown in the sort button's tooltip, e.g. "release date" — defaults to "date added".
  dateSortLabel?: string;
}

function renderStars(rating: number): string {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function formatFieldValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) return value.length ? value.join(', ') : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function isEmptyHtml(html: string): boolean {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().length === 0;
}

function normalizeMatchText(s: string): string {
  return s.trim().toLowerCase();
}

// AutofillResult labels are always "Title · <year/author/etc>" (tmdb.ts,
// igdb.ts, openLibrary.ts all follow this convention) — the title is
// everything before the first separator.
function titleFromLabel(label: string): string {
  return normalizeMatchText(label.split(' · ')[0]);
}

function TagsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      onChange={e => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean));
      }}
    />
  );
}

function MultiSelectField({
  value, onChange, options, placeholder
}: {
  value: string[];
  onChange: (v: string[]) => void;
  options: SelectOption[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return; // scrolling the option list itself
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const openDropdown = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setOpen(o => !o);
  };

  const toggle = (opt: SelectOption) => {
    const v = optValue(opt);
    onChange(value.includes(v) ? value.filter(x => x !== v) : [...value, v]);
  };

  const displayLabels = value.map(v => {
    const match = options.find(o => optValue(o) === v);
    return match ? optLabel(match) : v;
  });

  return (
    <div className="multiselect-field">
      <button type="button" ref={triggerRef} className="multiselect-trigger" onClick={openDropdown}>
        <span className={displayLabels.length ? '' : 'multiselect-placeholder'}>
          {displayLabels.length ? displayLabels.join(', ') : (placeholder ?? 'Select…')}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && createPortal(
        <div className="multiselect-dropdown" ref={popoverRef} style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          {options.map(opt => (
            <button type="button" key={optValue(opt)} className={value.includes(optValue(opt)) ? 'on' : ''} onClick={() => toggle(opt)}>
              <span className="multiselect-check">{value.includes(optValue(opt)) && <Check size={13} />}</span>
              {optLabel(opt)}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

function TitleAutofillField({
  value, onChange, onPick, search, placeholder, disabledReason
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (patch: Record<string, unknown>) => void;
  search: (q: string) => Promise<AutofillResult[]>;
  placeholder?: string;
  disabledReason?: string;
}) {
  const [results, setResults] = useState<AutofillResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (inputRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && popoverRef.current?.contains(target)) return; // scrolling the results list itself
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  const runSearch = (q: string) => {
    window.clearTimeout(timerRef.current);
    if (q.trim().length < 2) { setResults([]); setOpen(false); return; }
    const myRequest = ++requestId.current;
    timerRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const r = await search(q.trim());
        if (requestId.current !== myRequest) return;
        setResults(r);
        const rect = inputRef.current?.getBoundingClientRect();
        if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
        setOpen(r.length > 0);
      } catch {
        if (requestId.current === myRequest) { setResults([]); setOpen(false); }
      } finally {
        if (requestId.current === myRequest) setLoading(false);
      }
    }, 400);
  };

  const pick = async (result: AutofillResult) => {
    setOpen(false);
    setResolving(true);
    try {
      const patch = await result.resolvePatch();
      onPick(patch);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="autofill-field">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); runSearch(e.target.value); }}
      />
      {(loading || resolving) && <span className="autofill-status">{resolving ? 'Filling in…' : 'Searching…'}</span>}
      {open && results.length > 0 && createPortal(
        <div className="autofill-dropdown" ref={popoverRef} style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}>
          {results.map((r, i) => (
            <button type="button" key={i} className="autofill-option" onClick={() => void pick(r)}>
              {r.cover ? <img src={r.cover} alt="" /> : <span className="autofill-option-noart" />}
              <span>{r.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
      {disabledReason && <small className="autofill-hint">{disabledReason}</small>}
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A bulk paste can burst past a provider's rate limit (IGDB caps at 4 req/sec) — without a
// retry, a rate-limited request looked identical to "this title doesn't exist" and silently
// became "No match found — skipped" instead of the transient failure it actually was. This
// gives each lookup a couple of extra chances with a short backoff before giving up for real.
async function searchWithRetry(
  search: (q: string) => Promise<AutofillResult[]>, q: string, attempts = 3
): Promise<AutofillResult[]> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await search(q);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

type BulkRowStatus = 'pending' | 'searching' | 'found' | 'not-found' | 'duplicate' | 'error';

interface BulkRow {
  query: string;
  status: BulkRowStatus;
  result?: AutofillResult;
  selected: boolean;
}

function BulkImportModal({
  noun, search, disabledReason, canReview, isDuplicate, onClose, onImport, onSendToReview
}: {
  noun: string;
  search: (q: string) => Promise<AutofillResult[]>;
  disabledReason?: string;
  canReview: boolean;
  isDuplicate: (title: string) => boolean;
  onClose: () => void;
  onImport: (patches: Record<string, unknown>[]) => Promise<void>;
  onSendToReview: (titles: string[]) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<BulkRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [sendingToReview, setSendingToReview] = useState(false);
  const [sentCount, setSentCount] = useState(0);

  const runSearch = async (only?: string[]) => {
    const queries = only ?? Array.from(new Set(text.split('\n').map(l => l.trim()).filter(Boolean)));
    if (!queries.length) return;
    setSearching(true);
    setSentCount(0);
    setRows(prev => {
      const fresh = queries.map(q => ({ query: q, status: 'pending' as const, selected: true }));
      if (!only) return fresh;
      // Retrying a subset (the "Retry failed" button) replaces just those rows in place,
      // leaving everything already found/skipped where it is.
      const others = prev.filter(r => !queries.includes(r.query));
      return [...others, ...fresh];
    });
    // Tracks resolved titles already accepted during this run — two differently-typed queries
    // (an abbreviation, an alternate spelling, a bundle listing) can both resolve to the same
    // real title. The pre-search check below only catches an exact match on the raw text the
    // user typed; it can't know two different-looking queries land on the same match until
    // after the search actually runs, so that has to be checked too, against both the
    // collection and every other row already resolved in this same batch.
    const acceptedTitles = new Set(
      rows.filter(r => r.status === 'found' && r.result).map(r => titleFromLabel(r.result!.label))
    );

    for (const q of queries) {
      if (isDuplicate(q)) {
        setRows(prev => prev.map(r => r.query === q ? { ...r, status: 'duplicate', selected: false } : r));
        continue;
      }
      setRows(prev => prev.map(r => r.query === q ? { ...r, status: 'searching' } : r));
      try {
        const results = await searchWithRetry(search, q);
        // Search relevance ranking isn't always the exact title (e.g. IGDB
        // ranking a spin-off like "Elden Ring Nightreign" above the base
        // "Elden Ring" for that query) — an exact title match anywhere in
        // the results is a stronger signal than "whatever came back first",
        // so prefer it when one exists before falling back to the top hit.
        const exactMatch = results.find(r => titleFromLabel(r.label) === normalizeMatchText(q));
        const best = exactMatch ?? results[0];
        const resolvedTitle = best ? titleFromLabel(best.label) : undefined;
        const alreadyHave = Boolean(resolvedTitle) && (isDuplicate(resolvedTitle!) || acceptedTitles.has(resolvedTitle!));
        if (best && alreadyHave) {
          setRows(prev => prev.map(r => r.query === q ? { ...r, status: 'duplicate', result: best, selected: false } : r));
        } else {
          if (resolvedTitle) acceptedTitles.add(resolvedTitle);
          setRows(prev => prev.map(r => r.query === q
            ? { ...r, status: best ? 'found' : 'not-found', result: best, selected: Boolean(best) }
            : r));
        }
      } catch {
        setRows(prev => prev.map(r => r.query === q ? { ...r, status: 'error', selected: false } : r));
      }
      // A big paste fires these sequentially but fast enough to burst past a provider's rate
      // limit (IGDB caps at 4 req/sec) — this keeps requests comfortably under that, on top of
      // the per-request retry above, so a large import doesn't need a manual re-paste to finish.
      await sleep(150);
    }
    setSearching(false);
  };

  const retryFailed = () => {
    const failed = rows.filter(r => r.status === 'error').map(r => r.query);
    if (failed.length) void runSearch(failed);
  };

  const toggleRow = (query: string) => {
    setRows(prev => prev.map(r => r.query === query ? { ...r, selected: !r.selected } : r));
  };

  const selectedCount = rows.filter(r => r.selected && r.result).length;
  // Anything not actually imported — no match, a failed lookup, or a match the user
  // unchecked — is still on your list to add by hand, so it stays trackable afterward.
  // Duplicates are excluded: they're already in the collection, so there's nothing to add.
  const leftoverCount = rows.filter(r => !(r.selected && r.result) && r.status !== 'duplicate').length;

  const runImport = async () => {
    setImporting(true);
    try {
      const patches: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (!row.selected || !row.result) continue;
        patches.push(await row.result.resolvePatch());
      }
      await onImport(patches);
      const remaining = rows.filter(r => !(r.selected && r.result) && r.status !== 'duplicate');
      setRows(remaining);
      if (!remaining.length) onClose();
    } finally {
      setImporting(false);
    }
  };

  const sendLeftoversToReview = async () => {
    setSendingToReview(true);
    try {
      const leftovers = rows.filter(r => !(r.selected && r.result) && r.status !== 'duplicate');
      await onSendToReview(leftovers.map(r => r.query));
      setSentCount(leftovers.length);
      setRows(rows.filter(r => r.selected && r.result));
    } finally {
      setSendingToReview(false);
    }
  };

  const hasResults = rows.length > 0;
  const failedCount = rows.filter(r => r.status === 'error').length;

  return (
    <Modal
      eyebrow="Life OS"
      title={`Bulk import ${noun.toLowerCase()}s`}
      onClose={onClose}
      footer={<>
        <button type="button" className="btn ghost" onClick={onClose}>{leftoverCount ? 'Close' : 'Cancel'}</button>
        {failedCount > 0 && !searching && (
          <button type="button" className="btn ghost" onClick={retryFailed}>
            Retry {failedCount} failed
          </button>
        )}
        {hasResults && leftoverCount > 0 && !searching && canReview && (
          <button type="button" className="btn ghost" disabled={sendingToReview} onClick={() => void sendLeftoversToReview()}>
            {sendingToReview ? 'Sending…' : `Send ${leftoverCount} to Needs Info`}
          </button>
        )}
        {hasResults && (
          <button type="button" className="btn teal" disabled={!selectedCount || importing} onClick={() => void runImport()}>
            {importing ? 'Importing…' : `Import ${selectedCount || ''} ${noun.toLowerCase()}${selectedCount === 1 ? '' : 's'}`}
          </button>
        )}
      </>}
    >
      {disabledReason ? (
        <p className="muted">{disabledReason}</p>
      ) : !hasResults ? (
        <div className="form-grid">
          {sentCount > 0 && (
            <p className="muted field-full">
              Sent {sentCount} to the "Needs Info" tab — find {sentCount === 1 ? 'it' : 'them'} there to add {sentCount === 1 ? 'it' : 'them'} individually.
            </p>
          )}
          <label className="field-full">
            <span>Paste titles — one per line</span>
            <textarea
              rows={8}
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={`The Matrix\nDune\nInception`}
            />
          </label>
          <button type="button" className="btn teal field-full" disabled={!text.trim() || searching} onClick={() => void runSearch()}>
            {searching ? 'Searching…' : 'Find matches'}
          </button>
        </div>
      ) : (
        <div className="bulk-import-list">
          {rows.map(row => (
            <label key={row.query} className={`bulk-import-row ${!row.result ? 'unmatched' : ''}`}>
              <input
                type="checkbox"
                checked={row.selected}
                disabled={!row.result}
                onChange={() => toggleRow(row.query)}
              />
              {row.result?.cover ? <img src={row.result.cover} alt="" /> : <span className="bulk-import-noart" />}
              <span className="bulk-import-text">
                <b>{row.query}</b>
                <small>
                  {row.status === 'searching' && 'Searching…'}
                  {row.status === 'pending' && 'Waiting…'}
                  {row.status === 'found' && row.result?.label}
                  {row.status === 'not-found' && 'No match found — skipped'}
                  {row.status === 'duplicate' && 'Already in your list — skipped'}
                  {row.status === 'error' && 'Lookup failed — skipped'}
                </small>
              </span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

function DuplicateCleanupModal<T extends CollectionRecord>({
  groups, coverKey, renderTitle, renderSubtitle, onClose, onRemove
}: {
  groups: T[][];
  coverKey?: keyof T & string;
  renderTitle: (r: T) => string;
  renderSubtitle?: (r: T) => string;
  onClose: () => void;
  onRemove: (ids: string[]) => Promise<void>;
}) {
  // Defaults to keeping the oldest record in each group — "this one was here first" is the
  // least surprising default — but any copy can be picked instead before removing the rest.
  const [keepIds, setKeepIds] = useState<string[]>(() =>
    groups.map(g => [...g].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].id)
  );
  const [removing, setRemoving] = useState(false);

  const toRemove = groups.flatMap((g, i) => g.filter(r => r.id !== keepIds[i]).map(r => r.id));

  const runRemove = async () => {
    setRemoving(true);
    try {
      await onRemove(toRemove);
      onClose();
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Modal
      eyebrow="Life OS"
      title="Find duplicates"
      onClose={onClose}
      footer={<>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn teal" disabled={!toRemove.length || removing} onClick={() => void runRemove()}>
          {removing ? 'Removing…' : `Remove ${toRemove.length} duplicate${toRemove.length === 1 ? '' : 's'}`}
        </button>
      </>}
    >
      <p className="muted">
        Pick which copy to keep in each group — the rest get removed (undo with Ctrl+Z if you change your mind).
      </p>
      <div className="dup-groups">
        {groups.map((group, gi) => (
          <div className="dup-group" key={group.map(r => r.id).join('-')}>
            <h4>{renderTitle(group[0])}</h4>
            <div className="dup-group-options">
              {group.map(r => (
                <label key={r.id} className={`dup-option ${keepIds[gi] === r.id ? 'keep' : ''}`}>
                  <input
                    type="radio"
                    name={`dup-group-${gi}`}
                    checked={keepIds[gi] === r.id}
                    onChange={() => setKeepIds(prev => prev.map((k, i) => i === gi ? r.id : k))}
                  />
                  {coverKey && (r[coverKey] as unknown as string | undefined) ? (
                    <img src={r[coverKey] as unknown as string} alt="" />
                  ) : <span className="dup-option-noart" />}
                  <span className="dup-option-meta">
                    {renderSubtitle && <small>{renderSubtitle(r)}</small>}
                    <small className="dup-option-date">Added {formatDate(r.createdAt)}</small>
                  </span>
                  {keepIds[gi] === r.id && <Check size={14} className="dup-option-check" />}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function GenreDropdown({
  label, options, value, onChange
}: {
  label: string;
  options: string[];
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  if (!options.length) return null;

  return (
    <div className="genre-filter" ref={wrapRef}>
      <button type="button" className={`genre-filter-trigger ${value ? 'active' : ''}`} onClick={() => setOpen(o => !o)}>
        {value ?? label}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="genre-filter-dropdown">
          <button type="button" className={!value ? 'on' : ''} onClick={() => { onChange(null); setOpen(false); }}>All Genres</button>
          {options.map(opt => (
            <button type="button" key={opt} className={value === opt ? 'on' : ''} onClick={() => { onChange(opt); setOpen(false); }}>{opt}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CollectionPage<T extends CollectionRecord>({
  collection, title, subtitle, itemLabel, fields, defaults, renderTitle, renderSubtitle, sortBy, gallery, statusFilter, genreFilter, autofill, leading, table, embedded, onFieldChange, needsReviewKey, headerExtra, dateSortKey, dateSortLabel
}: CollectionPageProps<T>) {
  const { data, upsert: rawUpsert, remove } = useStore();
  // upsert is typed per-collection at the call site (K extends CollectionName); this generic page
  // works across every collection, so the boundary here is intentionally loosened once.
  const upsert = rawUpsert as unknown as (collection: CollectionName, record: CollectionRecord) => Promise<void>;
  const allRecordsRaw = ((data[collection] as unknown) as T[]).slice().sort(sortBy);
  // Needs-review placeholders (bulk-import misses, title only) are held out of the normal
  // grid/list — they'd look broken there — and surfaced only in their own tab.
  const reviewRecords = needsReviewKey ? allRecordsRaw.filter(r => Boolean(r[needsReviewKey])) : [];
  const allRecords = needsReviewKey ? allRecordsRaw.filter(r => !r[needsReviewKey]) : allRecordsRaw;

  // Groups of 2+ real (non-review) records sharing a normalized title — leftover from a bug
  // where bulk import checked only the raw text you typed against the collection, not the
  // actual resolved match, so an abbreviation/alternate spelling could slip a real duplicate
  // past the old check. Surfaced so they can be reviewed and merged rather than auto-deleted.
  const duplicateGroups = useMemo(() => {
    if (!autofill) return [] as T[][];
    const groups = new Map<string, T[]>();
    for (const r of allRecords) {
      const norm = String(r[autofill.titleKey] ?? '').trim().toLowerCase();
      if (!norm) continue;
      const list = groups.get(norm) ?? [];
      list.push(r);
      groups.set(norm, list);
    }
    return Array.from(groups.values()).filter(g => g.length > 1);
  }, [allRecords, autofill]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<T>>({});
  const [showForm, setShowForm] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [view, setView] = useState<'gallery' | 'list' | 'review'>(gallery ? 'gallery' : 'list');
  const [statusTab, setStatusTab] = useState('All');
  const [genreTab, setGenreTab] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const closeSearch = () => { setSearchOpen(false); setSearchQuery(''); };

  const genreOptions = useMemo(() => {
    if (!genreFilter) return [];
    const set = new Set<string>();
    for (const r of allRecords) {
      const value = r[genreFilter.key] as unknown as string[] | undefined;
      for (const g of value ?? []) if (g) set.add(g);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allRecords, genreFilter]);

  const records = useMemo(() => {
    let list = allRecords;
    if (statusFilter && statusTab !== 'All') {
      const group = statusFilter.groups.find(g => g.label === statusTab);
      if (group) list = list.filter(r => group.values.includes(String(r[statusFilter.key] ?? '')));
    } else if (statusFilter && statusTab === 'All' && statusFilter.allExcludesGrouped) {
      const grouped = new Set(statusFilter.groups.flatMap(g => g.values));
      list = list.filter(r => !grouped.has(String(r[statusFilter.key] ?? '')));
    }
    if (genreFilter && genreTab) {
      list = list.filter(r => ((r[genreFilter.key] as unknown as string[] | undefined) ?? []).includes(genreTab));
    }
    const term = searchQuery.trim().toLowerCase();
    if (term) list = list.filter(r => renderTitle(r).toLowerCase().includes(term));
    return list;
  }, [allRecords, statusFilter, statusTab, genreFilter, genreTab, searchQuery, renderTitle]);

  // A-Z/Z-A and Oldest/Newest each override the default order; a third click of either
  // returns to it. Shuffle is a one-shot randomization re-rolled on every click (shuffleTick
  // forces the memo to recompute even though the mode itself doesn't change).
  const [orderMode, setOrderMode] = useState<'default' | 'az' | 'za' | 'oldest' | 'newest' | 'shuffle'>('default');
  const [shuffleTick, setShuffleTick] = useState(0);
  const [randomPick, setRandomPick] = useState<T | null>(null);
  const [infoRecord, setInfoRecord] = useState<T | null>(null);
  // Rich-text fields (e.g. Notes / Review) start collapsed in the read-only info view — they
  // tend to be the longest field on the record, so hiding them by default keeps the modal
  // scannable, with a toggle to expand when you actually want to read them.
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  useEffect(() => { setExpandedFields(new Set()); }, [infoRecord, randomPick]);
  const toggleField = (key: string) => setExpandedFields(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const orderedRecords = useMemo(() => {
    if (orderMode === 'az' || orderMode === 'za') {
      const sorted = records.slice().sort((a, b) => renderTitle(a).localeCompare(renderTitle(b)));
      if (orderMode === 'za') sorted.reverse();
      return sorted;
    }
    if (orderMode === 'oldest' || orderMode === 'newest') {
      const dateOf = (r: T): string | undefined => dateSortKey ? (r[dateSortKey] as unknown as string | undefined) : r.createdAt;
      const dated = records.filter(r => dateOf(r));
      const undated = records.filter(r => !dateOf(r));
      dated.sort((a, b) => dateOf(a)!.localeCompare(dateOf(b)!));
      if (orderMode === 'newest') dated.reverse();
      // Undated records always land at the end, in either direction — there's no "oldest" or
      // "newest" reading of a missing date, so there's nothing meaningful to reverse for them.
      return [...dated, ...undated];
    }
    if (orderMode === 'shuffle') {
      const arr = records.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    return records;
    // shuffleTick intentionally triggers a re-shuffle without changing orderMode itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, orderMode, shuffleTick, dateSortKey]);

  const cycleAlphaSort = () => setOrderMode(prev => (prev === 'az' ? 'za' : prev === 'za' ? 'default' : 'az'));
  const cycleDateSort = () => setOrderMode(prev => (prev === 'oldest' ? 'newest' : prev === 'newest' ? 'default' : 'oldest'));
  const shuffleNow = () => { setOrderMode('shuffle'); setShuffleTick(t => t + 1); };
  const pickRandom = () => { if (records.length) setRandomPick(records[Math.floor(Math.random() * records.length)]); };

  const startAdd = () => { setForm({ ...defaults } as Partial<T>); setEditingId(null); setDuplicateError(null); setShowForm(true); };
  const startEdit = (record: T) => { setForm({ ...record }); setEditingId(record.id); setDuplicateError(null); setShowForm(true); };
  const cancel = () => { setShowForm(false); setEditingId(null); setForm({}); setDuplicateError(null); };

  // Same title (case/whitespace-insensitive) already in this collection — only checked when
  // there's a clear title field to compare (autofill.titleKey), which is every current caller.
  //
  // includeNeedsReview defaults to true (manual add/edit still treats a review placeholder as
  // a real duplicate — you shouldn't end up with two rows for the same title). Bulk import
  // passes false: a needs-review placeholder is title-only, waiting for exactly the data a
  // successful match provides, so it must not block re-importing that same title.
  const duplicateOf = (candidateTitle: string, excludeId?: string, opts?: { includeNeedsReview?: boolean }): T | undefined => {
    if (!autofill) return undefined;
    const norm = candidateTitle.trim().toLowerCase();
    if (!norm) return undefined;
    const includeNeedsReview = opts?.includeNeedsReview ?? true;
    return allRecordsRaw.find(r => {
      if (r.id === excludeId) return false;
      if (!includeNeedsReview && needsReviewKey && r[needsReviewKey]) return false;
      return String(r[autofill.titleKey] ?? '').trim().toLowerCase() === norm;
    });
  };

  const save = async () => {
    if (autofill) {
      const dup = duplicateOf(String(form[autofill.titleKey] ?? ''), editingId ?? undefined);
      if (dup) { setDuplicateError(`"${renderTitle(dup)}" is already in your list.`); return; }
    }
    // Editing addresses a needs-review placeholder either way, so always clear the flag on save.
    const clearReview = needsReviewKey ? { [needsReviewKey]: false } as Partial<T> : {};
    if (editingId) {
      const base = allRecordsRaw.find(r => r.id === editingId);
      if (!base) return cancel();
      await upsert(collection, { ...base, ...form, ...clearReview } as CollectionRecord);
    } else {
      const record = newRecord<T>({ ...form, ...clearReview });
      await upsert(collection, record as CollectionRecord);
    }
    cancel();
  };

  const importBulk = async (patches: Record<string, unknown>[]) => {
    for (const patch of patches) {
      // A title that already exists only as an unresolved review placeholder gets resolved
      // in place — the placeholder is what this exact import is meant to fill in, so it should
      // become the real record rather than sit orphaned next to a brand-new one.
      const title = autofill ? String(patch[autofill.titleKey] ?? '') : '';
      const placeholder = title ? duplicateOf(title) : undefined;
      if (placeholder && needsReviewKey && placeholder[needsReviewKey]) {
        const clearReview = { [needsReviewKey]: false } as Partial<T>;
        await upsert(collection, { ...placeholder, ...patch, ...clearReview } as CollectionRecord);
      } else {
        const record = newRecord<T>({ ...defaults, ...patch } as Partial<T>);
        await upsert(collection, record as CollectionRecord);
      }
    }
  };

  const sendToReview = async (titles: string[]) => {
    if (!autofill || !needsReviewKey) return;
    for (const t of titles) {
      const record = newRecord<T>({ ...defaults, [autofill.titleKey]: t, [needsReviewKey]: true } as Partial<T>);
      await upsert(collection, record as CollectionRecord);
    }
  };

  const deleteAll = async () => {
    setDeletingAll(true);
    try {
      for (const record of reviewRecords) await remove(collection, record.id);
      setShowDeleteAllConfirm(false);
    } finally {
      setDeletingAll(false);
    }
  };

  const setField = (key: string, value: unknown) => {
    if (duplicateError && autofill && key === autofill.titleKey) setDuplicateError(null);
    setForm(prev => {
      const next = { ...prev, [key]: value };
      const patch = onFieldChange?.(key, value, next);
      return patch ? { ...next, ...patch } : next;
    });
  };

  const noun = itemLabel ?? title;

  const visibleCount = view === 'review' ? reviewRecords.length : orderedRecords.length;

  const toolbar = (statusFilter || genreFilter || gallery) ? (
    <div className="collection-toolbar">
      <div className="toolbar-filters">
        {searchOpen ? (
          <div className="toolbar-search">
            <Search size={14} />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={`Search ${noun.toLowerCase()}s…`}
              onKeyDown={e => { if (e.key === 'Escape') closeSearch(); }}
            />
            <button type="button" className="icon-btn" onClick={closeSearch} aria-label="Close search"><X size={14} /></button>
          </div>
        ) : (
          <button type="button" className="icon-btn" onClick={() => { setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 0); }} aria-label="Search">
            <Search size={15} />
          </button>
        )}
        {statusFilter && (
          <div className="segmented">
            <button type="button" className={statusTab === 'All' ? 'on' : ''} onClick={() => setStatusTab('All')}>All</button>
            {statusFilter.groups.map(g => (
              <button type="button" key={g.label} className={statusTab === g.label ? 'on' : ''} onClick={() => setStatusTab(g.label)}>{g.label}</button>
            ))}
          </div>
        )}
        {genreFilter && (
          <GenreDropdown label={genreFilter.label ?? 'Genre'} options={genreOptions} value={genreTab} onChange={setGenreTab} />
        )}
        <span className="toolbar-count">{visibleCount} {noun.toLowerCase()}{visibleCount === 1 ? '' : 's'}</span>
      </div>
      {gallery && (
        <div className="toolbar-actions">
          {view === 'review' && reviewRecords.length > 0 && (
            <button type="button" className="icon-btn danger" onClick={() => setShowDeleteAllConfirm(true)} aria-label="Delete all needs-info items" title="Delete all">
              <Trash2 size={15} />
            </button>
          )}
          <div className="view-toggle-btns">
            <button
              type="button"
              className={orderMode === 'az' || orderMode === 'za' ? 'on' : ''}
              onClick={cycleAlphaSort}
              aria-label={orderMode === 'za' ? 'Sorted Z to A — click to reset' : orderMode === 'az' ? 'Sorted A to Z — click to reverse' : 'Sort A to Z'}
              title={orderMode === 'za' ? 'Sorted Z to A' : orderMode === 'az' ? 'Sorted A to Z' : 'Sort alphabetically'}
            >
              {orderMode === 'za' ? <ArrowUpZA size={15} /> : <ArrowDownAZ size={15} />}
            </button>
            <button
              type="button"
              className={orderMode === 'oldest' || orderMode === 'newest' ? 'on' : ''}
              onClick={cycleDateSort}
              aria-label={orderMode === 'newest' ? 'Sorted Newest to Oldest — click to reset' : orderMode === 'oldest' ? 'Sorted Oldest to Newest — click to reverse' : 'Sort Oldest to Newest'}
              title={orderMode === 'newest' ? `Sorted Newest to Oldest (${dateSortLabel ?? 'date added'})` : orderMode === 'oldest' ? `Sorted Oldest to Newest (${dateSortLabel ?? 'date added'})` : `Sort by ${dateSortLabel ?? 'date added'}`}
            >
              {orderMode === 'newest' ? <ArrowUp01 size={15} /> : <ArrowDown01 size={15} />}
            </button>
            <button type="button" className={orderMode === 'shuffle' ? 'on' : ''} onClick={shuffleNow} aria-label="Shuffle order" title="Shuffle">
              <Shuffle size={15} />
            </button>
            <button type="button" onClick={pickRandom} aria-label="Pick a random item" title="Surprise me">
              <Dices size={15} />
            </button>
          </div>
          <div className="view-toggle-btns">
            <button type="button" className={view === 'gallery' ? 'on' : ''} onClick={() => setView('gallery')} aria-label="Gallery view"><LayoutGrid size={15} /></button>
            <button type="button" className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="List view"><ListIcon size={15} /></button>
            {needsReviewKey && (
              <button type="button" className={view === 'review' ? 'on' : ''} onClick={() => setView('review')} aria-label="Needs info">
                <ListTodo size={15} />
                {reviewRecords.length > 0 && <span className="view-toggle-badge">{reviewRecords.length}</span>}
              </button>
            )}
            {duplicateGroups.length > 0 && (
              <button type="button" onClick={() => setShowDuplicates(true)} aria-label="Find duplicates" title="Find duplicates">
                <Copy size={15} />
                <span className="view-toggle-badge">{duplicateGroups.length}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  ) : null;

  const content = view === 'review' ? (
    reviewRecords.length ? (
      <div className="record-list">
        {reviewRecords.map(record => (
          <div className="record-row" key={record.id}>
            <div onClick={() => startEdit(record)}>
              <span>
                <b>{renderTitle(record)}</b>
              </span>
            </div>
            <div className="record-actions">
              <button className="icon-btn" onClick={() => startEdit(record)} aria-label="Edit"><Pencil size={15} /></button>
              <button className="icon-btn danger" onClick={() => void remove(collection, record.id)} aria-label="Delete"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    ) : <EmptyState>Nothing needs info right now.</EmptyState>
  ) : orderedRecords.length ? (
    gallery && view === 'gallery' ? (
      <div className="gallery-grid">
        {orderedRecords.map(record => {
          const cover = record[gallery.coverKey] as unknown as string | undefined;
          const badge = gallery.badge?.(record);
          const rating = gallery.rating?.(record);
          const meta = gallery.meta?.(record);
          const label = renderTitle(record);
          return (
            <div className="gallery-card" key={record.id}>
              <div className="gallery-cover-wrap">
                <button
                  type="button"
                  className="gallery-cover"
                  style={cover ? { backgroundImage: `url(${cover})` } : { background: gallery.coverAccent }}
                  onClick={() => setInfoRecord(record)}
                  aria-label={`Info about ${label}`}
                >
                  {!cover && <span className="gallery-cover-fallback">{label}</span>}
                </button>
                <span className="gallery-cover-scrim" aria-hidden="true" />
                {badge && <span className="gallery-badge">{badge}</span>}
                {rating != null && <span className="gallery-rating">{renderStars(rating)}</span>}
                <button type="button" className="icon-btn gallery-delete" onClick={() => void remove(collection, record.id)} aria-label={`Delete ${label}`}>
                  <Trash2 size={13} />
                </button>
                <button type="button" className="icon-btn gallery-info" onClick={e => { e.stopPropagation(); startEdit(record); }} aria-label={`Edit ${label}`} title="Edit">
                  <Pencil size={13} />
                </button>
              </div>
              <div className="gallery-meta">
                <b>{label}</b>
                {meta && <span>{meta}</span>}
              </div>
            </div>
          );
        })}
      </div>
    ) : table ? (
      <div className="collection-table-wrap">
        <table className="mini-table collection-table">
          <thead>
            <tr>
              {leading && <th></th>}
              {table.columns.map(c => <th key={c.key} style={{ textAlign: c.align ?? 'left' }}>{c.label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orderedRecords.map(record => (
              <tr className="collection-table-row" key={record.id} onClick={() => startEdit(record)}>
                {leading && <td className="collection-table-leading">{leading(record)}</td>}
                {table.columns.map(c => <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>{c.render(record)}</td>)}
                <td className="collection-table-actions" onClick={e => e.stopPropagation()}>
                  <button className="icon-btn" onClick={() => startEdit(record)} aria-label={`Edit ${renderTitle(record)}`}><Pencil size={13} /></button>
                  <button className="icon-btn danger" onClick={() => void remove(collection, record.id)} aria-label={`Delete ${renderTitle(record)}`}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="record-list">
        {orderedRecords.map(record => (
          <div className="record-row" key={record.id}>
            <div className={leading ? 'record-row-main' : ''} onClick={() => startEdit(record)}>
              {leading && <span className="record-row-leading">{leading(record)}</span>}
              <span>
                <b>{renderTitle(record)}</b>
                {renderSubtitle && <small>{renderSubtitle(record)}</small>}
              </span>
            </div>
            <div className="record-actions">
              <button className="icon-btn" onClick={() => startEdit(record)} aria-label="Edit"><Pencil size={15} /></button>
              <button className="icon-btn danger" onClick={() => void remove(collection, record.id)} aria-label="Delete"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
    )
  ) : <EmptyState>Nothing here yet. Add your first entry.</EmptyState>;

  return (
    <>
      {!embedded && (
        <PageHeader title={title} subtitle={subtitle} action={
          !showForm && !showBulkImport ? (
            <div className="bucket-header-actions">
              {headerExtra}
              {autofill && (
                <button type="button" className="btn ghost" onClick={() => setShowBulkImport(true)}><Upload size={16} /> Bulk import</button>
              )}
              <button className="btn primary" onClick={startAdd}><Plus size={16} /> Add</button>
            </div>
          ) : undefined
        } />
      )}
      {showDeleteAllConfirm && (
        <Modal
          eyebrow="Life OS"
          title={`Delete all needs-info ${noun.toLowerCase()}s?`}
          onClose={() => setShowDeleteAllConfirm(false)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setShowDeleteAllConfirm(false)}>Cancel</button>
            <button type="button" className="btn danger" disabled={deletingAll} onClick={() => void deleteAll()}>
              {deletingAll ? 'Deleting…' : `Delete all ${reviewRecords.length}`}
            </button>
          </>}
        >
          <p className="muted">
            This permanently deletes all {reviewRecords.length} placeholder {noun.toLowerCase()}{reviewRecords.length === 1 ? '' : 's'} waiting for info. This can't be undone.
          </p>
        </Modal>
      )}
      {showBulkImport && autofill && (
        <BulkImportModal
          noun={noun}
          search={autofill.search}
          disabledReason={autofill.disabledReason}
          canReview={Boolean(needsReviewKey)}
          isDuplicate={t => Boolean(duplicateOf(t, undefined, { includeNeedsReview: false }))}
          onClose={() => setShowBulkImport(false)}
          onImport={importBulk}
          onSendToReview={sendToReview}
        />
      )}
      {showDuplicates && duplicateGroups.length > 0 && (
        <DuplicateCleanupModal<T>
          groups={duplicateGroups}
          coverKey={gallery?.coverKey}
          renderTitle={renderTitle}
          renderSubtitle={renderSubtitle}
          onClose={() => setShowDuplicates(false)}
          onRemove={async ids => { for (const id of ids) await remove(collection, id); }}
        />
      )}
      {infoRecord && (
        <Modal
          eyebrow="Life OS"
          title={renderTitle(infoRecord)}
          onClose={() => setInfoRecord(null)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setInfoRecord(null)}>Close</button>
            <button type="button" className="btn teal" onClick={() => { const r = infoRecord; setInfoRecord(null); startEdit(r); }}>Edit</button>
          </>}
        >
          <div className="random-pick">
            <div className="random-pick-sticky">
              {gallery && (
                <div
                  className="random-pick-cover"
                  style={(infoRecord[gallery.coverKey] as unknown as string | undefined)
                    ? { backgroundImage: `url(${infoRecord[gallery.coverKey] as unknown as string})` }
                    : { background: gallery.coverAccent }}
                >
                  {!(infoRecord[gallery.coverKey] as unknown as string | undefined) && (
                    <span className="gallery-cover-fallback">{renderTitle(infoRecord)}</span>
                  )}
                </div>
              )}
              <div className="random-pick-heading">
                <b>{renderTitle(infoRecord)}</b>
                {renderSubtitle && <small>{renderSubtitle(infoRecord)}</small>}
              </div>
            </div>
            <dl className="info-fields">
              {fields
                .filter(f => f.type !== 'image' && f.type !== 'richtext' && (!autofill || f.key !== autofill.titleKey))
                .map(f => {
                  if (f.type === 'textarea') {
                    const text = (infoRecord[f.key] as string) ?? '';
                    if (!text.trim()) return null;
                    return (
                      <div className="info-field field-full" key={f.key}>
                        <dt>{f.label}</dt>
                        <dd className="info-field-paragraph">{text}</dd>
                      </div>
                    );
                  }
                  const display = formatFieldValue(infoRecord[f.key]);
                  if (!display) return null;
                  return (
                    <div className="info-field" key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{display}</dd>
                    </div>
                  );
                })}
            </dl>
            {fields.filter(f => f.type === 'richtext').map(f => {
              const html = (infoRecord[f.key] as string) ?? '';
              if (isEmptyHtml(html)) return null;
              const open = expandedFields.has(f.key);
              return (
                <div className="info-collapsible" key={f.key}>
                  <button type="button" className="btn ghost small" onClick={() => toggleField(f.key)}>
                    {open ? <EyeOff size={13} /> : <Eye size={13} />} {open ? `Hide ${f.label}` : `Show ${f.label}`}
                  </button>
                  {open && <div className="rte-display info-collapsible-content" dangerouslySetInnerHTML={{ __html: html }} />}
                </div>
              );
            })}
          </div>
        </Modal>
      )}
      {randomPick && (
        <Modal
          eyebrow="Life OS"
          title={`Random ${noun.toLowerCase()}`}
          onClose={() => setRandomPick(null)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setRandomPick(null)}>Close</button>
            <button type="button" className="btn ghost" onClick={pickRandom}><Dices size={14} /> Pick again</button>
            <button type="button" className="btn teal" onClick={() => { const r = randomPick; setRandomPick(null); startEdit(r); }}>Open</button>
          </>}
        >
          <div className="random-pick">
            <div className="random-pick-sticky">
              {gallery && (
                <div
                  className="random-pick-cover"
                  style={(randomPick[gallery.coverKey] as unknown as string | undefined)
                    ? { backgroundImage: `url(${randomPick[gallery.coverKey] as unknown as string})` }
                    : { background: gallery.coverAccent }}
                >
                  {!(randomPick[gallery.coverKey] as unknown as string | undefined) && (
                    <span className="gallery-cover-fallback">{renderTitle(randomPick)}</span>
                  )}
                </div>
              )}
              <div className="random-pick-heading">
                <b>{renderTitle(randomPick)}</b>
                {renderSubtitle && <small>{renderSubtitle(randomPick)}</small>}
              </div>
            </div>
            <dl className="info-fields">
              {fields
                .filter(f => f.type !== 'image' && f.type !== 'richtext' && (!autofill || f.key !== autofill.titleKey))
                .map(f => {
                  if (f.type === 'textarea') {
                    const text = (randomPick[f.key] as string) ?? '';
                    if (!text.trim()) return null;
                    return (
                      <div className="info-field field-full" key={f.key}>
                        <dt>{f.label}</dt>
                        <dd className="info-field-paragraph">{text}</dd>
                      </div>
                    );
                  }
                  const display = formatFieldValue(randomPick[f.key]);
                  if (!display) return null;
                  return (
                    <div className="info-field" key={f.key}>
                      <dt>{f.label}</dt>
                      <dd>{display}</dd>
                    </div>
                  );
                })}
            </dl>
            {fields.filter(f => f.type === 'richtext').map(f => {
              const html = (randomPick[f.key] as string) ?? '';
              if (isEmptyHtml(html)) return null;
              const open = expandedFields.has(f.key);
              return (
                <div className="info-collapsible" key={f.key}>
                  <button type="button" className="btn ghost small" onClick={() => toggleField(f.key)}>
                    {open ? <EyeOff size={13} /> : <Eye size={13} />} {open ? `Hide ${f.label}` : `Show ${f.label}`}
                  </button>
                  {open && <div className="rte-display info-collapsible-content" dangerouslySetInnerHTML={{ __html: html }} />}
                </div>
              );
            })}
          </div>
        </Modal>
      )}
      {showForm && (
        <Modal
          eyebrow="Life OS"
          title={editingId ? `Edit ${noun}` : `New ${noun}`}
          onClose={cancel}
          footer={<>
            <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void save()}>Save</button>
          </>}
        >
          <div className="form-grid">
            {duplicateError && <p className="form-error field-full">{duplicateError}</p>}
            {fields.map(field => (
              <label key={field.key} className={field.type === 'textarea' || field.type === 'richtext' ? 'field-full' : ''}>
                <span>{field.label}</span>
                {autofill && field.key === autofill.titleKey ? (
                  <TitleAutofillField
                    value={(form[field.key] as string) ?? ''}
                    onChange={v => setField(field.key, v)}
                    onPick={patch => { setDuplicateError(null); setForm(prev => ({ ...prev, ...patch })); }}
                    search={autofill.search}
                    placeholder={field.placeholder}
                    disabledReason={autofill.disabledReason}
                  />
                ) : field.type === 'richtext' ? (
                  <RichTextEditor
                    value={(form[field.key] as string) ?? ''}
                    onChange={v => setField(field.key, v)}
                    placeholder={field.placeholder}
                  />
                ) : field.type === 'textarea' ? (
                  <textarea
                    value={(form[field.key] as string) ?? ''}
                    onChange={e => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                  />
                ) : field.type === 'select' ? (
                  <select value={(form[field.key] as string) ?? ''} onChange={e => setField(field.key, e.target.value)}>
                    <option value="" disabled>Select…</option>
                    {field.options?.map(opt => <option key={optValue(opt)} value={optValue(opt)}>{optLabel(opt)}</option>)}
                  </select>
                ) : field.type === 'color' ? (
                  <input
                    type="color"
                    className="color-field"
                    value={(form[field.key] as string) || '#4f5bd5'}
                    onChange={e => setField(field.key, e.target.value)}
                  />
                ) : field.type === 'checkbox' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(form[field.key])}
                    onChange={e => setField(field.key, e.target.checked)}
                  />
                ) : field.type === 'number' ? (
                  <input
                    type="number"
                    value={form[field.key] === undefined ? '' : (form[field.key] as number)}
                    onChange={e => setField(field.key, e.target.value === '' ? undefined : Number(e.target.value))}
                    placeholder={field.placeholder}
                  />
                ) : field.type === 'date' ? (
                  <DatePicker
                    value={(form[field.key] as string) ?? ''}
                    onChange={v => setField(field.key, v)}
                    placeholder={field.placeholder}
                  />
                ) : field.type === 'tags' ? (
                  <TagsInput
                    value={(form[field.key] as string[] | undefined) ?? []}
                    onChange={v => setField(field.key, v)}
                    placeholder={field.placeholder}
                  />
                ) : field.type === 'multiselect' ? (
                  <MultiSelectField
                    value={(form[field.key] as string[] | undefined) ?? []}
                    onChange={v => setField(field.key, v)}
                    options={field.options ?? []}
                    placeholder={field.placeholder}
                  />
                ) : field.type === 'image' ? (
                  <div className="image-field">
                    <input
                      type="text"
                      value={(form[field.key] as string) ?? ''}
                      onChange={e => setField(field.key, e.target.value)}
                      placeholder={field.placeholder ?? 'https://…'}
                    />
                    {Boolean(form[field.key]) && <img className="image-field-preview" src={form[field.key] as string} alt="" />}
                  </div>
                ) : (
                  <input
                    type={field.type}
                    value={(form[field.key] as string) ?? ''}
                    onChange={e => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                  />
                )}
              </label>
            ))}
          </div>
        </Modal>
      )}
      {embedded ? (
        <Card>
          <div className="card-title">
            <div><h2>{title}</h2></div>
            {!showForm && <button type="button" className="btn ghost small" onClick={startAdd}><Plus size={14} /> Add</button>}
          </div>
          {toolbar}
          {content}
        </Card>
      ) : (
        <>
          {toolbar}
          <Card>{content}</Card>
        </>
      )}
    </>
  );
}
