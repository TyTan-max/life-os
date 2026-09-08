import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  Archive, ArchiveRestore, BookMarked, Check, ChevronLeft, Clock, Code2, Command,
  Layers, Lightbulb, Link2, Pin, PinOff, Plus, Search, StickyNote, Trash2, TrendingUp, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { BookNoteRow, BookStatus, Frequency, Goal, GoalHorizon, GoalProgressMode, GoalStatus, Note, NoteImage, ParaProjectStatus, ParaType, Priority, ProjectBoardColumn, ProjectSubtask, ResourceKind, ReviewCadence, Task, TaskStatus } from '../types';
import { generateId } from '../utils/id';
import { Badge, Card, EmptyState, Kpi, Modal, PageHeader, formatDate } from '../components/UI';
import { SortableTh, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor } from '../components/RichTextEditor';
import type { RichTextEditorHandle } from '../components/RichTextEditor';
import { useIsMobile, useIsMobileLandscape } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';
import { SwipeRow } from '../components/SwipeRow';
import { MobileRecordList } from '../components/MobileRecordList';
import { VaultOnboarding } from '../components/VaultOnboarding';

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

const PROJECT_STATUSES: ParaProjectStatus[] = ['Not Started', 'In Progress', 'Blocked', 'Completed'];
// A subtask board's default columns, used until a Project defines its own — same labels/ids as
// the fixed project-level lifecycle so a project's very first custom edit (rename/add/remove)
// starts from familiar ground, and any subtask created before that edit keeps resolving correctly.
const DEFAULT_BOARD_COLUMNS: ProjectBoardColumn[] = PROJECT_STATUSES.map(s => ({ id: s, label: s }));
function projectColumns(note: Note): ProjectBoardColumn[] {
  return note.boardColumns && note.boardColumns.length ? note.boardColumns : DEFAULT_BOARD_COLUMNS;
}
const REVIEW_CADENCES: ReviewCadence[] = ['Weekly', 'Monthly', 'Quarterly'];
const RESOURCE_KINDS: ResourceKind[] = ['Idea', 'Snippet', 'Reference'];
const BOOK_STATUSES: BookStatus[] = ['Reading', 'Completed', 'Wishlist'];
// A distinct icon per Kind so the Resources hub reads at a glance instead of three identical
// bookmark icons — Idea gets the obvious lightbulb, Snippet a sticky-note (it's a plain quick
// note now, not code — Code Vault owns the code-editor treatment), Reference keeps the bookmark
// since "saved for later" is exactly what that icon already means everywhere else in the app.
const RESOURCE_KIND_ICONS: Record<ResourceKind, typeof Lightbulb> = {
  Idea: Lightbulb,
  Snippet: StickyNote,
  Reference: BookMarked,
  Repo: Code2,
  'Book Note': BookMarked,
  Article: BookMarked
};
const REVIEW_CADENCE_DAYS: Record<ReviewCadence, number> = { Weekly: 7, Monthly: 30, Quarterly: 90 };

// Starting scaffolds for new Project/Area notes — Resources deliberately stay blank
// since their shape varies too much (article vs. snippet vs. idea) for one template.
const PARA_TEMPLATES: Partial<Record<ParaType, string>> = {
  Project: '<h2>Goal</h2><p></p><h2>Next action</h2><p></p><h2>Notes</h2><p></p>',
  Area: '<h2>Standard — what does &quot;good&quot; look like here?</h2><p></p><h2>Resources</h2><p></p>'
};

// Resources isn't a tab of its own — it lives as a card grid on the Overview tab instead (see
// the Overview branch below), since Projects/Areas/Resources/Inbox all having both a dedicated
// tab AND a jump-in card was redundant navigation to the same place.
export type ParaTab = 'Overview' | 'All' | 'Tasks' | 'Inbox' | 'Goals' | 'Projects' | 'Areas' | 'Archive' | 'Books';
const PARA_TABS: ParaTab[] = ['Overview', 'All', 'Inbox', 'Tasks', 'Goals', 'Projects', 'Areas', 'Archive', 'Books'];
// A tab's implied paraType, for defaulting new notes created while it's active.
const TAB_PARA_TYPE: Partial<Record<ParaTab, ParaType>> = { Projects: 'Project', Areas: 'Area' };

const TASK_STATUSES: TaskStatus[] = ['Not Started', 'In Progress', 'Completed'];
const TASK_PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Urgent'];
const TASK_FREQUENCIES: Frequency[] = ['Daily', 'Weekly', 'Monthly', 'Yearly'];
type TaskFilter = 'Open' | 'Completed' | 'All';

function blankTask(): Partial<Task> {
  return { title: '', status: 'Not Started', priority: 'Medium', dueDate: new Date().toISOString().slice(0, 10) };
}

const GOAL_HORIZONS: GoalHorizon[] = ['Weekly', 'Monthly', 'Quarterly', 'Annual'];
const GOAL_STATUSES: GoalStatus[] = ['Not Started', 'In Progress', 'On Track', 'At Risk', 'Completed'];
const GOAL_HORIZON_ORDER: Record<GoalHorizon, number> = { Weekly: 0, Monthly: 1, Quarterly: 2, Annual: 3 };
const GOAL_PROGRESS_MODES: { value: GoalProgressMode; label: string }[] = [
  { value: 'percent', label: 'Percentage' },
  { value: 'range', label: 'Number range' }
];

function goalStatusSlug(status?: GoalStatus): string {
  return (status ?? 'Not Started').toLowerCase().replace(/\s+/g, '-');
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function goalRangeProgress(start: number, target: number, value: number): number {
  if (start === target) return value >= target ? 100 : 0;
  return clampPct(((value - start) / (target - start)) * 100);
}

// A range goal's slider always needs "drag right = more progress," regardless of which
// direction the actual numbers run. That's automatic when target > start (e.g. saving toward a
// number), but for a "lose weight" goal (start 200, target 150) the raw value itself decreases
// as you progress — a plain min/max/value slider would have dragging right move you *away* from
// the goal. Instead of exposing the raw value as the slider's own value, the slider works in
// "distance traveled from start toward target" (always 0 at start, always the full span at
// target), and these two helpers convert to and from that so dragging right is always progress
// and the fill always lines up with the thumb.
function goalSliderSpan(start: number, target: number): number {
  return Math.abs(target - start);
}
function goalSliderNativeValue(start: number, target: number, value: number): number {
  const span = goalSliderSpan(start, target);
  if (span === 0) return 0;
  const dir = target >= start ? 1 : -1;
  return Math.max(0, Math.min(span, (value - start) * dir));
}
function goalSliderActualValue(start: number, target: number, nativeValue: number): number {
  const dir = target >= start ? 1 : -1;
  return start + dir * nativeValue;
}

function blankGoal(): Partial<Goal> {
  return { title: '', horizon: 'Weekly', progress: 0, status: 'Not Started', progressMode: 'percent' };
}

// A Resources Hub "kind" scope — either one real ResourceKind, or the pinned Code Vault
// shortcut. Code Vault is the code-editor-treated kind (language field, monospace body, no rich
// text toolbar) — backed by 'Repo' internally so 'Snippet' stays free to be an ordinary plain
// note kind, same treatment as Idea/Reference.
type ResourceScope = ResourceKind | 'CodeVault';
function matchesResourceScope(n: Note, scope: ResourceScope): boolean {
  if (scope === 'CodeVault') return n.resourceKind === 'Repo';
  return n.resourceKind === scope;
}

function matchesParaTab(n: Note, tab: ParaTab): boolean {
  if (tab === 'Archive') return Boolean(n.archived);
  if (n.archived) return false; // archived notes are hidden everywhere except the Archive tab
  if (tab === 'All' || tab === 'Overview') return true;
  if (tab === 'Tasks') return false; // Tasks are real Task records, not notes — handled separately.
  if (tab === 'Inbox') return !n.paraType;
  if (tab === 'Projects') return n.paraType === 'Project';
  if (tab === 'Books') return n.paraType === 'Resource' && n.resourceKind === 'Book Note';
  return n.paraType === 'Area'; // tab === 'Areas', the only case left — Resources isn't a tab
}

function localIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isProjectOverdue(n: Note): boolean {
  return Boolean(n.dueDate) && n.status !== 'Completed' && n.dueDate! < localIso();
}

// Derived, not stored — "done" is whatever sits in the board's last column, so this stays
// correct automatically as columns are renamed/added/removed, with no field to keep in sync.
// Returns null when there's nothing to show a bar for (no subtasks yet).
function subtaskProgress(n: Note): { done: number; total: number; pct: number } | null {
  const subtasks = n.subtasks ?? [];
  if (!subtasks.length) return null;
  const columns = projectColumns(n);
  const lastColumnId = columns[columns.length - 1]?.id;
  const done = subtasks.filter(s => s.status === lastColumnId).length;
  return { done, total: subtasks.length, pct: Math.round((done / subtasks.length) * 100) };
}

function isReviewDue(area: Note): boolean {
  if (!area.lastReviewedAt) return true;
  const days = REVIEW_CADENCE_DAYS[area.reviewCadence ?? 'Monthly'];
  return Date.now() - new Date(area.lastReviewedAt).getTime() > days * 86400000;
}

function extractLinkedTitles(body: string): string[] {
  return Array.from(body.matchAll(WIKILINK_PATTERN), m => m[1].trim().toLowerCase());
}

// A Resource note's meaningful "type" is its Kind — the same value the Kind dropdown at the top
// of its editor shows — not the generic paraType every Resource note shares. Every other note
// falls back to its paraType (or "Inbox" once that's cleared to undefined).
function noteTypeLabel(n: Note): string {
  if (n.paraType !== 'Resource') return n.paraType || 'Inbox';
  return n.resourceKind === 'Repo' ? 'Code Vault' : n.resourceKind ?? 'Reference';
}

// A distinct accent per type/kind so the All-tab table's Type column reads as a color-coded
// glance rather than a wall of identical text — Code Vault's teal matches its existing hub-card
// accent, Snippet's purple matches its existing language-badge color; the rest just fill out a
// coherent set from the same token palette.
function noteTypeTone(n: Note): string {
  if (n.paraType === 'Resource') {
    if (n.resourceKind === 'Repo') return 'teal';
    if (n.resourceKind === 'Snippet') return 'purple';
    if (n.resourceKind === 'Reference') return 'blue';
    return 'green';
  }
  if (n.paraType === 'Project') return 'accent';
  if (n.paraType === 'Area') return 'amber';
  return 'muted';
}

// Body is HTML now (the rich text editor's own format) for every note except Code Vault
// snippets, which stay plain text — stripping tags first keeps this one function correct for
// both. Photo markers are left as bracket text here — telling a real "[Photo 1]"/"[Trade Setup]"
// marker apart from an unrelated "[something]" the user just typed needs the note's actual image
// list, which this function doesn't have; showing the bracket text verbatim is a harmless fallback.
function snippet(body: string, max = 90): string {
  const flat = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(WIKILINK_PATTERN, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length > max) return `${flat.slice(0, max)}…`;
  if (flat) return flat;
  return /<img[\s>]/i.test(body) ? 'Photo' : 'No content yet.';
}

function markerTextFor(img: NoteImage): string {
  return `[${img.label || `Photo ${img.ordinal}`}]`;
}

// "Photo N" resolves directly by ordinal; anything else is checked against the note's current
// photo labels — the only two shapes a marker's bracket text can ever actually be.
function resolveMarkerImage(images: NoteImage[], innerText: string): NoteImage | undefined {
  const numMatch = innerText.match(/^Photo (\d+)$/);
  if (numMatch) return images.find(img => img.ordinal === Number(numMatch[1]));
  return images.find(img => img.label === innerText);
}

// A bare "[marker]" — not a [[Wikilink]]'s own inner brackets — is only ever one level deep, so
// excluding a "[" immediately before or a "]" immediately after keeps this from matching a
// wikilink's [Title] half by accident.
const BARE_MARKER_PATTERN = /(?<!\[)\[([^[\]]+)\](?!\])/g;

// Combined pass over BOTH token shapes at once (rather than running WIKILINK_PATTERN and
// BARE_MARKER_PATTERN separately) so a single left-to-right scan of a text node's matches can be
// split into plain-text/span replacement nodes in one pass, in the correct order.
const DECORATE_TOKEN_PATTERN = /(\[\[[^\]]+\]\])|((?<!\[)\[[^[\]]+\](?!\]))/g;

