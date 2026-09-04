import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import {
  Archive, ArchiveRestore, Bold, BookMarked, Check, ChevronLeft, Code2, Command, Heading2, Inbox as InboxIcon,
  Italic, Layers, Link2, List, ListOrdered, Pin, PinOff, Plus, Quote, Search, Strikethrough, Trash2, Upload, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { Frequency, Goal, GoalHorizon, GoalProgressMode, GoalStatus, Note, NoteImage, ParaProjectStatus, ParaType, Priority, ResourceKind, ReviewCadence, Task, TaskStatus } from '../types';
import { Badge, Card, EmptyState, Kpi, Modal, PageHeader, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { RichTextEditor } from '../components/RichTextEditor';
import { useIsMobile, useIsMobileLandscape } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';
import { SwipeRow } from '../components/SwipeRow';
import { VaultOnboarding } from '../components/VaultOnboarding';
import { htmlToMarkdown } from '../lib/htmlToMarkdown';

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;
// A photo marker is any single-bracket segment that isn't part of a [[Wikilink]] (the negative
// look-around excludes brackets nested inside a double-bracket pair). Its text is either the
// default "Photo N" or, once renamed, the photo's own label — there's no fixed shape to match on
// beyond "some single-bracket text," so resolving a match to an actual photo (see
// resolveMarkerImage) checks the "Photo N" pattern first and falls back to a label lookup.
const PHOTO_MARKER_PATTERN = /(?<!\[)\[([^[\]]+)\](?!\])/g;

const PROJECT_STATUSES: ParaProjectStatus[] = ['Not Started', 'In Progress', 'Blocked', 'Completed'];
const REVIEW_CADENCES: ReviewCadence[] = ['Weekly', 'Monthly', 'Quarterly'];
const RESOURCE_KINDS: ResourceKind[] = ['Article', 'Snippet', 'Reference', 'Idea', 'Book Note', 'Repo'];
const REVIEW_CADENCE_DAYS: Record<ReviewCadence, number> = { Weekly: 7, Monthly: 30, Quarterly: 90 };

// Starting scaffolds for new Project/Area notes — Resources deliberately stay blank
// since their shape varies too much (article vs. snippet vs. idea) for one template.
const PARA_TEMPLATES: Partial<Record<ParaType, string>> = {
  Project: '## Goal\n\n\n## Next action\n\n\n## Notes\n',
  Area: '## Standard — what does "good" look like here?\n\n\n## Resources\n'
};

export type ParaTab = 'Overview' | 'All' | 'Tasks' | 'Inbox' | 'Goals' | 'Projects' | 'Areas' | 'Resources' | 'Archive';
const PARA_TABS: ParaTab[] = ['Overview', 'All', 'Inbox', 'Tasks', 'Goals', 'Projects', 'Areas', 'Resources', 'Archive'];
// A tab's implied paraType, for defaulting new notes created while it's active.
const TAB_PARA_TYPE: Partial<Record<ParaTab, ParaType>> = { Projects: 'Project', Areas: 'Area', Resources: 'Resource' };

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

function blankGoal(): Partial<Goal> {
  return { title: '', horizon: 'Weekly', progress: 0, status: 'Not Started', progressMode: 'percent' };
}

// A Resources Hub "kind" scope — either one real ResourceKind, or the pinned
// Code Vault shortcut, which spans both 'Snippet' and 'Repo' at once.
type ResourceScope = ResourceKind | 'CodeVault';
function matchesResourceScope(n: Note, scope: ResourceScope): boolean {
  if (scope === 'CodeVault') return n.resourceKind === 'Snippet' || n.resourceKind === 'Repo';
  return n.resourceKind === scope;
}

function matchesParaTab(n: Note, tab: ParaTab): boolean {
  if (tab === 'Archive') return Boolean(n.archived);
  if (n.archived) return false; // archived notes are hidden everywhere except the Archive tab
  if (tab === 'All' || tab === 'Overview') return true;
  if (tab === 'Tasks') return false; // Tasks are real Task records, not notes — handled separately.
  if (tab === 'Inbox') return !n.paraType;
  if (tab === 'Projects') return n.paraType === 'Project';
  if (tab === 'Areas') return n.paraType === 'Area';
  return n.paraType === 'Resource';
}

function localIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isProjectOverdue(n: Note): boolean {
  return Boolean(n.dueDate) && n.status !== 'Completed' && n.dueDate! < localIso();
}

function isReviewDue(area: Note): boolean {
  if (!area.lastReviewedAt) return true;
  const days = REVIEW_CADENCE_DAYS[area.reviewCadence ?? 'Monthly'];
  return Date.now() - new Date(area.lastReviewedAt).getTime() > days * 86400000;
}

function extractLinkedTitles(body: string): string[] {
  return Array.from(body.matchAll(WIKILINK_PATTERN), m => m[1].trim().toLowerCase());
}

function snippet(body: string, max = 90): string {
  // Photo markers are left as-is here — telling a real "[Photo 1]"/"[Trade Setup]" marker apart
  // from an unrelated "[something]" the user just typed needs the note's actual image list,
  // which this function doesn't have; showing the bracket text verbatim is a harmless fallback.
  const flat = body.replace(WIKILINK_PATTERN, '$1').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat || 'No content yet.';
}

// "Photo N" resolves directly by ordinal; anything else is checked against the note's current
// photo labels — the only two shapes a marker's bracket text can ever actually be.
function resolveMarkerImage(images: NoteImage[], innerText: string): NoteImage | undefined {
  const numMatch = innerText.match(/^Photo (\d+)$/);
  if (numMatch) return images.find(img => img.ordinal === Number(numMatch[1]));
  return images.find(img => img.label === innerText);
}

function markerTextFor(img: NoteImage): string {
  return `[${img.label || `Photo ${img.ordinal}`}]`;
}

// A real <textarea> can only render its text in one uniform color — there's no way to make part
// of its own content a different color. The highlight overlay works around that: this builds an
// HTML mirror of the exact same text with wikilinks/URL-links/photo-markers wrapped in colored
// spans, sat behind a textarea whose own text is made transparent (see .sb-body-input's `color:
// transparent` + `caret-color`), so what's actually visible is this overlay's coloring while
// every keystroke, click, and selection still goes through the real, fully-editable textarea on
// top. Order matters: [[Wikilink]] is tried before a bare [marker], and [text](url) before that
// again, so a link's own [text] half is never re-classified as a plain marker.
const BODY_TOKEN_PATTERN = /(\[\[[^\]]+\]\])|(\[[^[\]]+\]\(https?:\/\/[^\s)]+\))|((?<!\[)\[[^[\]]+\](?!\]))/g;

function escapeHtmlForBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHighlightedBody(body: string, images: NoteImage[]): string {
  let html = '';
  let lastIndex = 0;
  for (const m of body.matchAll(BODY_TOKEN_PATTERN)) {
    const start = m.index ?? 0;
    html += escapeHtmlForBody(body.slice(lastIndex, start));
    if (m[1]) {
      html += `<span class="sb-body-token-link">${escapeHtmlForBody(m[1])}</span>`;
    } else if (m[2]) {
      html += `<span class="sb-body-token-url">${escapeHtmlForBody(m[2])}</span>`;
    } else if (m[3] && resolveMarkerImage(images, m[3].slice(1, -1))) {
      // Only colored when it actually resolves to a real photo — an unrelated "[something]" the
      // user typed for other reasons stays plain text, same as it always has.
      html += `<span class="sb-body-token-link">${escapeHtmlForBody(m[3])}</span>`;
    } else {
      html += escapeHtmlForBody(m[0]);
    }
    lastIndex = start + m[0].length;
  }
  html += escapeHtmlForBody(body.slice(lastIndex));
  // A trailing newline needs a following blank line to render at all in a div — without this the
  // overlay's last line would collapse and drift out of sync with the textarea underneath it.
  return body.endsWith('\n') ? `${html}\n` : html;
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
  // Knowledge Hub drill-down: set when a card is clicked, scopes the sidebar list
  // to just that Area's Projects or that Resource kind, until "Back" is clicked.
  const [areaScopeId, setAreaScopeId] = useState<string | null>(null);
  const [resourceScope, setResourceScope] = useState<ResourceScope | null>(null);
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);
  const [captureText, setCaptureText] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const bodyHighlightRef = useRef<HTMLDivElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  // Captured on the toolbar button's mousedown (before the file picker steals focus) so the
  // photo marker still lands where the cursor actually was, not wherever focus ends up after
  // the OS dialog closes.
  const pendingImageInsertRef = useRef<{ start: number; end: number } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageLightboxSrc, setImageLightboxSrc] = useState<string | null>(null);
  const [dragImageOrdinal, setDragImageOrdinal] = useState<number | null>(null);
  const [dragOverImageOrdinal, setDragOverImageOrdinal] = useState<number | null>(null);

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
    setSelectedId(null);
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

  // Distinct languages among Snippets — only meaningful inside the Code Vault scope.
  const codeLanguages = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes) {
      if (n.paraType === 'Resource' && n.resourceKind === 'Snippet' && n.language && !n.archived) set.add(n.language);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [notes]);

  const filteredNotes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = areaScopeId
      ? notes.filter(n => n.paraType === 'Project' && n.areaId === areaScopeId && !n.archived)
      : resourceScope
        ? notes.filter(n => n.paraType === 'Resource' && !n.archived && matchesResourceScope(n, resourceScope))
        : notes.filter(n => matchesParaTab(n, paraTab));
    return base
      .filter(n => !tagFilter || (n.tags ?? []).includes(tagFilter))
      .filter(n => !languageFilter || n.language === languageFilter)
      .filter(n => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || (n.tags ?? []).some(t => t.toLowerCase().includes(q)))
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [notes, query, tagFilter, paraTab, areaScopeId, resourceScope, languageFilter]);

  // Areas Hub rollup: live count of each Area's active (non-completed, non-archived) Projects.
  const areaProjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notes) {
      if (n.paraType !== 'Project' || n.archived || n.status === 'Completed' || !n.areaId) continue;
      counts.set(n.areaId, (counts.get(n.areaId) ?? 0) + 1);
    }
    return counts;
  }, [notes]);

  // Resources Hub rollup: live count per kind, plus the combined Code Vault count.
  const resourceCounts = useMemo(() => {
    const counts = new Map<ResourceScope, number>();
    for (const n of notes) {
      if (n.paraType !== 'Resource' || n.archived || !n.resourceKind) continue;
      counts.set(n.resourceKind, (counts.get(n.resourceKind) ?? 0) + 1);
      if (n.resourceKind === 'Snippet' || n.resourceKind === 'Repo') {
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

  const note = notes.find(n => n.id === selectedId) ?? null;

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
        ? { paraType: 'Resource', resourceKind: resourceScope === 'CodeVault' ? 'Snippet' : resourceScope }
        : { paraType: typeOverride ?? TAB_PARA_TYPE[paraTab] };
    const body = scopePatch.paraType ? (PARA_TEMPLATES[scopePatch.paraType] ?? '') : '';
    const record = newRecord<Note>({ title: '', body, tags: [], pinned: false, ...scopePatch });
    await upsert('notes', record);
    setSelectedId(record.id);
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

  // Archiving stays a single reversible click — flips the status and stamps/clears the timestamp.
  const toggleArchive = () => {
    if (!note) return;
    patchNote(note.archived ? { archived: false, archivedAt: undefined } : { archived: true, archivedAt: new Date().toISOString() });
  };

  const insertLink = (title: string) => {
    if (!note) return;
    const ta = bodyRef.current;
    const linkText = `[[${title}]]`;
    const start = ta?.selectionStart ?? note.body.length;
    const end = ta?.selectionEnd ?? note.body.length;
    const nextBody = note.body.slice(0, start) + linkText + note.body.slice(end);
    patchNote({ body: nextBody });
    setLinkPickerOpen(false);
    requestAnimationFrame(() => {
      ta?.focus();
      const pos = start + linkText.length;
      ta?.setSelectionRange(pos, pos);
    });
  };

  // Markdown formatting toolbar — wraps/prefixes the current textarea selection, the same
  // selection-based approach insertLink already uses above, so it composes cleanly with it.
  const wrapSelection = (before: string, after: string = before) => {
    if (!note) return;
    const ta = bodyRef.current;
    const start = ta?.selectionStart ?? note.body.length;
    const end = ta?.selectionEnd ?? note.body.length;
    const selected = note.body.slice(start, end);
    const nextBody = note.body.slice(0, start) + before + selected + after + note.body.slice(end);
    patchNote({ body: nextBody });
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const prefixLines = (prefix: string | ((lineIndex: number) => string)) => {
    if (!note) return;
    const ta = bodyRef.current;
    const start = ta?.selectionStart ?? note.body.length;
    const end = ta?.selectionEnd ?? note.body.length;
    const lineStart = note.body.lastIndexOf('\n', start - 1) + 1;
    const nextNewline = note.body.indexOf('\n', end);
    const lineEnd = nextNewline === -1 ? note.body.length : nextNewline;
    const prefixed = note.body.slice(lineStart, lineEnd)
      .split('\n')
      .map((line, i) => `${typeof prefix === 'function' ? prefix(i) : prefix}${line}`)
      .join('\n');
    const nextBody = note.body.slice(0, lineStart) + prefixed + note.body.slice(lineEnd);
    patchNote({ body: nextBody });
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(lineStart, lineStart + prefixed.length);
    });
  };

  const insertMarkdownLink = () => {
    const url = window.prompt('Link URL (https://…)');
    if (!url) return;
    const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    wrapSelection('[', `](${safe})`);
  };

  // A screenshot on the clipboard (Snipping Tool, Cmd+Shift+4, "Copy image") arrives as an image
  // file, not text/html — caught here before the HTML branch below, since a pasted image often
  // carries no text/html payload at all and would otherwise just silently do nothing in a plain
  // <textarea>. Drops a "[Photo N]" marker at the given cursor position so the photo reads
  // inline exactly where it was placed — e.g. right after the date it belongs to — instead of
  // just landing in an unordered strip at the bottom with no link back to the surrounding text.
  const addImageFile = async (file: File, insertAt: { start: number; end: number } | null) => {
    const targetId = note?.id;
    if (!targetId) return;
    setUploadingImage(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      // Re-read from `notes` rather than trusting the closed-over `note` — compression takes a
      // moment, and another field (including the body itself, if the marker below lands at a
      // now-stale offset) could have changed in the meantime.
      const latest = notes.find(n => n.id === targetId);
      if (!latest) return;
      const ordinal = latest.nextPhotoNumber ?? 1;
      const image: NoteImage = { src: dataUrl, addedAt: new Date().toISOString(), ordinal };
      const patch: Partial<Note> = { images: [...(latest.images ?? []), image], nextPhotoNumber: ordinal + 1 };
      if (insertAt) {
        const marker = `[Photo ${ordinal}] `;
        patch.body = latest.body.slice(0, insertAt.start) + marker + latest.body.slice(insertAt.end);
        const pos = insertAt.start + marker.length;
        requestAnimationFrame(() => {
          bodyRef.current?.focus();
          bodyRef.current?.setSelectionRange(pos, pos);
        });
      }
      void upsert('notes', { ...latest, ...patch });
    } catch {
      /* unreadable file — silently skip rather than block the rest of the paste/upload */
    } finally {
      setUploadingImage(false);
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
    // PHOTO_MARKER_PATTERN's own — never touch a bracket that's actually part of a [[Wikilink]].
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

  const triggerImageUpload = () => {
    const ta = bodyRef.current;
    pendingImageInsertRef.current = ta ? { start: ta.selectionStart, end: ta.selectionEnd } : null;
    imageFileRef.current?.click();
  };

  const onImageFileSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    const insertAt = pendingImageInsertRef.current;
    pendingImageInsertRef.current = null;
    if (file) void addImageFile(file, insertAt);
  };

  // A click that lands inside a "[Photo N]" marker opens that photo instead of just placing the
  // cursor there — textareas can't make part of their text a real link, so this checks where the
  // browser's own click-to-cursor logic landed against the marker positions in the text.
  const onBodyClick = () => {
    if (!note) return;
    const ta = bodyRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    for (const m of note.body.matchAll(PHOTO_MARKER_PATTERN)) {
      const start = m.index ?? -1;
      const end = start + m[0].length;
      if (pos < start || pos > end) continue;
      const image = resolveMarkerImage(note.images ?? [], m[1]);
      if (image) setImageLightboxSrc(image.src);
      return;
    }
  };

  // Pasted HTML (Google Docs, Word, browsers) gets rewritten to Markdown so paragraphs,
  // nested lists, and bold/italic/links survive instead of collapsing into one plain-text
  // run — skipped for code snippets, which should paste verbatim.
  const handleBodyPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!note || note.resourceKind === 'Snippet') return;
    const imageItem = Array.from(e.clipboardData.items).find(item => item.type.startsWith('image/'));
    const imageFile = imageItem?.getAsFile();
    if (imageFile) {
      e.preventDefault();
      void addImageFile(imageFile, { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd });
      return;
    }
    const html = e.clipboardData.getData('text/html');
    if (!html) return;
    e.preventDefault();
    const markdown = htmlToMarkdown(html);
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const nextBody = note.body.slice(0, start) + markdown + note.body.slice(end);
    patchNote({ body: nextBody });
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + markdown.length;
      ta.setSelectionRange(pos, pos);
    });
  };

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
  const hubTabActive = !note && (
    paraTab === 'Overview'
    || paraTab === 'Tasks'
    || paraTab === 'Goals'
    || (paraTab === 'Projects' && projectView === 'Board' && !areaScopeId)
    || (paraTab === 'Areas' && !areaScopeId && !resourceScope)
    || (paraTab === 'Resources' && !areaScopeId && !resourceScope)
  );
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
              className={`sb-para-tab ${paraTab === tab && !areaScopeId && !resourceScope ? 'on' : ''}`}
              onClick={() => changeTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>
        {paraTab === 'Projects' && !areaScopeId && (
          <div className="sb-view-toggle">
            <button type="button" className={projectView === 'List' ? 'on' : ''} onClick={() => setProjectView('List')}>List</button>
            <button type="button" className={projectView === 'Board' ? 'on' : ''} onClick={() => setProjectView('Board')}>Board</button>
          </div>
        )}
      </div>

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
              <ChevronLeft size={14} /> Back to {areaScopeId ? 'Areas' : 'Resources'}
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
          {allTags.length > 0 && (
            <div className="sb-tag-row">
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
          <div className="sb-list">
            {filteredNotes.length ? filteredNotes.map(n => (
              <button
                type="button"
                key={n.id}
                className={`sb-list-item ${selectedId === n.id ? 'active' : ''}`}
                onClick={() => setSelectedId(n.id)}
              >
                <div className="sb-list-item-head">
                  {n.pinned && <Pin size={11} />}
                  <b>{n.title || 'Untitled'}</b>
                  {n.resourceKind === 'Snippet' && n.language && <span className="sb-type-badge lang">{n.language}</span>}
                  {n.paraType && <span className="sb-type-badge">{n.paraType}</span>}
                </div>
                {n.paraType === 'Project' && (
                  <div className="sb-list-item-status-row">
                    <span className={`sb-status-pill status-${(n.status ?? 'Not Started').replace(/\s+/g, '-').toLowerCase()}`}>{n.status ?? 'Not Started'}</span>
                    {n.dueDate && <span className={`sb-due-chip ${isProjectOverdue(n) ? 'overdue' : ''}`}>{formatDate(n.dueDate)}</span>}
                  </div>
                )}
                {n.paraType === 'Area' && isReviewDue(n) && (
                  <div className="sb-list-item-status-row">
                    <span className="sb-due-chip amber">Review due</span>
                  </div>
                )}
                <p>{snippet(n.body)}</p>
                <div className="sb-list-item-meta">
                  {(n.tags ?? []).slice(0, 3).map(t => <span key={t} className="sb-tag-chip static">{t}</span>)}
                  <span className="sb-list-item-date">{formatDate(n.updatedAt)}</span>
                </div>
              </button>
            )) : <EmptyState>{notes.length ? 'No notes match.' : 'No notes yet — create your first one.'}</EmptyState>}
          </div>
        </aside>

        <main className={editorClass}>
          {paraTab === 'Projects' && projectView === 'Board' && !note && !areaScopeId ? (
            <div className="sb-board">
              {PROJECT_STATUSES.map(status => {
                const items = projectsForBoard.filter(p => (p.status ?? 'Not Started') === status);
                return (
                  <div key={status} className="sb-board-col">
                    <div className="sb-board-col-head"><span>{status}</span><small>{items.length}</small></div>
                    <div className="sb-board-col-body">
                      {items.length ? items.map(p => (
                        <div key={p.id} className="sb-board-card">
                          <button type="button" className="sb-board-card-title" onClick={() => setSelectedId(p.id)}>{p.title || 'Untitled'}</button>
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
          ) : !note && paraTab === 'Overview' ? (
            <div className="sb-overview">
              <div className="sb-overview-grid">
                <Kpi label="Needs attention" value={needsAttentionProjects.length} tone={needsAttentionProjects.length ? 'red' : 'green'} caption="overdue or blocked projects" />
                <Kpi label="Areas due for review" value={reviewDueAreas.length} tone={reviewDueAreas.length ? 'amber' : 'green'} />
                <Kpi label="Inbox" value={inboxCount} tone={inboxCount ? 'default' : 'green'} caption="awaiting triage" />
              </div>

              {needsAttentionProjects.length > 0 && (
                <Card className="sb-overview-section">
                  <h3>Needs attention</h3>
                  {needsAttentionProjects.map(n => (
                    <button type="button" key={n.id} className="sb-overview-row" onClick={() => setSelectedId(n.id)}>
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
                    <button type="button" key={a.id} className="sb-overview-row" onClick={() => setSelectedId(a.id)}>
                      <b>{a.title || 'Untitled'}</b>
                      <span className="sb-due-chip amber">{a.lastReviewedAt ? `Last reviewed ${formatDate(a.lastReviewedAt)}` : 'Never reviewed'}</span>
                    </button>
                  ))}
                </Card>
              )}

              <Card className="sb-overview-section">
                <h3>Recently updated</h3>
                {recentNotes.length ? recentNotes.map(n => (
                  <button type="button" key={n.id} className="sb-overview-row" onClick={() => setSelectedId(n.id)}>
                    <b>{n.title || 'Untitled'}</b>
                    <span className="sb-list-item-date">{formatDate(n.updatedAt)}</span>
                  </button>
                )) : <EmptyState>No notes yet — create your first one.</EmptyState>}
              </Card>

              <div className="sb-hub-grid sb-overview-jump">
                <button type="button" className="sb-hub-card" onClick={() => changeTab('Projects')}>
                  <Layers size={18} /><b>Projects</b><p>Things with an end state.</p>
                </button>
                <button type="button" className="sb-hub-card" onClick={() => changeTab('Areas')}>
                  <Layers size={18} /><b>Areas</b><p>Ongoing responsibilities.</p>
                </button>
                <button type="button" className="sb-hub-card" onClick={() => changeTab('Resources')}>
                  <BookMarked size={18} /><b>Resources</b><p>Reference material &amp; ideas.</p>
                </button>
                <button type="button" className="sb-hub-card" onClick={() => changeTab('Inbox')}>
                  <InboxIcon size={18} /><b>Inbox</b><p>{inboxCount} awaiting triage.</p>
                </button>
              </div>
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
                      onClick={() => { setAreaScopeId(area.id); setSelectedId(area.id); }}
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
          ) : !note && paraTab === 'Resources' && !areaScopeId && !resourceScope ? (
            <div className="sb-hub">
              <h2 className="sb-hub-title">Resources</h2>
              <p className="sb-hub-subtitle">Reference material, ideas, and the Code Vault. Click a card to browse it.</p>
              <div className="sb-hub-grid">
                <button type="button" className="sb-hub-card accent" onClick={() => setResourceScope('CodeVault')}>
                  <Code2 size={18} />
                  <b>Code Vault</b>
                  <p>Snippets and repositories in one place.</p>
                  <span className="sb-hub-card-count">{resourceCounts.get('CodeVault') ?? 0} item{(resourceCounts.get('CodeVault') ?? 0) === 1 ? '' : 's'}</span>
                </button>
                {RESOURCE_KINDS.map(kind => {
                  const count = resourceCounts.get(kind) ?? 0;
                  return (
                    <button type="button" key={kind} className="sb-hub-card" onClick={() => setResourceScope(kind)}>
                      <BookMarked size={18} />
                      <b>{kind}</b>
                      <span className="sb-hub-card-count">{count} item{count === 1 ? '' : 's'}</span>
                    </button>
                  );
                })}
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
                      const sliderMin = Math.min(rangeStart, rangeTarget);
                      const sliderMax = Math.max(rangeStart, rangeTarget);
                      return (
                        <div className="task-row" key={goal.id}>
                          <div className="task-row-main sb-goal-row-title" onClick={() => startEditGoal(goal)}>
                            <b>{goal.title || 'Untitled'}</b>
                            <small>{goal.category || 'General'} · {goal.horizon}{goal.targetDate ? ` · ${formatDate(goal.targetDate)}` : ''}</small>
                          </div>
                          <input
                            type="range"
                            className="range-slider sb-goal-row-slider"
                            min={isRange ? sliderMin : 0}
                            max={isRange ? sliderMax : 100}
                            value={isRange ? rangeValue : goal.progress}
                            onChange={e => (isRange ? setGoalRangeValue(goal, Number(e.target.value)) : setGoalProgress(goal, Number(e.target.value)))}
                            aria-label={`Progress for ${goal.title}`}
                            style={{ background: `linear-gradient(to right, var(--teal) ${goal.progress}%, var(--border) ${goal.progress}%)` }}
                          />
                          <span className="sb-goal-row-pct">{goal.progress}{isRange ? goal.rangeUnit ?? '' : '%'}</span>
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
              </div>

              {note.paraType === 'Project' && (
                <div className="sb-para-fields">
                  <label>
                    <span>Status</span>
                    <select value={note.status ?? 'Not Started'} onChange={e => patchNote({ status: e.target.value as ParaProjectStatus })}>
                      {PROJECT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>Due date</span>
                    <DatePicker value={note.dueDate} onChange={v => patchNote({ dueDate: v })} placeholder="No due date" />
                  </label>
                  <label>
                    <span>Area</span>
                    <select value={note.areaId ?? ''} onChange={e => patchNote({ areaId: e.target.value || undefined })}>
                      <option value="">No area</option>
                      {areaNotes.map(a => <option key={a.id} value={a.id}>{a.title || 'Untitled'}</option>)}
                    </select>
                  </label>
                  <label className="wide">
                    <span>Next action</span>
                    <input type="text" value={note.nextAction ?? ''} placeholder="The very next physical step…" onChange={e => patchNote({ nextAction: e.target.value })} />
                  </label>
                </div>
              )}

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
                  <label>
                    <span>Kind</span>
                    <select value={note.resourceKind ?? 'Reference'} onChange={e => patchNote({ resourceKind: e.target.value as ResourceKind })}>
                      {RESOURCE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </label>
                  {note.resourceKind === 'Snippet' ? (
                    <label>
                      <span>Language</span>
                      <input type="text" value={note.language ?? ''} placeholder="typescript, python…" onChange={e => patchNote({ language: e.target.value })} />
                    </label>
                  ) : note.resourceKind === 'Repo' ? (
                    <>
                      <label>
                        <span>Repo URL</span>
                        <input type="text" value={note.repoUrl ?? ''} placeholder="https://github.com/…" onChange={e => patchNote({ repoUrl: e.target.value })} />
                      </label>
                      <label>
                        <span>Docs URL</span>
                        <input type="text" value={note.docsUrl ?? ''} placeholder="https://…" onChange={e => patchNote({ docsUrl: e.target.value })} />
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

              {note.resourceKind !== 'Snippet' && (
                <div className="rte-toolbar sb-format-toolbar">
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection('**')} title="Bold" aria-label="Bold"><Bold size={14} /></button>
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection('*')} title="Italic" aria-label="Italic"><Italic size={14} /></button>
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => wrapSelection('~~')} title="Strikethrough" aria-label="Strikethrough"><Strikethrough size={14} /></button>
                  <span className="rte-divider" />
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => prefixLines('## ')} title="Heading" aria-label="Heading"><Heading2 size={14} /></button>
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => prefixLines('> ')} title="Quote" aria-label="Quote"><Quote size={14} /></button>
                  <span className="rte-divider" />
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => prefixLines('- ')} title="Bulleted list" aria-label="Bulleted list"><List size={14} /></button>
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => prefixLines(i => `${i + 1}. `)} title="Numbered list" aria-label="Numbered list"><ListOrdered size={14} /></button>
                  <span className="rte-divider" />
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={insertMarkdownLink} title="Add link" aria-label="Add link"><Link2 size={14} /></button>
                  <span className="rte-divider" />
                  <button type="button" onMouseDown={e => e.preventDefault()} onClick={triggerImageUpload} disabled={uploadingImage} title="Add a photo" aria-label="Add a photo"><Upload size={14} /></button>
                </div>
              )}
              {note.resourceKind === 'Snippet' ? (
                <textarea
                  ref={bodyRef}
                  className="sb-body-input sb-body-code"
                  placeholder='Paste the snippet — a fenced ```lang block is a handy convention, even without a renderer.'
                  value={note.body}
                  onChange={e => patchNote({ body: e.target.value })}
                  onPaste={handleBodyPaste}
                  onClick={onBodyClick}
                />
              ) : (
                <div className="sb-body-wrap">
                  <div
                    ref={bodyHighlightRef}
                    className="sb-body-highlight"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: renderHighlightedBody(note.body, note.images ?? []) }}
                  />
                  <textarea
                    ref={bodyRef}
                    className="sb-body-input sb-body-input-highlighted"
                    placeholder="Start writing… use [[Note Title]] to link to another note. Paste or upload a photo to drop it in as a [Photo N] marker — click a marker to view that photo."
                    value={note.body}
                    onChange={e => patchNote({ body: e.target.value })}
                    onPaste={handleBodyPaste}
                    onClick={onBodyClick}
                    onScroll={e => {
                      const highlight = bodyHighlightRef.current;
                      if (!highlight) return;
                      highlight.scrollTop = e.currentTarget.scrollTop;
                      highlight.scrollLeft = e.currentTarget.scrollLeft;
                    }}
                  />
                </div>
              )}
              {((note.images ?? []).length > 0 || uploadingImage) && (
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
                  {uploadingImage && <div className="sb-note-photo sb-note-photo-uploading">Uploading…</div>}
                </div>
              )}
              {backlinks.length > 0 && (
                <div className="sb-backlinks">
                  <h3>Linked mentions ({backlinks.length})</h3>
                  {backlinks.map(b => (
                    <button type="button" key={b.id} className="sb-backlink-row" onClick={() => setSelectedId(b.id)}>
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
                    <button type="button" key={n.id} className="sb-backlink-row" onClick={() => setSelectedId(n.id)}>
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

      {linkPickerOpen && note && (
        <LinkPickerModal notes={notes.filter(n => n.id !== note.id)} onPick={insertLink} onClose={() => setLinkPickerOpen(false)} />
      )}
      {paletteOpen && (
        <CommandPalette
          notes={notes.filter(n => !n.archived)}
          onPick={id => { setSelectedId(id); setPaletteOpen(false); }}
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
      {imageLightboxSrc && (
        <div className="photo-lightbox-overlay" onClick={() => setImageLightboxSrc(null)}>
          <button type="button" className="photo-lightbox-close" onClick={() => setImageLightboxSrc(null)} aria-label="Close">
            <X size={20} />
          </button>
          <img src={imageLightboxSrc} alt="" className="photo-lightbox-image" onClick={e => e.stopPropagation()} />
        </div>
      )}
      <input ref={imageFileRef} type="file" accept="image/*" hidden onChange={onImageFileSelected} />
    </>
  );
}