// Wraps [[Wikilink]] tokens (yellow/amber) and [Photo N]/[Label] tokens that resolve to a real
// photo (green) in a colored <span>, so the two live inline-token conventions in a note body are
// visually distinguishable from plain text and from each other at a glance — real hyperlinks get
// their color from CSS alone (`.rte-body a`) since they're already a distinct <a> tag.
// Runs directly against the live editor DOM (not the HTML string) so it can be called from
// RichTextEditor's `decorate` prop, which saves/restores the caret by character offset around it —
// wrapping text in a <span> doesn't change total plain-text length, so that offset stays valid.
function decorateBody(root: HTMLElement, images: NoteImage[]): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      // A text node already inside one of our decorated spans is the *result* of a previous
      // pass, not new plain text to re-scan — walking into it again would double-wrap.
      const parent = (node as Text).parentElement;
      if (parent?.closest('.sb-tok-wikilink, .sb-tok-photo')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const targets: Text[] = [];
  let node = walker.nextNode();
  while (node) { targets.push(node as Text); node = walker.nextNode(); }

  targets.forEach(textNode => {
    const text = textNode.textContent ?? '';
    const matches = Array.from(text.matchAll(DECORATE_TOKEN_PATTERN));
    if (matches.length === 0) return;

    const frag = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach(m => {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      const isWikilink = m[1] !== undefined;
      const inner = isWikilink ? m[1].slice(2, -2) : m[2].slice(1, -1);
      const isPhoto = !isWikilink && !!resolveMarkerImage(images, inner);
      if (isWikilink || isPhoto) {
        const span = document.createElement('span');
        span.className = isWikilink ? 'sb-tok-wikilink' : 'sb-tok-photo';
        span.textContent = m[0];
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      cursor = end;
    });
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    textNode.replaceWith(frag);
  });
}

const NOTE_IMAGE_MAX_DIM = 1200;
const NOTE_IMAGE_QUALITY = 0.82;

// Downscales and re-encodes as JPEG so pasted screenshots don't bloat IndexedDB (and, eventually,
// every device's Drive sync payload) with a full-resolution PNG for what's usually just a
// reference image inside a note.
function fileToCompressedDataUrl(file: File, maxDim = NOTE_IMAGE_MAX_DIM, quality = NOTE_IMAGE_QUALITY): Promise<string> {
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

function formatPhotoTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Wikilinks are plain [[Title]] text — renaming a note would silently orphan every
// reference to it, so a rename cascades: every other note's body gets its
// [[Old Title]] occurrences rewritten to [[New Title]] in the same action.
async function cascadeRename(
  oldTitle: string,
  newTitle: string,
  notes: Note[],
  currentId: string,
  upsert: (collection: 'notes', record: Note) => Promise<void>
) {
  const from = oldTitle.trim();
  const to = newTitle.trim();
  if (!from || from.toLowerCase() === to.toLowerCase()) return;
  const pattern = new RegExp(`\\[\\[\\s*${escapeRegExp(from)}\\s*\\]\\]`, 'gi');
  for (const n of notes) {
    if (n.id === currentId || !pattern.test(n.body)) continue;
    pattern.lastIndex = 0;
    await upsert('notes', { ...n, body: n.body.replace(pattern, `[[${to}]]`) });
  }
}

// One small bar reused everywhere a Project surfaces — the list row, the cross-project board
// card, and the project's own Board header — so "how close is this" always looks the same.
function SubtaskProgressBar({ progress, size }: { progress: { done: number; total: number; pct: number }; size?: 'small' }) {
  return (
    <div className={`sb-progress ${size === 'small' ? 'sb-progress-small' : ''}`}>
      <div className="sb-progress-track"><div className="sb-progress-fill" style={{ width: `${progress.pct}%` }} /></div>
      <span className="sb-progress-label">{progress.done}/{progress.total}</span>
    </div>
  );
}

// A Book Note's body — a structured reading log instead of free-form rich text, since the whole
// point of a book note is chapter-by-chapter takeaways rather than one long essay. Each row edits
// in place directly against the parent's `rows` prop (no local draft state) since nothing here
// needs debouncing the way title/tags text fields do.
function BookNotesLog({ rows, onChange }: { rows: BookNoteRow[]; onChange: (rows: BookNoteRow[]) => void }) {
  const addRow = () => {
    onChange([...rows, { id: generateId(), chapter: '', page: '', takeaway: '', application: '' }]);
  };
  const updateRow = (id: string, patch: Partial<BookNoteRow>) => {
    onChange(rows.map(r => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeRow = (id: string) => {
    onChange(rows.filter(r => r.id !== id));
  };
  return (
    <div className="sb-body-rte sb-book-log">
      <div className="sb-book-log-scroll">
        {rows.length ? (
          <table className="grid-table sb-book-log-table">
            <thead>
              <tr>
                <th>Chapter / Section</th>
                <th>Page #</th>
                <th>What I learned / key takeaway</th>
                <th>My thoughts / personal application</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td><input type="text" className="grid-cell-input" value={row.chapter} placeholder="Chapter 1" onChange={e => updateRow(row.id, { chapter: e.target.value })} /></td>
                  <td><input type="text" className="grid-cell-input" value={row.page ?? ''} placeholder="p. 14" onChange={e => updateRow(row.id, { page: e.target.value })} /></td>
                  <td><textarea className="grid-cell-input sb-book-log-textarea" value={row.takeaway} placeholder="Small 1% improvements compound over time." onChange={e => updateRow(row.id, { takeaway: e.target.value })} /></td>
                  <td><textarea className="grid-cell-input sb-book-log-textarea" value={row.application} placeholder="I can apply this to my morning routine…" onChange={e => updateRow(row.id, { application: e.target.value })} /></td>
                  <td className="collection-table-actions">
                    <button type="button" className="icon-btn danger" onClick={() => removeRow(row.id)} aria-label="Remove row"><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No notes yet — add a row for the first chapter or section worth remembering.</EmptyState>
        )}
      </div>
      <button type="button" className="btn ghost small sb-book-log-add" onClick={addRow}><Plus size={14} /> Add row</button>
    </div>
  );
}

function TagsField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      type="text"
      className="sb-tags-input"
      value={text}
      placeholder="Tags — comma separated…"
      onChange={e => {
        setText(e.target.value);
        onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean));
      }}
    />
  );
}

function LinkPickerModal({
  notes, onPick, onClose
}: { notes: Note[]; onPick: (title: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const filtered = notes.filter(n => n.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Modal eyebrow="Second Brain" title="Link to a note" onClose={onClose}>
      <input
        type="text"
        autoFocus
        className="sb-tags-input"
        placeholder="Search notes…"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="sb-link-picker-list">
        {filtered.length ? filtered.map(n => (
          <button type="button" key={n.id} className="sb-link-picker-row" onClick={() => onPick(n.title)}>
            <b>{n.title}</b>
            <small>{snippet(n.body, 60)}</small>
          </button>
        )) : <EmptyState>No notes match.</EmptyState>}
      </div>
    </Modal>
  );
}

function CommandPalette({
  notes, onPick, onClose
}: { notes: Note[]; onPick: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q
    ? notes.filter(n => n.title.toLowerCase().includes(q)).slice(0, 20)
    : [...notes].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 8);
  return (
    <Modal eyebrow="Second Brain" title="Jump to note" onClose={onClose}>
      <input
        type="text"
        autoFocus
        className="sb-tags-input"
        placeholder="Type a note title…"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="sb-link-picker-list">
        {filtered.length ? filtered.map(n => (
          <button type="button" key={n.id} className="sb-link-picker-row" onClick={() => onPick(n.id)}>
            <b>{n.title || 'Untitled'}</b>
            <small>{n.paraType ?? 'Inbox'} · {snippet(n.body, 60)}</small>
          </button>
        )) : <EmptyState>No notes match.</EmptyState>}
      </div>
    </Modal>
  );
}

export function SecondBrain({ initialTab }: { initialTab?: ParaTab } = {}) {
  const { data, upsert, remove, toggleTask } = useStore();
  const isMobile = useIsMobile();
  const isLandscapePhone = useIsMobileLandscape();
  const notes = data.notes;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [paraTab, setParaTab] = useState<ParaTab>(initialTab ?? 'Overview');
  const [projectView, setProjectView] = useState<'List' | 'Board'>('List');
  // Which screen an OPEN Project shows — separate from projectView (the top-level Projects tab's
  // own List/Board toggle) so the same two words never mean two different things depending on
  // whether a note happens to be open.
  const [projectDetailTab, setProjectDetailTab] = useState<'Board' | 'Notes'>('Board');
  const [tableSort, setTableSort] = useState<SortState<'pinned' | 'title' | 'type' | 'tags' | 'updated'>>({ key: 'pinned', dir: 'desc' });
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('Open');
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [taskForm, setTaskForm] = useState<Partial<Task>>(blankTask());
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [goalForm, setGoalForm] = useState<Partial<Goal>>(blankGoal());
  const [confirmDeleteNote, setConfirmDeleteNote] = useState<{ id: string; message: string } | null>(null);
  const [confirmDeleteColumn, setConfirmDeleteColumn] = useState<{ id: string; message: string } | null>(null);
  // Knowledge Hub drill-down: set when a card is clicked, scopes the sidebar list
  // to just that Area's Projects or that Resource kind, until "Back" is clicked.
  const [areaScopeId, setAreaScopeId] = useState<string | null>(null);
  const [resourceScope, setResourceScope] = useState<ResourceScope | null>(null);
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);
  const [captureText, setCaptureText] = useState('');
  // Imperative handles onto the two RichTextEditor instances (a Project's own body, and
  // whichever subtask's notes field is open) — used to insert a [[Wikilink]] or an inline photo
  // at the cursor from outside the editor's own toolbar (the link picker, a compress-then-insert
  // photo upload).
  const bodyEditorRef = useRef<RichTextEditorHandle>(null);
  const subtaskNotesEditorRef = useRef<RichTextEditorHandle>(null);
  const [imageLightboxSrc, setImageLightboxSrc] = useState<string | null>(null);
  const [dragImageOrdinal, setDragImageOrdinal] = useState<number | null>(null);
  const [dragOverImageOrdinal, setDragOverImageOrdinal] = useState<number | null>(null);
  // Shared by both Kanban boards in this file (the cross-project Projects board and a single
  // Project's own subtask board below) — safe to share since only one of the two is ever
  // mounted at once (the former only renders with no note open, the latter only inside one).
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);

  // Frictionless capture — always lands untyped (Inbox) regardless of which PARA
  // tab you're currently viewing. Deliberately no title prompt: organize later.
  const quickCapture = async () => {
    const text = captureText.trim();
    if (!text) return;
    const record = newRecord<Note>({ title: '', body: text, tags: [], pinned: false });
    await upsert('notes', record);
    setCaptureText('');
  };

  const changeTab = (tab: ParaTab) => {
    setParaTab(tab);
    setAreaScopeId(null);
    setResourceScope(null);
    setLanguageFilter(null);
    setTagFilter(null);
    setSelectedId(null);
  };

  // Opening a note always lands on its Board tab when it's a Project — that's where the actual
  // work happens — and has no effect on any other note type. Accepts either a note (when the
  // caller already has it in hand) or a bare id (backlinks, the command palette).
  const openNote = (target: Note | string) => {
    const target_ = typeof target === 'string' ? notes.find(n => n.id === target) : target;
    setSelectedId(target_ ? target_.id : (target as string));
    setProjectDetailTab('Board');
  };

  const visibleTasks = useMemo(
    () => data.tasks
      .filter(t => taskFilter === 'All' ? true : taskFilter === 'Open' ? t.status !== 'Completed' : t.status === 'Completed')
      .slice()
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [data.tasks, taskFilter]
  );

  const startAddTask = () => { setTaskForm(blankTask()); setEditingTaskId(null); setShowTaskForm(true); };
  const startEditTask = (task: Task) => { setTaskForm({ ...task }); setEditingTaskId(task.id); setShowTaskForm(true); };
  const cancelTaskForm = () => { setShowTaskForm(false); setEditingTaskId(null); setTaskForm(blankTask()); };

  const saveTask = async () => {
    if (editingTaskId) {
      const base = data.tasks.find(t => t.id === editingTaskId);
      if (!base) return cancelTaskForm();
      await upsert('tasks', { ...base, ...taskForm } as Task);
    } else {
      await upsert('tasks', newRecord<Task>(taskForm));
    }
    cancelTaskForm();
  };

  const setTaskField = <K extends keyof Task>(key: K, value: Task[K]) => setTaskForm(prev => ({ ...prev, [key]: value }));

  const visibleGoals = useMemo(
    () => data.goals.slice().sort((a, b) => GOAL_HORIZON_ORDER[a.horizon] - GOAL_HORIZON_ORDER[b.horizon]),
    [data.goals]
  );

  const startAddGoal = () => { setGoalForm(blankGoal()); setEditingGoalId(null); setShowGoalForm(true); };
  const startEditGoal = (goal: Goal) => { setGoalForm({ ...goal }); setEditingGoalId(goal.id); setShowGoalForm(true); };
  const cancelGoalForm = () => { setShowGoalForm(false); setEditingGoalId(null); setGoalForm(blankGoal()); };

  const saveGoal = async () => {
    const payload: Partial<Goal> = { ...goalForm };
    if (payload.progressMode === 'range') {
      const start = payload.rangeStart ?? 0;
      const target = payload.rangeTarget ?? 100;
      const value = payload.rangeValue ?? start;
      payload.rangeStart = start;
      payload.rangeTarget = target;
      payload.rangeValue = value;
      payload.progress = goalRangeProgress(start, target, value);
    } else {
      payload.progress = clampPct(payload.progress ?? 0);
    }
    if (editingGoalId) {
      const base = data.goals.find(g => g.id === editingGoalId);
      if (!base) return cancelGoalForm();
      await upsert('goals', { ...base, ...payload } as Goal);
    } else {
      await upsert('goals', newRecord<Goal>(payload));
    }
    cancelGoalForm();
  };

  const setGoalField = <K extends keyof Goal>(key: K, value: Goal[K]) => setGoalForm(prev => ({ ...prev, [key]: value }));

  // Lets the list row's slider drag straight to a new value without opening the edit modal —
  // mirrors the inline sliders on the Goals page itself.
  const setGoalProgress = (goal: Goal, percent: number) => {
    void upsert('goals', { ...goal, progress: clampPct(percent) });
  };

  const setGoalRangeValue = (goal: Goal, value: number) => {
    const start = goal.rangeStart ?? 0;
    const target = goal.rangeTarget ?? 100;
    void upsert('goals', { ...goal, rangeValue: value, progress: goalRangeProgress(start, target, value) });
  };

  const exitScope = () => {
    setAreaScopeId(null);
    setResourceScope(null);
    setLanguageFilter(null);
    setSelectedId(null);
  };

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes) for (const t of n.tags ?? []) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const areaNotes = useMemo(
    () => notes.filter(n => n.paraType === 'Area' && !n.archived).sort((a, b) => a.title.localeCompare(b.title)),
    [notes]
  );

  // Distinct languages among Code Vault entries — only meaningful inside that scope.
  const codeLanguages = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes) {
      if (n.paraType === 'Resource' && n.resourceKind === 'Repo' && n.language && !n.archived) set.add(n.language);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  // The current tab/scope's notes before search, tag, or language filters are applied — shared
  // by filteredNotes below and by tabTags, so the tag row only ever offers tags that actually
  // exist somewhere in the current tab (an Inbox-only tag never shows up while viewing Projects,
  // and vice versa) without those same filters shrinking the option list as you use them.
  const scopedNotes = useMemo(() => {
    return areaScopeId
      ? notes.filter(n => n.paraType === 'Project' && n.areaId === areaScopeId && !n.archived)
      : resourceScope
        ? notes.filter(n => n.paraType === 'Resource' && !n.archived && matchesResourceScope(n, resourceScope))
        : notes.filter(n => matchesParaTab(n, paraTab));
  }, [notes, paraTab, areaScopeId, resourceScope]);

  const tabTags = useMemo(() => {
    const set = new Set<string>();
    for (const n of scopedNotes) for (const t of n.tags ?? []) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [scopedNotes]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return scopedNotes
      .filter(n => !tagFilter || (n.tags ?? []).includes(tagFilter))
      .filter(n => !languageFilter || n.language === languageFilter)
      .filter(n => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || (n.tags ?? []).some(t => t.toLowerCase().includes(q)))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [scopedNotes, query, tagFilter, languageFilter]);

  // Defaults to pinned-first (matching the sidebar list's own default), but any column here is an
  // explicit user choice, so once they pick one it wins outright — no silent pin-first tie-break
  // hiding underneath a sort they asked for.
  const sortedTableNotes = useMemo(() => {
    const dir = tableSort.dir === 'asc' ? 1 : -1;
    return [...filteredNotes].sort((a, b) => {
      switch (tableSort.key) {
        case 'pinned': {
          const byPin = dir * (Number(a.pinned) - Number(b.pinned));
          return byPin || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
        }
        case 'title': return dir * (a.title || 'Untitled').localeCompare(b.title || 'Untitled');
        case 'type': return dir * noteTypeLabel(a).localeCompare(noteTypeLabel(b));
        case 'tags': return dir * (a.tags ?? []).join(', ').localeCompare((b.tags ?? []).join(', '));
        default: return dir * (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '');
      }
    });
  }, [filteredNotes, tableSort]);

  // Areas Hub rollup: live count of each Area's active (non-completed, non-archived) Projects.
  const areaProjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      if (n.paraType !== 'Project' || n.archived || n.status === 'Completed' || !n.areaId) continue;
      counts.set(n.areaId, (counts.get(n.areaId) ?? 0) + 1);
    }
    return counts;
  }, [notes]);

  // Resources Hub rollup: live count per kind, plus the Code Vault count.
  const resourceCounts = useMemo(() => {
    const counts = new Map<ResourceScope, number>();
    for (const n of notes) {
      if (n.paraType !== 'Resource' || n.archived || !n.resourceKind) continue;
      counts.set(n.resourceKind, (counts.get(n.resourceKind) ?? 0) + 1);
      if (n.resourceKind === 'Repo') {
        counts.set('CodeVault', (counts.get('CodeVault') ?? 0) + 1);
      }
    }
    return counts;
  }, [notes]);

  const projectsForBoard = useMemo(
    () => notes.filter(n => n.paraType === 'Project' && !n.archived),
    [notes]
  );

  // Overview landing dashboard data — "what needs my attention right now."
  const needsAttentionProjects = useMemo(
    () => notes
      .filter(n => n.paraType === 'Project' && !n.archived && (isProjectOverdue(n) || n.status === 'Blocked'))
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')),
    [notes]
  );
  const reviewDueAreas = useMemo(
    () => notes.filter(n => n.paraType === 'Area' && !n.archived && isReviewDue(n)),
    [notes]
  );
  const inboxCount = useMemo(() => notes.filter(n => !n.paraType && !n.archived).length, [notes]);
  const recentNotes = useMemo(
    () => [...notes].filter(n => !n.archived).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 5),
    [notes]
  );

  // "Coming up" merges the two things that actually carry due dates — open Tasks and
  // in-flight Projects — into one chronological view, capped to the near future so it reads
  // as "what's next" rather than a dump of every date that's ever been set.
  const upcomingItems = useMemo(() => {
    const cutoff = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
    const today = localIso();
    type Upcoming = { id: string; kind: 'Task' | 'Project'; title: string; dueDate: string; overdue: boolean };
    const items: Upcoming[] = [];
    for (const t of data.tasks) {
      if (t.status === 'Completed' || !t.dueDate || t.dueDate > cutoff) continue;
      items.push({ id: t.id, kind: 'Task', title: t.title, dueDate: t.dueDate, overdue: t.dueDate < today });
    }
    for (const n of notes) {
      if (n.paraType !== 'Project' || n.archived || n.status === 'Completed' || !n.dueDate || n.dueDate > cutoff) continue;
      items.push({ id: n.id, kind: 'Project', title: n.title || 'Untitled', dueDate: n.dueDate, overdue: isProjectOverdue(n) });
    }
    return items.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 6);
  }, [data.tasks, notes]);

  const tasksDueSoonCount = useMemo(() => {
    const cutoff = new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10);
    return data.tasks.filter(t => t.status !== 'Completed' && t.dueDate && t.dueDate <= cutoff).length;
  }, [data.tasks]);

  const activeGoals = useMemo(() => data.goals.filter(g => g.status !== 'Completed'), [data.goals]);
  const goalProgressAvg = useMemo(
    () => activeGoals.length ? Math.round(activeGoals.reduce((s, g) => s + (g.progress ?? 0), 0) / activeGoals.length) : null,
    [activeGoals]
  );
  // Sorted by nearest target date first, but not capped — the card itself stays sized to
  // roughly 4 rows and scrolls internally, so every active goal is reachable without the
  // rest of the Overview page growing to fit them all.
  const goalHighlights = useMemo(
    () => activeGoals.slice().sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999')),
    [activeGoals]
  );

  const note = notes.find(n => n.id === selectedId) ?? null;
  const editingSubtask = (note?.subtasks ?? []).find(s => s.id === editingSubtaskId) ?? null;

  const backlinks = useMemo(() => {
    if (!note) return [];
    const target = note.title.trim().toLowerCase();
    if (!target) return [];
    return notes.filter(n => n.id !== note.id && extractLinkedTitles(n.body).includes(target));
  }, [notes, note]);

  const relatedByTag = useMemo(() => {
    if (!note || !(note.tags ?? []).length) return [];
    const tags = new Set(note.tags);
    const backlinkIds = new Set(backlinks.map(b => b.id));
    return notes
      .filter(n => n.id !== note.id && !n.archived && !backlinkIds.has(n.id) && (n.tags ?? []).some(t => tags.has(t)))
      .slice(0, 8);
  }, [notes, note, backlinks]);

  const duplicateTitle = useMemo(() => {
    if (!note || !note.title.trim()) return false;
    const t = note.title.trim().toLowerCase();
    return notes.some(n => n.id !== note.id && n.title.trim().toLowerCase() === t);
  }, [notes, note]);

  const createNote = async (typeOverride?: ParaType) => {
    const scopePatch: Partial<Note> = areaScopeId
      ? { paraType: 'Project', areaId: areaScopeId }
      : resourceScope
        ? { paraType: 'Resource', resourceKind: resourceScope === 'CodeVault' ? 'Repo' : resourceScope }
        : paraTab === 'Books'
          ? { paraType: 'Resource', resourceKind: 'Book Note', bookStatus: 'Reading' }
          : { paraType: typeOverride ?? TAB_PARA_TYPE[paraTab] };
    const body = scopePatch.paraType ? (PARA_TEMPLATES[scopePatch.paraType] ?? '') : '';
    const record = newRecord<Note>({ title: '', body, tags: [], pinned: false, ...scopePatch });
    await upsert('notes', record);
    openNote(record);
  };

  // window.confirm() never returns true inside this app's embedded preview browser (it
  // auto-dismisses native dialogs), which silently ate every delete click — the trash icon
  // looked broken because the confirmation it was waiting on could never be granted. An
  // in-app Modal sidesteps the native dialog entirely so the click actually goes through.
  const deleteNote = (id: string) => {
    const target = notes.find(n => n.id === id);
    const linkedProjects = target?.paraType === 'Area' ? notes.filter(n => n.paraType === 'Project' && n.areaId === id) : [];
    const message = linkedProjects.length
      ? `Delete this Area? ${linkedProjects.length} project${linkedProjects.length === 1 ? '' : 's'} assigned to it will be unassigned (kept, just no longer linked to an Area). This cannot be undone.`
      : 'Delete this note? This cannot be undone.';
    setConfirmDeleteNote({ id, message });
  };

  const confirmDeleteNoteNow = async () => {
    if (!confirmDeleteNote) return;
    const { id } = confirmDeleteNote;
    const target = notes.find(n => n.id === id);
    const linkedProjects = target?.paraType === 'Area' ? notes.filter(n => n.paraType === 'Project' && n.areaId === id) : [];
    for (const p of linkedProjects) await upsert('notes', { ...p, areaId: undefined });
    await remove('notes', id);
    if (selectedId === id) setSelectedId(null);
    setConfirmDeleteNote(null);
  };

  // The All-tab table skips the confirm modal — deleting straight from a scannable list of many
  // notes is a deliberate, already-considered click, not a stray one worth double-checking twice.
  const deleteNoteInstantly = async (id: string) => {
    const target = notes.find(n => n.id === id);
    const linkedProjects = target?.paraType === 'Area' ? notes.filter(n => n.paraType === 'Project' && n.areaId === id) : [];
    for (const p of linkedProjects) await upsert('notes', { ...p, areaId: undefined });
    await remove('notes', id);
    if (selectedId === id) setSelectedId(null);
  };

  const patchNote = (patch: Partial<Note>) => {
    if (!note) return;
    const oldTitle = note.title;
    void upsert('notes', { ...note, ...patch });
    if (patch.title !== undefined && oldTitle.trim()) {
      void cascadeRename(oldTitle, patch.title, notes, note.id, upsert);
    }
  };

  const changeNoteType = (nextType: ParaType | undefined) => {
    if (!note) return;
    const patch: Partial<Note> = { paraType: nextType };
    if (nextType && !note.body.trim() && PARA_TEMPLATES[nextType]) patch.body = PARA_TEMPLATES[nextType];
    patchNote(patch);
  };

  const addSubtask = () => {
    const title = subtaskDraft.trim();
    if (!title || !note) return;
    const firstColumn = projectColumns(note)[0]?.id ?? 'Not Started';
    const next: ProjectSubtask = { id: generateId(), title, status: firstColumn };
    patchNote({ subtasks: [...(note.subtasks ?? []), next] });
    setSubtaskDraft('');
  };

  const setSubtaskStatus = (id: string, status: string) => {
    if (!note) return;
    patchNote({ subtasks: (note.subtasks ?? []).map(s => (s.id === id ? { ...s, status } : s)) });
  };

  const updateSubtask = (id: string, patch: Partial<ProjectSubtask>) => {
    if (!note) return;
    patchNote({ subtasks: (note.subtasks ?? []).map(s => (s.id === id ? { ...s, ...patch } : s)) });
  };

  // Each Project can reshape its own subtask board — rename a column, add one, or remove one.
  // All three read the board's current effective columns (projectColumns falls back to the
  // default four) before writing, so a project's very first edit materializes that default set
  // onto the note instead of trying to diff against columns that don't exist yet.
  const addColumn = () => {
    if (!note) return;
    const cols = projectColumns(note);
    patchNote({ boardColumns: [...cols, { id: generateId(), label: `Column ${cols.length + 1}` }] });
  };

  const renameColumn = (id: string, label: string) => {
    if (!note) return;
    patchNote({ boardColumns: projectColumns(note).map(c => (c.id === id ? { ...c, label } : c)) });
  };

  // Any subtask sitting in the removed column falls back to whichever column is now first,
  // rather than vanishing — the same "reassign, don't orphan" treatment the app already gives a
  // deleted Area's Projects.
  const removeColumnNow = (id: string) => {
    if (!note) return;
    const cols = projectColumns(note);
    if (cols.length <= 1) return;
    const remaining = cols.filter(c => c.id !== id);
    const fallbackId = remaining[0].id;
    patchNote({
      boardColumns: remaining,
      subtasks: (note.subtasks ?? []).map(s => (s.status === id ? { ...s, status: fallbackId } : s))
    });
  };

  // An empty column is a no-op to remove — deleting it straight away is a deliberate, already-
  // considered click, same as the All-tab table's instant-delete. Only once real subtasks would
  // actually move does it become worth a confirm step, naming the count and where they'll land.
  const removeColumn = (id: string) => {
    if (!note) return;
    const cols = projectColumns(note);
    if (cols.length <= 1) return;
    const count = (note.subtasks ?? []).filter(s => s.status === id).length;
    if (count === 0) { removeColumnNow(id); return; }
    const col = cols.find(c => c.id === id);
    const fallbackLabel = cols.find(c => c.id !== id)?.label ?? 'the first column';
    setConfirmDeleteColumn({
      id,
      message: `Delete "${col?.label ?? 'this column'}"? ${count} subtask${count === 1 ? '' : 's'} will move to "${fallbackLabel}". This cannot be undone.`
    });
  };

  const confirmDeleteColumnNow = () => {
    if (!confirmDeleteColumn) return;
    removeColumnNow(confirmDeleteColumn.id);
    setConfirmDeleteColumn(null);
  };

  const removeSubtask = (id: string) => {
    if (!note) return;
    patchNote({ subtasks: (note.subtasks ?? []).filter(s => s.id !== id) });
    setEditingSubtaskId(prev => (prev === id ? null : prev));
  };

  // Mirrors insertNotePhoto, but the compressed photo and marker land on the subtask (inside the
  // Project's own subtasks array) rather than the Project note directly — re-reads both the note
  // and the subtask fresh at write time since the async compression could outlast either.
  const insertSubtaskPhoto = async (file: File, atRange: Range | null) => {
    if (!note || !editingSubtask) return;
    const noteId = note.id;
    const subtaskId = editingSubtask.id;
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      const latest = notes.find(n => n.id === noteId);
      const latestSubtask = latest?.subtasks?.find(s => s.id === subtaskId);
      if (!latest || !latestSubtask) return;
      const ordinal = latestSubtask.nextPhotoNumber ?? 1;
      const image: NoteImage = { src: dataUrl, addedAt: new Date().toISOString(), ordinal };
      // Same one-combined-write reasoning as insertNotePhoto — a separately-upserted images/
      // nextPhotoNumber patch built from this same pre-insert `latestSubtask` would otherwise
      // silently wipe out the marker the instant it landed.
      const notesHtml = subtaskNotesEditorRef.current?.insertTextRaw(`${markerTextFor(image)} `, atRange) ?? latestSubtask.notes ?? '';
      const updatedSubtask: ProjectSubtask = {
        ...latestSubtask,
        notes: notesHtml,
        images: [...(latestSubtask.images ?? []), image],
        nextPhotoNumber: ordinal + 1
      };
      void upsert('notes', { ...latest, subtasks: (latest.subtasks ?? []).map(s => (s.id === subtaskId ? updatedSubtask : s)) });
    } catch {
      /* unreadable file — silently skip rather than block the rest of the paste/upload */
    }
  };

  const removeSubtaskImage = (ordinal: number) => {
    if (!editingSubtask) return;
    const target = (editingSubtask.images ?? []).find(img => img.ordinal === ordinal);
    if (!target) return;
    const images = (editingSubtask.images ?? []).filter(img => img.ordinal !== ordinal);
    const escaped = escapeRegExp(markerTextFor(target));
    const notesText = (editingSubtask.notes ?? '').replace(new RegExp(`(?<!\\[)${escaped}(?!\\]) ?`, 'g'), '');
    updateSubtask(editingSubtask.id, { images, notes: notesText });
  };

  const renameSubtaskImage = (ordinal: number, label: string) => {
    if (!editingSubtask) return;
    const current = (editingSubtask.images ?? []).find(img => img.ordinal === ordinal);
    if (!current) return;
    const trimmed = label.trim().replace(/[[\]]/g, '');
    const oldMarker = markerTextFor(current);
    const updated = { ...current, label: trimmed || undefined };
    const newMarker = markerTextFor(updated);
    const images = (editingSubtask.images ?? []).map(img => (img.ordinal === ordinal ? updated : img));
    const escaped = escapeRegExp(oldMarker);
    const notesText = (editingSubtask.notes ?? '').replace(new RegExp(`(?<!\\[)${escaped}(?!\\])`, 'g'), newMarker);
    updateSubtask(editingSubtask.id, { images, notes: notesText });
  };

  const reorderSubtaskImages = (fromOrdinal: number, toOrdinal: number) => {
    if (!editingSubtask || fromOrdinal === toOrdinal) return;
    const images = [...(editingSubtask.images ?? [])];
    const fromIdx = images.findIndex(img => img.ordinal === fromOrdinal);
    const toIdx = images.findIndex(img => img.ordinal === toOrdinal);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = images.splice(fromIdx, 1);
    images.splice(toIdx, 0, moved);
    updateSubtask(editingSubtask.id, { images });
  };

  // Archiving stays a single reversible click — flips the status and stamps/clears the timestamp.
  const toggleArchive = () => {
    if (!note) return;
    patchNote(note.archived ? { archived: false, archivedAt: undefined } : { archived: true, archivedAt: new Date().toISOString() });
  };

  // Inserted as plain [[Title]] text at the cursor inside the rich text body — the editor has no
  // idea what a wikilink is, it's just text to it, same as it always was inside the old textarea.
  const insertLink = (title: string) => {
    bodyEditorRef.current?.insertText(`[[${title}]]`);
    setLinkPickerOpen(false);
  };

  // A pasted/uploaded photo drops a small "[Photo N]" marker at the cursor instead of embedding
  // the image itself inline — full-size photos in the running text made the body hard to scroll
  // through, so the actual image lives in the gallery strip below instead, and the marker is just
  // a lightweight pointer to it (see markerTextFor/resolveMarkerImage-style lookups elsewhere).
  const insertNotePhoto = async (file: File, atRange: Range | null) => {
    const targetId = note?.id;
    if (!targetId) return;
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      // Re-read from `notes` rather than trusting the closed-over `note` — compression takes a
      // moment, and the note could have changed in the meantime.
      const latest = notes.find(n => n.id === targetId);
      if (!latest) return;
      const ordinal = latest.nextPhotoNumber ?? 1;
      const image: NoteImage = { src: dataUrl, addedAt: new Date().toISOString(), ordinal };
      // One combined write, built from the marker-inserted HTML — inserting via the ref and then
      // separately upserting the image metadata would race two updates against the same record,
      // and the second (built from this same pre-insert `latest`) would silently wipe out the
      // marker the instant it landed.
      const body = bodyEditorRef.current?.insertTextRaw(`${markerTextFor(image)} `, atRange) ?? latest.body;
      void upsert('notes', { ...latest, body, images: [...(latest.images ?? []), image], nextPhotoNumber: ordinal + 1 });
    } catch {
      /* unreadable file — silently skip rather than block the rest of the paste/upload */
    }
  };

  // Keyed on ordinal, not src — two different photos can end up with the exact same compressed
  // bytes (a genuine duplicate paste, or just very similar tiny images), and matching by src
  // would then remove every photo sharing that data instead of only the one that was clicked.
  const removeImage = (ordinal: number) => {
    if (!note) return;
    const target = (note.images ?? []).find(img => img.ordinal === ordinal);
    if (!target) return;
    const images = (note.images ?? []).filter(img => img.ordinal !== ordinal);
    // Strips every marker referencing the removed photo (renamed or not) so the text doesn't
    // keep pointing at a photo that's no longer there. The look-around guard matches
    // BODY_TOKEN_PATTERN's own bare-marker branch — never touch a bracket that's actually part
    // of a [[Wikilink]].
    const escaped = escapeRegExp(markerTextFor(target));
    const body = note.body.replace(new RegExp(`(?<!\\[)${escaped}(?!\\]) ?`, 'g'), '');
    patchNote({ images, body });
  };

  // Rewrites the same marker in place to show a name instead of a bare number — the ordinal
  // (and so what the marker actually points to) never changes, only how it reads. Once named, the
  // marker drops the "Photo N:" prefix entirely and just reads "[Name]" — clicking it still
  // resolves correctly via resolveMarkerImage's label lookup.
  const renameImage = (ordinal: number, label: string) => {
    if (!note) return;
    const current = (note.images ?? []).find(img => img.ordinal === ordinal);
    if (!current) return;
    const trimmed = label.trim().replace(/[[\]]/g, ''); // brackets would break marker parsing
    const oldMarker = markerTextFor(current);
    const updated = { ...current, label: trimmed || undefined };
    const newMarker = markerTextFor(updated);
    const images = (note.images ?? []).map(img => (img.ordinal === ordinal ? updated : img));
    const escaped = escapeRegExp(oldMarker);
    const body = note.body.replace(new RegExp(`(?<!\\[)${escaped}(?!\\])`, 'g'), newMarker);
    patchNote({ images, body });
  };

  // Purely display order — the ordinal (and every marker referencing it) is untouched, so
  // reordering never needs to touch the body text at all.
  const reorderImages = (fromOrdinal: number, toOrdinal: number) => {
    if (!note || fromOrdinal === toOrdinal) return;
    const images = [...(note.images ?? [])];
    const fromIdx = images.findIndex(img => img.ordinal === fromOrdinal);
    const toIdx = images.findIndex(img => img.ordinal === toOrdinal);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = images.splice(fromIdx, 1);
    images.splice(toIdx, 0, moved);
    patchNote({ images });
  };

  // The rich text body is a real contentEditable now, so a plain click on an <a href> would
  // normally just place the cursor (browsers don't follow links inside editable content without
  // a modifier) — handle Ctrl/Cmd+click ourselves so links stay usable while editing. A [[Title]]
  // wikilink or a bare "[Photo N]" marker is just visible text with no element of its own to hang
  // a handler on, so a plain click is checked against the exact text node/offset the browser
  // resolves the click to (a contentEditable's own hit-testing, not a hand-rolled geometry check
  // the old textarea overlay needed) — landing inside one jumps to that note or opens that photo.
  // `images` is passed in rather than closed over, since this same handler serves both the main
  // note body (note.images) and whichever subtask's notes field is open (editingSubtask.images).
  const handleNoteBodyClick = (e: ReactMouseEvent<HTMLDivElement>, images: NoteImage[]) => {
    const link = (e.target as HTMLElement).closest?.('a[href]');
    if (link && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      window.open(link.getAttribute('href') ?? '', '_blank', 'noopener,noreferrer');
      return;
    }
    const caretRangeFromPoint = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint;
    const range = caretRangeFromPoint?.call(document, e.clientX, e.clientY);
    const textNode = range?.startContainer;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return;
    const text = textNode.textContent ?? '';
    const offset = range!.startOffset;
    // caretRangeFromPoint snaps to the *nearest* character position even when the click lands
    // below/beside the text (e.g. in the blank space under a short last line) — so a hit here
    // only means "closest offset resolves inside the token," not "the click was actually on it."
    // Confirming the point falls inside the token's own bounding rect is what makes this only
    // fire on a direct click.
    const pointInToken = (start: number, end: number): boolean => {
      const tokenRange = document.createRange();
      tokenRange.setStart(textNode, start);
      tokenRange.setEnd(textNode, end);
      return Array.from(tokenRange.getClientRects()).some(r =>
        e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      );
    };
    for (const m of text.matchAll(WIKILINK_PATTERN)) {
      const start = m.index ?? -1;
      const end = start + m[0].length;
      if (offset <= start || offset >= end) continue;
      if (!pointInToken(start, end)) continue;
      const title = m[1].trim().toLowerCase();
      const target = notes.find(n => n.title.trim().toLowerCase() === title);
      if (target) openNote(target);
      return;
    }
    for (const m of text.matchAll(BARE_MARKER_PATTERN)) {
      const start = m.index ?? -1;
      const end = start + m[0].length;
      if (offset <= start || offset >= end) continue;
      if (!pointInToken(start, end)) continue;
      const image = resolveMarkerImage(images, m[1]);
      if (image) setImageLightboxSrc(image.src);
      return;
    }
  };

  // A leftover draft from one Project's subtask box shouldn't still be sitting there, half-typed,
  // once a different note is opened.
  useEffect(() => { setSubtaskDraft(''); setEditingSubtaskId(null); setConfirmDeleteColumn(null); }, [selectedId]);

  // Cmd/Ctrl+K → jump-to-note palette, Cmd/Ctrl+N → new note, Esc → deselect note.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const target = document.activeElement;
      const editing = target instanceof HTMLElement && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
      );
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); return; }
      if (mod && e.key.toLowerCase() === 'n' && !editing) { e.preventDefault(); void createNote(); return; }
      if (e.key === 'Escape' && !editing && !paletteOpen && !linkPickerOpen && selectedId) setSelectedId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Mirrors the ternary chain in the JSX below: these are exactly the states where `sb-editor`
  // renders tab-root content (a hub/dashboard) rather than a note. Nothing was drilled into
  // from the list for these, so on mobile they take the sidebar's place directly instead of
  // sliding over the whole screen the way an opened note does.
  const isAllTab = paraTab === 'All' && !areaScopeId && !resourceScope;
  const hubTabActive = !note && (
    (paraTab === 'Overview' && !resourceScope)
    || paraTab === 'Tasks'
    || paraTab === 'Goals'
    || (paraTab === 'Projects' && projectView === 'Board' && !areaScopeId)
    || (paraTab === 'Areas' && !areaScopeId && !resourceScope)
    || isAllTab
  );
  // All is the table tab: a full-width sortable grid replaces the sidebar+editor split until a
  // row is clicked, at which point `note` becomes truthy and the normal split takes back over.
  const showAllTable = isAllTab && !note;
  useFabAction('Second Brain', 'New note', () => void createNote());
  const mobileNoteOpen = isMobile && !!note;
  const mobileHubActive = isMobile && hubTabActive;
  // Landscape has the width to spare for the desktop-style two-pane layout, just narrower — so
  // only the "a note is open" case branches on orientation. Hub views and the bare list are
  // already a single pane in both orientations and need no special case here.
  const mobileSplitActive = isLandscapePhone && mobileNoteOpen;
  // `sb-editor-push` stays applied across renders whenever a note could open (not just the
  // instant one does) so the browser has a translateX(100%) frame to transition *from* — adding
  // both the fixed positioning and the "slid in" state in the same render would jump instead
  // of sliding, since there's no prior frame to animate against.
  const editorClass = !isMobile
    ? 'sb-editor'
    : mobileHubActive
      ? 'sb-editor sb-editor-hub'
      : mobileSplitActive
        ? 'sb-editor sb-editor-split'
        : `sb-editor sb-editor-push${mobileNoteOpen ? ' sb-editor-active' : ''}`;

  return (
    <>
      <PageHeader
        title="Second Brain"
        subtitle="Notes, ideas, and knowledge — organized with PARA, linked together with [[Note Title]]."
        action={
          <div className="sb-header-actions">
            <button type="button" className="btn ghost" onClick={() => setPaletteOpen(true)} title="Jump to note (Ctrl+K)">
              <Command size={15} /> Jump to…
            </button>
            {paraTab === 'Tasks' ? (
              <button className="btn primary" onClick={startAddTask}><Plus size={16} /> Add task</button>
            ) : paraTab === 'Goals' ? (
              <button className="btn primary" onClick={startAddGoal}><Plus size={16} /> Add goal</button>
            ) : (
              <button className="btn primary" onClick={() => void createNote()}><Plus size={16} /> New note</button>
            )}
          </div>
        }
      />

      <VaultOnboarding />

      <div className="sb-toolbar">
        <div className="sb-para-tabs">
          {PARA_TABS.map(tab => (
            <button
              key={tab}
              type="button"
              className={`sb-para-tab ${tab === 'Archive' ? 'sb-para-tab-icon' : ''} ${paraTab === tab && !areaScopeId && !resourceScope ? 'on' : ''}`}
              onClick={() => changeTab(tab)}
              title={tab === 'Archive' ? 'Archive' : undefined}
              aria-label={tab === 'Archive' ? 'Archive' : undefined}
            >
              {tab === 'Archive' ? <Archive size={14} /> : tab}
            </button>
          ))}
        </div>
        {note?.paraType === 'Project' ? (
          <div className="sb-view-toggle">
            <button type="button" className={projectDetailTab === 'Board' ? 'on' : ''} onClick={() => setProjectDetailTab('Board')}>Board</button>
            <button type="button" className={projectDetailTab === 'Notes' ? 'on' : ''} onClick={() => setProjectDetailTab('Notes')}>Notes</button>
          </div>
        ) : paraTab === 'Projects' && !areaScopeId && (
          <div className="sb-view-toggle">
            <button type="button" className={projectView === 'List' ? 'on' : ''} onClick={() => setProjectView('List')}>List</button>
            <button type="button" className={projectView === 'Board' ? 'on' : ''} onClick={() => setProjectView('Board')}>Board</button>
          </div>
        )}
      </div>

      {showAllTable ? (
        <div className={`sb-shell sb-table-shell ${mobileHubActive ? 'sb-hub-active' : ''}`}>
          <div className="sb-table-toolbar">
            <div className="sb-table-toolbar-row">
              <div className="sb-search sb-search-inline">
                <Search size={14} />
                <input type="text" placeholder="Search notes…" value={query} onChange={e => setQuery(e.target.value)} />
              </div>
              <span className="sb-table-count">{sortedTableNotes.length} note{sortedTableNotes.length === 1 ? '' : 's'}</span>
            </div>
            {allTags.length > 0 && (
              <div className="sb-tag-row sb-tag-row-inline">
                {allTags.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={`sb-tag-chip ${tagFilter === t ? 'on' : ''}`}
                    onClick={() => setTagFilter(prev => (prev === t ? null : t))}
                  >
                    {t}
                  </button>
                ))}
                {tagFilter && (
                  <button type="button" className="sb-tag-chip-clear" onClick={() => setTagFilter(null)} aria-label="Clear tag filter">
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="sb-table-view">
            {isMobile ? (
              <MobileRecordList
                items={sortedTableNotes}
                primary={n => <>{n.pinned && <Pin size={12} className="mrl-pin-icon" />} {n.title || 'Untitled'}</>}
                secondary={n => noteTypeLabel(n)}
                trailing={n => formatDate(n.updatedAt)}
                fields={[{ label: 'Tags', value: n => ((n.tags ?? []).length ? (n.tags ?? []).join(', ') : '—') }]}
                onOpen={n => openNote(n)}
                onDelete={n => void deleteNoteInstantly(n.id)}
                deleteLabel={n => `Delete ${n.title || 'Untitled'}`}
                empty={notes.length ? 'No notes match.' : 'No notes yet — create your first one.'}
              />
            ) : sortedTableNotes.length ? (
              <div className="grid-table-wrap grid-table-scroll">
                <table className="grid-table sb-all-table">
                  <thead>
                    <tr>
                      <SortableTh label="Pin" sortKey="pinned" state={tableSort} onSort={k => setTableSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="Title" sortKey="title" state={tableSort} onSort={k => setTableSort(s => toggleSort(s, k))} />
                      <SortableTh label="Type" sortKey="type" state={tableSort} onSort={k => setTableSort(s => toggleSort(s, k))} />
                      <SortableTh label="Tags" sortKey="tags" state={tableSort} onSort={k => setTableSort(s => toggleSort(s, k))} />
                      <SortableTh label="Updated" sortKey="updated" state={tableSort} onSort={k => setTableSort(s => toggleSort(s, k, 'desc'))} />
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTableNotes.map(n => {
                      const visibleTags = (n.tags ?? []).slice(0, 3);
                      const hiddenTagCount = (n.tags ?? []).length - visibleTags.length;
                      return (
                        <tr key={n.id} onClick={() => openNote(n)} className="sb-table-row">
                          <td className="sb-all-table-pin">{n.pinned && <Pin size={12} />}</td>
                          <td className="sb-all-table-title">{n.title || 'Untitled'}</td>
                          <td>
                            <span className={`sb-type-pill tone-${noteTypeTone(n)}`}>{noteTypeLabel(n)}</span>
                          </td>
                          <td>
                            {visibleTags.length ? (
                              <span className="sb-all-table-tags">
                                {visibleTags.map(t => <span key={t} className="sb-tag-chip static">{t}</span>)}
                                {hiddenTagCount > 0 && <span className="sb-tag-chip static muted">+{hiddenTagCount}</span>}
                              </span>
                            ) : <span className="grid-static-cell">—</span>}
                          </td>
                          <td className="sb-all-table-date">{formatDate(n.updatedAt)}</td>
                          <td className="collection-table-actions" onClick={e => e.stopPropagation()}>
                            <button type="button" className="icon-btn danger" onClick={() => void deleteNoteInstantly(n.id)} aria-label={`Delete ${n.title || 'Untitled'}`}>
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState>{notes.length ? 'No notes match.' : 'No notes yet — create your first one.'}</EmptyState>}
          </div>
        </div>
      ) : (
      <div className={`sb-shell ${mobileHubActive ? 'sb-hub-active' : ''} ${mobileSplitActive ? 'sb-split-active' : ''}`}>
        <aside className="sb-sidebar">
          {/* The centre FAB already captures to this same inbox, so on a phone this box is a
              second door to the same room costing 113px at the top of the rail. */}
          {!isMobile && (
          <div className="sb-quick-capture">
            <textarea
              rows={2}
              placeholder="Quick capture — dump a thought, link, or task…"
              value={captureText}
              onChange={e => setCaptureText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void quickCapture(); } }}
            />
            <button type="button" className="btn primary small full" onClick={() => void quickCapture()} disabled={!captureText.trim()}>
              Capture to Inbox
            </button>
          </div>
          )}
          {(areaScopeId || resourceScope) && (
            <button type="button" className="sb-scope-back" onClick={exitScope}>
              <ChevronLeft size={14} /> Back to {areaScopeId ? 'Areas' : 'Overview'}
            </button>
          )}
          <div className="sb-search">
            <Search size={14} />
            <input type="text" placeholder="Search notes…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          {resourceScope === 'CodeVault' && codeLanguages.length > 0 && (
            <div className="sb-tag-row">
              {codeLanguages.map(lang => (
                <button
                  key={lang}
                  type="button"
                  className={`sb-tag-chip lang ${languageFilter === lang ? 'on' : ''}`}
                  onClick={() => setLanguageFilter(prev => (prev === lang ? null : lang))}
                >
                  {lang}
                </button>
              ))}
              {languageFilter && (
                <button type="button" className="sb-tag-chip-clear" onClick={() => setLanguageFilter(null)} aria-label="Clear language filter">
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {tabTags.length > 0 && (
            <div className="sb-tag-row">
              {tabTags.map(t => (
                <button
                  key={t}
                  type="button"
                  className={`sb-tag-chip ${tagFilter === t ? 'on' : ''}`}
                  onClick={() => setTagFilter(prev => (prev === t ? null : t))}
                >
                  {t}
                </button>
              ))}
              {tagFilter && (
                <button type="button" className="sb-tag-chip-clear" onClick={() => setTagFilter(null)} aria-label="Clear tag filter">
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          <div className="sb-list">
            {filteredNotes.length ? filteredNotes.map(n => (
              <div className="sb-list-item-wrap" key={n.id}>
                <SwipeRow
                  disabled={!isMobile}
                  trailing={{ label: 'Delete', icon: <Trash2 size={16} />, onTrigger: () => deleteNote(n.id) }}
                >
                  <button
                    type="button"
                    className={`sb-list-item ${selectedId === n.id ? 'active' : ''}`}
                    onClick={() => (selectedId === n.id ? setSelectedId(null) : openNote(n))}
                  >
                    <div className="sb-list-item-head">
                      {n.pinned && <Pin size={11} />}
                      <b>{n.title || 'Untitled'}</b>
                      {n.resourceKind === 'Repo' && n.language && <span className="sb-type-badge lang">{n.language}</span>}
                      {n.paraType && <span className="sb-type-badge">{n.paraType}</span>}
                    </div>
                    {n.paraType === 'Project' && (
                      <div className="sb-list-item-status-row">
                        <span className={`sb-status-pill status-${(n.status ?? 'Not Started').replace(/\s+/g, '-').toLowerCase()}`}>{n.status ?? 'Not Started'}</span>
                        {n.dueDate && <span className={`sb-due-chip ${isProjectOverdue(n) ? 'overdue' : ''}`}>{formatDate(n.dueDate)}</span>}
                      </div>
                    )}
                    {n.paraType === 'Project' && subtaskProgress(n) && <SubtaskProgressBar progress={subtaskProgress(n)!} size="small" />}
                    {n.paraType === 'Area' && isReviewDue(n) && (
                      <div className="sb-list-item-status-row">
                        <span className="sb-due-chip amber">Review due</span>
                      </div>
                    )}
                    {n.resourceKind === 'Book Note' && (
                      <div className="sb-list-item-status-row">
                        <span className={`sb-status-pill status-book-${(n.bookStatus ?? 'Reading').toLowerCase()}`}>{n.bookStatus ?? 'Reading'}</span>
                        {n.bookAuthor && <span className="sb-due-chip">{n.bookAuthor}</span>}
                      </div>
                    )}
                    <p>{n.resourceKind === 'Book Note' ? (n.bookCategory || 'No category set') : snippet(n.body)}</p>
                    <div className="sb-list-item-meta">
                      {(n.tags ?? []).slice(0, 3).map(t => <span key={t} className="sb-tag-chip static">{t}</span>)}
                      <span className="sb-list-item-date">{formatDate(n.updatedAt)}</span>
                    </div>
                  </button>
                </SwipeRow>
                <button
                  type="button"
                  className="icon-btn danger sb-list-item-delete"
                  onClick={e => { e.stopPropagation(); deleteNote(n.id); }}
                  aria-label={`Delete ${n.title || 'Untitled'}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )) : <EmptyState>{notes.length ? 'No notes match.' : 'No notes yet — create your first one.'}</EmptyState>}
          </div>
        </aside>

        <main className={editorClass}>
          {paraTab === 'Projects' && projectView === 'Board' && !note && !areaScopeId ? (
            <div className="sb-board">
              {PROJECT_STATUSES.map(status => {
                const items = projectsForBoard.filter(p => (p.status ?? 'Not Started') === status);
                return (
                  <div
                    key={status}
                    className={`sb-board-col ${dragOverStatus === status ? 'drag-over' : ''}`}
                    onDragOver={e => { if (dragCardId) { e.preventDefault(); setDragOverStatus(status); } }}
                    onDragLeave={() => setDragOverStatus(prev => (prev === status ? null : prev))}
                    onDrop={e => {
                      e.preventDefault();
                      const id = dragCardId ?? e.dataTransfer.getData('text/plain');
                      const p = projectsForBoard.find(pr => pr.id === id);
                      if (p && (p.status ?? 'Not Started') !== status) void upsert('notes', { ...p, status });
                      setDragCardId(null);
                      setDragOverStatus(null);
                    }}
                  >
                    <div className="sb-board-col-head"><span>{status}</span><small>{items.length}</small></div>
                    <div className="sb-board-col-body">
                      {items.length ? items.map(p => (
                        <div
                          key={p.id}
                          className={`sb-board-card ${dragCardId === p.id ? 'dragging' : ''}`}
                          draggable
                          onDragStart={e => { setDragCardId(p.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.id); }}
                          onDragEnd={() => { setDragCardId(null); setDragOverStatus(null); }}
                        >
                          <button type="button" className="sb-board-card-title" onClick={() => openNote(p)}>{p.title || 'Untitled'}</button>
                          {subtaskProgress(p) && <SubtaskProgressBar progress={subtaskProgress(p)!} size="small" />}
                          {p.dueDate && <span className={`sb-due-chip ${isProjectOverdue(p) ? 'overdue' : ''}`}>{formatDate(p.dueDate)}</span>}
                          <select value={p.status ?? 'Not Started'} onChange={e => void upsert('notes', { ...p, status: e.target.value as ParaProjectStatus })}>
                            {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                      )) : <EmptyState>None</EmptyState>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !note && paraTab === 'Overview' && !resourceScope ? (
            <div className="sb-overview">
              <div className="sb-overview-grid">
                <Kpi label="Needs attention" value={needsAttentionProjects.length} tone={needsAttentionProjects.length ? 'red' : 'green'} caption="overdue or blocked projects" />
                <Kpi label="Due this week" value={tasksDueSoonCount} tone={tasksDueSoonCount ? 'amber' : 'green'} caption="open tasks" />
                <Kpi label="Areas due for review" value={reviewDueAreas.length} tone={reviewDueAreas.length ? 'amber' : 'green'} />
                <Kpi
                  label="Goal progress"
                  value={goalProgressAvg === null ? '—' : `${goalProgressAvg}%`}
                  tone={goalProgressAvg === null ? 'default' : goalProgressAvg >= 60 ? 'green' : goalProgressAvg >= 30 ? 'amber' : 'red'}
                  caption="avg. across active goals"
                />
                <Kpi label="Inbox" value={inboxCount} tone={inboxCount ? 'default' : 'green'} caption="awaiting triage" />
              </div>

              <Card className="sb-overview-section">
                <h3>Resources</h3>
                <div className="sb-resources-grid">
                  {RESOURCE_KINDS.map(kind => {
                    const count = resourceCounts.get(kind) ?? 0;
                    const Icon = RESOURCE_KIND_ICONS[kind];
                    return (
                      <button type="button" key={kind} className="sb-resource-mini-card" onClick={() => setResourceScope(kind)}>
                        <Icon size={16} />
                        <span className="sb-resource-mini-card-text">
                          <b>{kind}</b>
                          <span>{count} item{count === 1 ? '' : 's'}</span>
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="sb-resource-mini-card accent"
                    onClick={() => setResourceScope('CodeVault')}
                    title="Your code snippets, all in one place."
                  >
                    <Code2 size={16} />
                    <span className="sb-resource-mini-card-text">
                      <b>Code Vault</b>
                      <span>{resourceCounts.get('CodeVault') ?? 0} item{(resourceCounts.get('CodeVault') ?? 0) === 1 ? '' : 's'}</span>
                    </span>
                  </button>
                </div>
              </Card>

              {upcomingItems.length > 0 && (
                <Card className="sb-overview-section">
                  <h3><Clock size={12} /> Coming up</h3>
                  {upcomingItems.map(item => (
                    <button
                      type="button"
                      key={`${item.kind}-${item.id}`}
                      className="sb-overview-row"
                      onClick={() => {
                        if (item.kind === 'Task') {
                          const task = data.tasks.find(t => t.id === item.id);
                          changeTab('Tasks');
                          if (task) startEditTask(task);
                        } else {
                          openNote(item.id);
                        }
                      }}
                    >
                      <span className={`sb-type-pill tone-${item.kind === 'Task' ? 'blue' : 'accent'}`}>{item.kind}</span>
                      <b>{item.title}</b>
                      <span className={`sb-due-chip ${item.overdue ? 'overdue' : ''}`}>{formatDate(item.dueDate)}</span>
                    </button>
                  ))}
                </Card>
              )}

              {needsAttentionProjects.length > 0 && (
                <Card className="sb-overview-section">
                  <h3>Needs attention</h3>
                  {needsAttentionProjects.map(n => (
                    <button type="button" key={n.id} className="sb-overview-row" onClick={() => openNote(n)}>
                      <b>{n.title || 'Untitled'}</b>
                      <span className={`sb-status-pill status-${(n.status ?? 'Not Started').replace(/\s+/g, '-').toLowerCase()}`}>{n.status ?? 'Not Started'}</span>
                      {n.dueDate && <span className={`sb-due-chip ${isProjectOverdue(n) ? 'overdue' : ''}`}>{formatDate(n.dueDate)}</span>}
                    </button>
                  ))}
                </Card>
              )}

              {reviewDueAreas.length > 0 && (
                <Card className="sb-overview-section">
                  <h3>Areas due for review</h3>
                  {reviewDueAreas.map(a => (
                    <button type="button" key={a.id} className="sb-overview-row" onClick={() => openNote(a)}>
                      <b>{a.title || 'Untitled'}</b>
                      <span className="sb-due-chip amber">{a.lastReviewedAt ? `Last reviewed ${formatDate(a.lastReviewedAt)}` : 'Never reviewed'}</span>
                    </button>
                  ))}
                </Card>
              )}

              {goalHighlights.length > 0 && (
                <Card className="sb-overview-section">
                  <h3><TrendingUp size={12} /> Goal progress</h3>
                  <div className="sb-overview-goals-scroll">
                    {goalHighlights.map(g => {
                      const isRange = g.progressMode === 'range';
                      const rangeStart = g.rangeStart ?? 0;
                      const rangeTarget = g.rangeTarget ?? 100;
                      const rangeValue = g.rangeValue ?? rangeStart;
                      const sliderSpan = goalSliderSpan(rangeStart, rangeTarget);
                      const sliderNativeValue = goalSliderNativeValue(rangeStart, rangeTarget, rangeValue);
                      return (
                        <div key={g.id} className="sb-overview-goal-row">
                          <div className="sb-overview-goal-head">
                            <b>{g.title}</b>
                            <span>{isRange ? `${rangeValue}${g.rangeUnit ?? ''}` : `${g.progress}%`}</span>
                          </div>
                          <input
                            type="range"
                            className="range-slider"
                            min={0}
                            max={isRange ? sliderSpan : 100}
                            value={isRange ? sliderNativeValue : g.progress}
                            onChange={e => (isRange
                              ? setGoalRangeValue(g, goalSliderActualValue(rangeStart, rangeTarget, Number(e.target.value)))
                              : setGoalProgress(g, Number(e.target.value)))}
                            aria-label={`Progress for ${g.title}`}
                            style={{ background: `linear-gradient(to right, var(--teal) ${g.progress}%, var(--border) ${g.progress}%)` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}

              <Card className="sb-overview-section">
                <h3>Recently updated</h3>
                {recentNotes.length ? recentNotes.map(n => (
                  <button type="button" key={n.id} className="sb-overview-row" onClick={() => openNote(n)}>
                    <span className={`sb-type-pill tone-${noteTypeTone(n)}`}>{noteTypeLabel(n)}</span>
                    <b>{n.title || 'Untitled'}</b>
                    <span className="sb-list-item-date">{formatDate(n.updatedAt)}</span>
                  </button>
                )) : <EmptyState>No notes yet — create your first one.</EmptyState>}
              </Card>
            </div>
          ) : !note && paraTab === 'Areas' && !areaScopeId && !resourceScope ? (
            <div className="sb-hub">
              <h2 className="sb-hub-title">Areas</h2>
              <p className="sb-hub-subtitle">Ongoing responsibilities. Click one to see its active Projects.</p>
              <div className="sb-hub-grid">
                {areaNotes.length ? areaNotes.map(area => {
                  const count = areaProjectCounts.get(area.id) ?? 0;
                  return (
                    <button
                      type="button"
                      key={area.id}
                      className="sb-hub-card"
                      onClick={() => { setAreaScopeId(area.id); openNote(area); }}
                    >
                      <Layers size={18} />
                      <b>{area.title || 'Untitled'}</b>
                      <p>{area.standard || 'No standard set yet.'}</p>
                      <span className="sb-hub-card-count">{count} active project{count === 1 ? '' : 's'}{isReviewDue(area) ? ' · review due' : ''}</span>
                    </button>
                  );
                }) : <EmptyState>No areas yet — set a note's type to "Area" to create one.</EmptyState>}
              </div>
            </div>
          ) : paraTab === 'Tasks' ? (
            <div className="sb-tasks-panel">
              <div className="filter-row">
                {(['Open', 'Completed', 'All'] as TaskFilter[]).map(f => (
                  <button key={f} type="button" className={`chip ${taskFilter === f ? 'active' : ''}`} onClick={() => setTaskFilter(f)}>{f}</button>
                ))}
              </div>
              <Card>
                {visibleTasks.length ? (
                  <div className="record-list">
                    {visibleTasks.map(task => (
                      <SwipeRow
                        key={task.id}
                        disabled={!isMobile}
                        leading={{
                          label: task.status === 'Completed' ? 'Undo' : 'Done',
                          icon: <Check size={16} />,
                          onTrigger: () => void toggleTask(task)
                        }}
                        trailing={{ label: 'Delete', icon: <Trash2 size={16} />, onTrigger: () => void remove('tasks', task.id) }}
                      >
                        <div className="task-row">
                          <button
                            type="button"
                            className={`check-circle ${task.status === 'Completed' ? 'done' : ''}`}
                            onClick={() => void toggleTask(task)}
                            aria-label="Toggle complete"
                          />
                          <div className="task-row-main" onClick={() => startEditTask(task)}>
                            <b className={task.status === 'Completed' ? 'strike' : ''}>{task.title}</b>
                            <small>{[task.project || task.category, task.priority].filter(Boolean).join(' · ')}</small>
                          </div>
                          <Badge tone={task.status === 'Completed' ? 'success' : task.dueDate < localIso() ? 'danger' : ''}>
                            {formatDate(task.dueDate)}
                          </Badge>
                          <button className="icon-btn danger" onClick={() => void remove('tasks', task.id)} aria-label="Delete">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </SwipeRow>
                    ))}
                  </div>
                ) : <EmptyState>No {taskFilter.toLowerCase()} tasks.</EmptyState>}
              </Card>
            </div>
          ) : paraTab === 'Goals' ? (
            <div className="sb-tasks-panel">
              <Card>
                {visibleGoals.length ? (
                  <div className="record-list">
                    {visibleGoals.map(goal => {
                      const isRange = goal.progressMode === 'range';
                      const rangeStart = goal.rangeStart ?? 0;
                      const rangeTarget = goal.rangeTarget ?? 100;
                      const rangeValue = goal.rangeValue ?? rangeStart;
                      const sliderSpan = goalSliderSpan(rangeStart, rangeTarget);
                      const sliderNativeValue = goalSliderNativeValue(rangeStart, rangeTarget, rangeValue);
                      const fillPct = goal.progress;
                      return (
                        <div className="task-row" key={goal.id}>
                          <div className="task-row-main sb-goal-row-title" onClick={() => startEditGoal(goal)}>
                            <b>{goal.title || 'Untitled'}</b>
                            <small>{goal.category || 'General'} · {goal.horizon}{goal.targetDate ? ` · ${formatDate(goal.targetDate)}` : ''}</small>
                          </div>
                          <input
                            type="range"
                            className="range-slider sb-goal-row-slider"
                            min={0}
                            max={isRange ? sliderSpan : 100}
                            value={isRange ? sliderNativeValue : goal.progress}
                            onChange={e => (isRange
                              ? setGoalRangeValue(goal, goalSliderActualValue(rangeStart, rangeTarget, Number(e.target.value)))
                              : setGoalProgress(goal, Number(e.target.value)))}
                            aria-label={`Progress for ${goal.title}`}
                            style={{ background: `linear-gradient(to right, var(--teal) ${fillPct}%, var(--border) ${fillPct}%)` }}
                          />
                          <span className="sb-goal-row-pct">{isRange ? `${rangeValue}${goal.rangeUnit ?? ''}` : `${goal.progress}%`}</span>
                          <span className={`goal-status status-${goalStatusSlug(goal.status)}`}>{goal.status ?? 'Not Started'}</span>
                          <button className="icon-btn danger" onClick={() => void remove('goals', goal.id)} aria-label="Delete">
                            <Trash2 size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : <EmptyState>No goals yet — add your first one.</EmptyState>}
              </Card>
            </div>
          ) : note && note.paraType === 'Project' && projectDetailTab === 'Board' ? (
            <>
              {isMobile && (
                <button type="button" className="sb-editor-mobile-back" onClick={() => setSelectedId(null)}>
                  <ChevronLeft size={16} /> Notes
                </button>
              )}
              <div className="sb-editor-toolbar">
                <button type="button" className="icon-btn" onClick={() => patchNote({ pinned: !note.pinned })} title={note.pinned ? 'Unpin' : 'Pin'}>
                  {note.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button type="button" className="icon-btn" onClick={toggleArchive} title={note.archived ? 'Unarchive' : 'Archive'}>
                  {note.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                </button>
                <span className="sb-editor-meta">
                  {note.archived ? `Archived ${formatDate(note.archivedAt)}` : `Updated ${formatDate(note.updatedAt)}`}
                </span>
                <button type="button" className="icon-btn danger" onClick={() => deleteNote(note.id)} title="Delete note">
                  <Trash2 size={15} />
                </button>
              </div>
              <input
                type="text"
                className="sb-title-input"
                placeholder="Untitled"
                value={note.title}
                onChange={e => patchNote({ title: e.target.value })}
              />
              {duplicateTitle && (
                <p className="sb-title-warning">Another note already has this title — [[wikilinks]] to either one may be ambiguous.</p>
              )}
              {subtaskProgress(note) && <SubtaskProgressBar progress={subtaskProgress(note)!} />}
              <div className="sb-subtask-add sb-subtask-add-standalone">
                <input
                  type="text"
                  placeholder="Add a subtask…"
                  value={subtaskDraft}
                  onChange={e => setSubtaskDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } }}
                />
                <button type="button" className="btn primary small" onClick={addSubtask} disabled={!subtaskDraft.trim()}>Add subtask</button>
              </div>
              <div className="sb-board sb-project-subtask-board">
                {projectColumns(note).map(col => {
                  const items = (note.subtasks ?? []).filter(s => s.status === col.id);
                  const onlyColumn = projectColumns(note).length <= 1;
                  return (
                    <div
                      key={col.id}
                      className={`sb-board-col ${dragOverStatus === col.id ? 'drag-over' : ''}`}
                      onDragOver={e => { if (dragCardId) { e.preventDefault(); setDragOverStatus(col.id); } }}
                      onDragLeave={() => setDragOverStatus(prev => (prev === col.id ? null : prev))}
                      onDrop={e => {
                        e.preventDefault();
                        const id = dragCardId ?? e.dataTransfer.getData('text/plain');
                        if (id) setSubtaskStatus(id, col.id);
                        setDragCardId(null);
                        setDragOverStatus(null);
                      }}
                    >
                      <div className="sb-board-col-head">
                        <input
                          type="text"
                          className="sb-board-col-label-input"
                          value={col.label}
                          onChange={e => renameColumn(col.id, e.target.value)}
                          aria-label="Column name"
                        />
                        <small>{items.length}</small>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => removeColumn(col.id)}
                          disabled={onlyColumn}
                          title={onlyColumn ? "A board needs at least one column" : `Remove ${col.label}`}
                          aria-label={`Remove column ${col.label}`}
                        >
                          <X size={11} />
                        </button>
                      </div>
                      <div className="sb-board-col-body">
                        {items.length ? items.map(s => (
                          <div
                            key={s.id}
                            className={`sb-board-card subtask ${dragCardId === s.id ? 'dragging' : ''}`}
                            draggable
                            onDragStart={e => { setDragCardId(s.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); }}
                            onDragEnd={() => { setDragCardId(null); setDragOverStatus(null); }}
                          >
                            <button type="button" className="sb-board-card-title-btn" onClick={() => setEditingSubtaskId(s.id)}>
                              {s.notes?.trim() && <StickyNote size={11} className="sb-subtask-note-icon" />}
                              <span>{s.title}</span>
                            </button>
                            <button type="button" className="icon-btn" onClick={() => removeSubtask(s.id)} aria-label={`Remove ${s.title}`}><X size={12} /></button>
                          </div>
                        )) : <EmptyState>None</EmptyState>}
                      </div>
                    </div>
                  );
                })}
                <button type="button" className="sb-board-add-col" onClick={addColumn}>
                  <Plus size={14} /> Add column
                </button>
              </div>
            </>
          ) : !note ? (
            <div className="sb-editor-empty"><EmptyState>Select a note, or create a new one.</EmptyState></div>
          ) : (
            <>
              {isMobile && (
                <button type="button" className="sb-editor-mobile-back" onClick={() => setSelectedId(null)}>
                  <ChevronLeft size={16} /> Notes
                </button>
              )}
              <div className="sb-editor-toolbar">
                <button type="button" className="icon-btn" onClick={() => patchNote({ pinned: !note.pinned })} title={note.pinned ? 'Unpin' : 'Pin'}>
                  {note.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button type="button" className="icon-btn" onClick={() => setLinkPickerOpen(true)} title="Link to another note">
                  <Link2 size={15} />
                </button>
                <button type="button" className="icon-btn" onClick={toggleArchive} title={note.archived ? 'Unarchive' : 'Archive'}>
                  {note.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                </button>
                <span className="sb-editor-meta">
                  {note.archived ? `Archived ${formatDate(note.archivedAt)}` : `Updated ${formatDate(note.updatedAt)}`}
                </span>
                <button type="button" className="icon-btn danger" onClick={() => deleteNote(note.id)} title="Delete note">
                  <Trash2 size={15} />
                </button>
              </div>
              <input
                type="text"
                className="sb-title-input"
                placeholder="Untitled"
                value={note.title}
                onChange={e => patchNote({ title: e.target.value })}
              />
              {duplicateTitle && (
                <p className="sb-title-warning">Another note already has this title — [[wikilinks]] to either one may be ambiguous.</p>
              )}
              <div className="sb-meta-row">
                <TagsField value={note.tags ?? []} onChange={tags => patchNote({ tags })} />
                {note.paraType === 'Resource' ? (
                  note.resourceKind === 'Repo' ? (
                    <input type="text" className="sb-type-select" value="Code Vault" disabled />
                  ) : note.resourceKind === 'Book Note' ? (
                    <input type="text" className="sb-type-select" value="Book Note" disabled />
                  ) : (
                    <select
                      className="sb-type-select"
                      value={note.resourceKind ?? 'Reference'}
                      onChange={e => patchNote({ resourceKind: e.target.value as ResourceKind })}
                    >
                      {RESOURCE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                  )
                ) : (
                  <select
                    className="sb-type-select"
                    value={note.paraType ?? ''}
                    onChange={e => changeNoteType((e.target.value || undefined) as ParaType | undefined)}
                  >
                    <option value="">Inbox</option>
                    <option value="Project">Project</option>
                    <option value="Area">Area</option>
                    <option value="Resource">Resource</option>
                  </select>
                )}
              </div>

              {note.paraType === 'Area' && (
                <div className="sb-para-fields">
                  <label className="wide">
                    <span>Standard</span>
                    <input type="text" value={note.standard ?? ''} placeholder="What does “good” look like here?" onChange={e => patchNote({ standard: e.target.value })} />
                  </label>
                  <label>
                    <span>Review cadence</span>
                    <select value={note.reviewCadence ?? 'Monthly'} onChange={e => patchNote({ reviewCadence: e.target.value as ReviewCadence })}>
                      {REVIEW_CADENCES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Last reviewed</span>
                    <div className="sb-reviewed-row">
                      <span>{note.lastReviewedAt ? formatDate(note.lastReviewedAt) : 'Never'}</span>
                      <button type="button" className="btn ghost small" onClick={() => patchNote({ lastReviewedAt: localIso() })}>Mark reviewed</button>
                    </div>
                  </label>
                </div>
              )}

              {note.paraType === 'Resource' && (
                <div className="sb-para-fields">
                  {note.resourceKind === 'Repo' ? (
                    <label>
                      <span>Language</span>
                      <input type="text" value={note.language ?? ''} placeholder="typescript, python…" onChange={e => patchNote({ language: e.target.value })} />
                    </label>
                  ) : note.resourceKind === 'Book Note' ? (
                    <>
                      <label>
                        <span>Author</span>
                        <input type="text" value={note.bookAuthor ?? ''} placeholder="James Clear" onChange={e => patchNote({ bookAuthor: e.target.value })} />
                      </label>
                      <label>
                        <span>Status</span>
                        <select value={note.bookStatus ?? 'Reading'} onChange={e => patchNote({ bookStatus: e.target.value as BookStatus })}>
                          {BOOK_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </label>
                      <label className="wide">
                        <span>Main topic / category</span>
                        <input type="text" value={note.bookCategory ?? ''} placeholder="Productivity, Psychology, Finance…" onChange={e => patchNote({ bookCategory: e.target.value })} />
                      </label>
                    </>
                  ) : (
                    <label className="wide">
                      <span>Source URL</span>
                      <input type="text" value={note.sourceUrl ?? ''} placeholder="https://…" onChange={e => patchNote({ sourceUrl: e.target.value })} />
                    </label>
                  )}
                </div>
              )}

              {note.resourceKind === 'Repo' ? (
                <textarea
                  className="sb-body-input sb-body-code"
                  placeholder='Paste the snippet — a fenced ```lang block is a handy convention, even without a renderer.'
                  value={note.body}
                  onChange={e => patchNote({ body: e.target.value })}
                />
              ) : note.resourceKind === 'Book Note' ? (
                <BookNotesLog rows={note.bookLog ?? []} onChange={bookLog => patchNote({ bookLog })} />
              ) : (
                <RichTextEditor
                  ref={bodyEditorRef}
                  className="sb-body-rte"
                  value={note.body}
                  onChange={html => patchNote({ body: html })}
                  placeholder="Start writing… use [[Note Title]] to link to another note."
                  onImageFile={(file, atRange) => void insertNotePhoto(file, atRange)}
                  onBodyClick={e => handleNoteBodyClick(e, note.images ?? [])}
                  decorate={root => decorateBody(root, note.images ?? [])}
                />
              )}
              {(note.images ?? []).length > 0 && (
                <div className="sb-note-photos">
                  {(note.images ?? []).map(img => (
                    <div
                      className={`sb-note-photo ${dragImageOrdinal === img.ordinal ? 'dragging' : ''} ${dragOverImageOrdinal === img.ordinal && dragImageOrdinal !== null && dragImageOrdinal !== img.ordinal ? 'drag-over' : ''}`}
                      key={img.ordinal}
                      draggable
                      onDragStart={() => setDragImageOrdinal(img.ordinal)}
                      onDragEnter={() => setDragOverImageOrdinal(img.ordinal)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => {
                        if (dragImageOrdinal !== null) reorderImages(dragImageOrdinal, img.ordinal);
                        setDragImageOrdinal(null);
                        setDragOverImageOrdinal(null);
                      }}
                      onDragEnd={() => { setDragImageOrdinal(null); setDragOverImageOrdinal(null); }}
                    >
                      <button
                        type="button"
                        className="sb-note-photo-expand"
                        onClick={() => setImageLightboxSrc(img.src)}
                        aria-label="View full-size photo"
                        title={img.addedAt ? `Added ${formatPhotoTimestamp(img.addedAt)}` : undefined}
                      >
                        <img src={img.src} alt="" draggable={false} />
                      </button>
                      <button type="button" className="sb-note-photo-remove" onClick={() => removeImage(img.ordinal)} aria-label="Remove photo"><X size={11} /></button>
                      <input
                        type="text"
                        className="sb-note-photo-name"
                        value={img.label ?? ''}
                        placeholder={`Photo ${img.ordinal}`}
                        onChange={e => renameImage(img.ordinal, e.target.value)}
                        onMouseDown={e => e.stopPropagation()}
                        draggable={false}
                        aria-label="Name this photo"
                      />
                    </div>
                  ))}
                </div>
              )}
              {backlinks.length > 0 && (
                <div className="sb-backlinks">
                  <h3>Linked mentions ({backlinks.length})</h3>
                  {backlinks.map(b => (
                    <button type="button" key={b.id} className="sb-backlink-row" onClick={() => openNote(b)}>
                      <b>{b.title || 'Untitled'}</b>
                      <small>{snippet(b.body, 70)}</small>
                    </button>
                  ))}
                </div>
              )}
              {relatedByTag.length > 0 && (
                <div className="sb-backlinks sb-related">
                  <h3>Related by tag</h3>
                  {relatedByTag.map(n => (
                    <button type="button" key={n.id} className="sb-backlink-row" onClick={() => openNote(n)}>
                      <b>{n.title || 'Untitled'}</b>
                      <small>{snippet(n.body, 70)}</small>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </main>
      </div>
      )}

      {linkPickerOpen && note && (
        <LinkPickerModal notes={notes.filter(n => n.id !== note.id)} onPick={insertLink} onClose={() => setLinkPickerOpen(false)} />
      )}
      {paletteOpen && (
        <CommandPalette
          notes={notes.filter(n => !n.archived)}
          onPick={id => { openNote(id); setPaletteOpen(false); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {showTaskForm && (
        <Modal
          eyebrow="Life OS"
          title={editingTaskId ? 'Edit task' : 'New task'}
          onClose={cancelTaskForm}
          footer={<>
            <button type="button" className="btn ghost" onClick={cancelTaskForm}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void saveTask()}>Save</button>
          </>}
        >
          <div className="form-grid">
            <label><span>Title</span><input value={taskForm.title ?? ''} onChange={e => setTaskField('title', e.target.value)} /></label>
            <label>
              <span>Status</span>
              <select value={taskForm.status ?? 'Not Started'} onChange={e => setTaskField('status', e.target.value as TaskStatus)}>
                {TASK_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>
              <span>Priority</span>
              <select value={taskForm.priority ?? 'Medium'} onChange={e => setTaskField('priority', e.target.value as Priority)}>
                {TASK_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label><span>Due date</span><DatePicker value={taskForm.dueDate} onChange={v => setTaskField('dueDate', v)} /></label>
            <label><span>Category</span><input value={taskForm.category ?? ''} onChange={e => setTaskField('category', e.target.value)} /></label>
            <label><span>Project</span><input value={taskForm.project ?? ''} onChange={e => setTaskField('project', e.target.value)} /></label>
            <label><span>Reminder</span><input type="datetime-local" value={taskForm.reminderAt ?? ''} onChange={e => setTaskField('reminderAt', e.target.value)} /></label>
            <label className="inline">
              <input type="checkbox" checked={Boolean(taskForm.recurring)} onChange={e => setTaskField('recurring', e.target.checked)} />
              <span>Recurring</span>
            </label>
            {taskForm.recurring && (
              <label>
                <span>Repeats</span>
                <select value={taskForm.frequency ?? 'Weekly'} onChange={e => setTaskField('frequency', e.target.value as Frequency)}>
                  {TASK_FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            )}
            <label className="field-full"><span>Notes</span><RichTextEditor value={taskForm.notes ?? ''} onChange={v => setTaskField('notes', v)} /></label>
          </div>
        </Modal>
      )}
      {showGoalForm && (
        <Modal
          eyebrow="Life OS"
          title={editingGoalId ? 'Edit goal' : 'New goal'}
          onClose={cancelGoalForm}
          footer={<>
            <button type="button" className="btn ghost" onClick={cancelGoalForm}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void saveGoal()}>Save</button>
          </>}
        >
          <div className="form-grid">
            <label className="field-full"><span>Title</span><input value={goalForm.title ?? ''} onChange={e => setGoalField('title', e.target.value)} /></label>
            <label><span>Category</span><input value={goalForm.category ?? ''} onChange={e => setGoalField('category', e.target.value)} /></label>
            <label>
              <span>Horizon</span>
              <select value={goalForm.horizon ?? 'Weekly'} onChange={e => setGoalField('horizon', e.target.value as GoalHorizon)}>
                {GOAL_HORIZONS.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
            <label>
              <span>Target date</span>
              <DatePicker value={goalForm.targetDate} onChange={v => setGoalField('targetDate', v)} placeholder="Select date" />
            </label>
            <label>
              <span>Status</span>
              <select value={goalForm.status ?? 'Not Started'} onChange={e => setGoalField('status', e.target.value as GoalStatus)}>
                {GOAL_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="field-full">
              <span>Progress type</span>
              <select
                value={goalForm.progressMode ?? 'percent'}
                onChange={e => {
                  const mode = e.target.value as GoalProgressMode;
                  setGoalForm(prev => ({
                    ...prev,
                    progressMode: mode,
                    ...(mode === 'range' && prev.rangeStart === undefined ? { rangeStart: 0, rangeTarget: 100, rangeValue: 0 } : {})
                  }));
                }}
              >
                {GOAL_PROGRESS_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </label>
            {goalForm.progressMode === 'range' ? (
              <>
                <label><span>Start value</span><input type="number" value={goalForm.rangeStart ?? 0} onChange={e => setGoalField('rangeStart', Number(e.target.value))} /></label>
                <label><span>Target value</span><input type="number" value={goalForm.rangeTarget ?? 0} onChange={e => setGoalField('rangeTarget', Number(e.target.value))} /></label>
                <label><span>Current value</span><input type="number" value={goalForm.rangeValue ?? goalForm.rangeStart ?? 0} onChange={e => setGoalField('rangeValue', Number(e.target.value))} /></label>
                <label><span>Unit (optional)</span><input value={goalForm.rangeUnit ?? ''} onChange={e => setGoalField('rangeUnit', e.target.value)} placeholder="lb, $, hrs…" /></label>
              </>
            ) : (
              <label className="field-full">
                <span>Progress: {goalForm.progress ?? 0}%</span>
                <input
                  type="range"
                  className="range-slider"
                  min={0}
                  max={100}
                  value={goalForm.progress ?? 0}
                  onChange={e => setGoalField('progress', Number(e.target.value))}
                  style={{ background: `linear-gradient(to right, var(--teal) ${goalForm.progress ?? 0}%, var(--border) ${goalForm.progress ?? 0}%)` }}
                />
              </label>
            )}
            <label className="field-full">
              <span>Linked to</span>
              <select value={goalForm.parentId ?? ''} onChange={e => setGoalField('parentId', e.target.value || undefined)}>
                <option value="">None</option>
                {data.goals.filter(g => g.id !== editingGoalId).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </label>
            <label className="field-full"><span>Notes</span><RichTextEditor value={goalForm.notes ?? ''} onChange={v => setGoalField('notes', v)} /></label>
          </div>
        </Modal>
      )}
      {confirmDeleteNote && (
        <Modal
          eyebrow="Life OS"
          title="Delete note"
          onClose={() => setConfirmDeleteNote(null)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setConfirmDeleteNote(null)}>Cancel</button>
            <button type="button" className="btn danger" onClick={() => void confirmDeleteNoteNow()}>Delete</button>
          </>}
        >
          <p>{confirmDeleteNote.message}</p>
        </Modal>
      )}
      {confirmDeleteColumn && (
        <Modal
          eyebrow="Subtask board"
          title="Delete column"
          onClose={() => setConfirmDeleteColumn(null)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setConfirmDeleteColumn(null)}>Cancel</button>
            <button type="button" className="btn danger" onClick={confirmDeleteColumnNow}>Delete</button>
          </>}
        >
          <p>{confirmDeleteColumn.message}</p>
        </Modal>
      )}
      {editingSubtask && note && (
        <Modal
          eyebrow="Subtask"
          title="Edit subtask"
          onClose={() => setEditingSubtaskId(null)}
          footer={<>
            <button type="button" className="btn danger" onClick={() => removeSubtask(editingSubtask.id)}>Delete</button>
            <button type="button" className="btn primary" onClick={() => setEditingSubtaskId(null)}>Done</button>
          </>}
        >
          <div className="form-grid">
            <label className="field-full">
              <span>Title</span>
              <input
                type="text"
                value={editingSubtask.title}
                onChange={e => updateSubtask(editingSubtask.id, { title: e.target.value })}
              />
            </label>
            <label>
              <span>Column</span>
              <select value={editingSubtask.status} onChange={e => updateSubtask(editingSubtask.id, { status: e.target.value })}>
                {projectColumns(note).map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </label>
            <label className="field-full">
              <span>Notes</span>
              <RichTextEditor
                ref={subtaskNotesEditorRef}
                className="sb-subtask-notes-rte"
                value={editingSubtask.notes ?? ''}
                onChange={html => updateSubtask(editingSubtask.id, { notes: html })}
                placeholder="Details, links, anything worth remembering about this step…"
                onImageFile={(file, atRange) => void insertSubtaskPhoto(file, atRange)}
                onBodyClick={e => handleNoteBodyClick(e, editingSubtask.images ?? [])}
                decorate={root => decorateBody(root, editingSubtask.images ?? [])}
              />
              {(editingSubtask.images ?? []).length > 0 && (
                <div className="sb-note-photos">
                  {(editingSubtask.images ?? []).map(img => (
                    <div
                      className={`sb-note-photo ${dragImageOrdinal === img.ordinal ? 'dragging' : ''} ${dragOverImageOrdinal === img.ordinal && dragImageOrdinal !== null && dragImageOrdinal !== img.ordinal ? 'drag-over' : ''}`}
                      key={img.ordinal}
                      draggable
                      onDragStart={() => setDragImageOrdinal(img.ordinal)}
                      onDragEnter={() => setDragOverImageOrdinal(img.ordinal)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => {
                        if (dragImageOrdinal !== null) reorderSubtaskImages(dragImageOrdinal, img.ordinal);
                        setDragImageOrdinal(null);
                        setDragOverImageOrdinal(null);
                      }}
                      onDragEnd={() => { setDragImageOrdinal(null); setDragOverImageOrdinal(null); }}
                    >
                      <button
                        type="button"
                        className="sb-note-photo-expand"
                        onClick={() => setImageLightboxSrc(img.src)}
                        aria-label="View full-size photo"
                        title={img.addedAt ? `Added ${formatPhotoTimestamp(img.addedAt)}` : undefined}
                      >
                        <img src={img.src} alt="" draggable={false} />
                      </button>
                      <button type="button" className="sb-note-photo-remove" onClick={() => removeSubtaskImage(img.ordinal)} aria-label="Remove photo"><X size={11} /></button>
                      <input
                        type="text"
                        className="sb-note-photo-name"
                        value={img.label ?? ''}
                        placeholder={`Photo ${img.ordinal}`}
                        onChange={e => renameSubtaskImage(img.ordinal, e.target.value)}
                        onMouseDown={e => e.stopPropagation()}
                        draggable={false}
                        aria-label="Name this photo"
                      />
                    </div>
                  ))}
                </div>
              )}
            </label>
          </div>
        </Modal>
      )}
      {imageLightboxSrc && (
        <PhotoLightbox src={imageLightboxSrc} onClose={() => setImageLightboxSrc(null)} />
      )}
    </>
  );
}

const PHOTO_ZOOM_MIN = 1;
const PHOTO_ZOOM_MAX = 4;
const PHOTO_ZOOM_CLICK_STEP = 2.5;

function PhotoLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  const didDragRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const onImageClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (didDragRef.current) { didDragRef.current = false; return; }
    if (zoom > 1) resetZoom();
    else setZoom(PHOTO_ZOOM_CLICK_STEP);
  };

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setZoom(z => {
        const next = Math.min(PHOTO_ZOOM_MAX, Math.max(PHOTO_ZOOM_MIN, z - e.deltaY * 0.0025));
        if (next === PHOTO_ZOOM_MIN) setPan({ x: 0, y: 0 });
        return next;
      });
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (zoom <= 1) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    didDragRef.current = false;
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    const { startX, startY, panX, panY } = dragRef.current;
    if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) didDragRef.current = true;
    setPan({ x: panX + (e.clientX - startX), y: panY + (e.clientY - startY) });
  };
  const endDrag = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div className="photo-lightbox-overlay" onClick={onClose}>
      <button type="button" className="photo-lightbox-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      <img
        ref={imgRef}
        src={src}
        alt=""
        className="photo-lightbox-image"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: dragging ? 'none' : 'transform 0.15s ease-out',
          cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in'
        }}
        onClick={onImageClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        draggable={false}
      />
      {zoom > 1 && (
        <span className="photo-lightbox-zoom">{Math.round(zoom * 100)}%</span>
      )}
    </div>
  );
}
