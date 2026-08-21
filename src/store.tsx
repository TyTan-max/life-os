import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData, CollectionName, CollectionRecord, Settings, Task } from './types';
import {
  addTombstones, applySyncSnapshot, clearTombstones, deleteRecord, getSyncSnapshot, loadAll, makeRecord,
  normalizeData, putRecord, replaceAll, replaceCollection, resetToSeed, saveSettings
} from './storage';
import { downloadSnapshotJson, ensureSignedIn, isConfigured as isDriveConfigured, uploadSnapshotJson } from './lib/googleDriveSync';
import { mergeSnapshots } from './lib/syncMerge';
import type { SyncSnapshot } from './lib/syncMerge';
import { startBrowserReminderLoop, syncScheduledNotifications } from './notifications';
import { registerCustomDebtTypes } from './pages/FinanceAccounts';

type Store = {
  data: AppData;
  loading: boolean;
  upsert: <K extends CollectionName>(collection: K, record: AppData[K][number]) => Promise<void>;
  remove: (collection: CollectionName, id: string) => Promise<void>;
  updateSettings: (patch: Partial<AppData['settings']>) => Promise<void>;
  toggleTask: (task: Task) => Promise<void>;
  exportBackup: () => void;
  importBackup: (file: File) => Promise<void>;
  reset: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  lastDestructive: DestructiveAction | null;
  dismissDestructive: () => void;
  syncNow: (interactive?: boolean) => Promise<void>;
  syncStatus: 'idle' | 'syncing' | 'error';
  syncError: string | null;
  lastSyncedAt: string | null;
  isSyncConfigured: boolean;
};

const empty = {} as Store;
const StoreContext = createContext<Store>(empty);

const COALESCE_MS = 800;

// Shared by undo() and redo(): writing `applied` while the other side of the same history
// entry was `counterpart` means anything present in `applied` but not `counterpart` just
// reappeared (clear its tombstone) and anything present in `counterpart` but not `applied` just
// disappeared (tombstone it) — the same rule in both directions, just with the two arrays swapped.
async function reconcileTombstonesForHistory(
  collection: CollectionName, applied: CollectionRecord[], counterpart: CollectionRecord[]
): Promise<void> {
  const appliedIds = new Set(applied.map(r => r.id));
  const counterpartIds = new Set(counterpart.map(r => r.id));
  const reappeared = applied.filter(r => !counterpartIds.has(r.id)).map(r => r.id);
  const disappeared = counterpart.filter(r => !appliedIds.has(r.id)).map(r => r.id);
  await Promise.all([clearTombstones(collection, reappeared), addTombstones(collection, disappeared)]);
}

type HistoryEntry =
  | { kind: 'collection'; collection: CollectionName; before: CollectionRecord[]; after: CollectionRecord[]; dedupeKey: string; time: number }
  | { kind: 'settings'; before: Settings; after: Settings; dedupeKey: string; time: number }
  | { kind: 'full'; before: AppData; after: AppData; time: number };

type NewHistoryEntry = HistoryEntry extends infer T ? T extends HistoryEntry ? Omit<T, 'time'> : never : never;

export interface DestructiveAction { label: string; at: number; }

const COLLECTION_NOUNS: Partial<Record<CollectionName, string>> = {
  tasks: 'task', habits: 'habit', habitRoutines: 'routine', goals: 'goal', events: 'event',
  budgets: 'budget', transactions: 'transaction', bills: 'bill', movies: 'movie',
  videogames: 'game', books: 'book', financeAccounts: 'account', financeCategories: 'category',
  financeGoals: 'savings goal', notes: 'note', bucketList: 'bucket list item', workouts: 'workout',
  weightEntries: 'weight entry', sleepEntries: 'sleep entry', medications: 'medication',
  meals: 'meal', glucoseEntries: 'glucose entry', workoutRoutines: 'workout routine',
  contacts: 'contact', contactInteractions: 'interaction'
};

// Only genuinely destructive changes get announced. Edits and additions are self-evident on
// screen and fire constantly while typing (every keystroke commits an upsert), so surfacing
// those would mean a toast that never goes away.
function describeDestructive(entry: NewHistoryEntry): string | null {
  if (entry.kind === 'full') return 'Replaced all data';
  if (entry.kind === 'settings') return null;
  const removed = entry.before.length - entry.after.length;
  if (removed <= 0) return null;
  const noun = COLLECTION_NOUNS[entry.collection] ?? 'item';
  return removed === 1 ? `Deleted ${noun}` : `Deleted ${removed} ${noun}s`;
}

function addFrequency(dateString: string, frequency?: Task['frequency']): string {
  const d = new Date(`${dateString}T12:00:00`);
  if (frequency === 'Daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'Weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'Monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'Yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<AppData>(() => ({
    tasks:[], habits:[], habitRoutines:[], routineAssignments:[], goals:[], events:[], budgets:[], transactions:[], bills:[],
    movies:[], videogames:[], books:[], financeAccounts:[], financeCategories:[], financeGoals:[], notes:[], bucketList:[],
    workouts:[], weightEntries:[], sleepEntries:[], medications:[], meals:[], glucoseEntries:[], workoutRoutines:[],
    contacts:[], contactInteractions:[], dailyLogs:[],
    settings:{ userName:'Khuong', theme:'light', notificationsEnabled:false, launchAtLogin:false, dailyBriefTime:'08:00', currency:'USD', weightUnit:'lb', sleepTargetHours:8, dailyCalorieTarget:2200, proteinTargetG:150, glucoseUnit:'mg/dL', glucoseTrackingEnabled:false }
  }));
  const [loading, setLoading] = useState(true);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  const undoStackRef = useRef<HistoryEntry[]>([]);
  const redoStackRef = useRef<HistoryEntry[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  const [lastDestructive, setLastDestructive] = useState<DestructiveAction | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const dismissDestructive = useCallback(() => setLastDestructive(null), []);

  const pushHistory = useCallback((entry: NewHistoryEntry) => {
    const stack = undoStackRef.current;
    const top = stack[stack.length - 1];
    const dedupeKey = 'dedupeKey' in entry ? entry.dedupeKey : undefined;
    const now = Date.now();
    if (dedupeKey && top && 'dedupeKey' in top && top.dedupeKey === dedupeKey && now - top.time < COALESCE_MS) {
      stack[stack.length - 1] = { ...entry, before: (top as { before: unknown }).before, time: now } as HistoryEntry;
    } else {
      stack.push({ ...entry, time: now } as HistoryEntry);
    }
    redoStackRef.current = [];
    setHistoryTick(t => t + 1);
    const destructive = describeDestructive(entry);
    if (destructive) setLastDestructive({ label: destructive, at: now });
  }, []);

  useEffect(() => {
    loadAll().then(setData).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const theme = data.settings.theme;
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [data.settings.theme]);

  // Keeps isLiabilityAccount/isLoanAccount accurate for any custom debt type, regardless of
  // which page is mounted — registering only inside the Debt tab would leave other pages stale.
  useEffect(() => {
    registerCustomDebtTypes(data.settings.customDebtTypes ?? []);
  }, [data.settings.customDebtTypes]);

  useEffect(() => startBrowserReminderLoop(() => dataRef.current), []);

  useEffect(() => {
    if (loading || !data.settings.notificationsEnabled) return;
    const timer = window.setTimeout(() => { void syncScheduledNotifications(data); }, 1200);
    return () => window.clearTimeout(timer);
  }, [data, loading]);

  const upsert = useCallback(async <K extends CollectionName>(collection: K, record: AppData[K][number]) => {
    const updated = { ...record, updatedAt:new Date().toISOString() } as AppData[K][number];
    const before = dataRef.current[collection] as CollectionRecord[];
    let after: CollectionRecord[] = before;
    setData(current => {
      const list = current[collection] as CollectionRecord[];
      const index = list.findIndex(item => item.id === updated.id);
      const next = index >= 0 ? list.map(item => item.id === updated.id ? updated as CollectionRecord : item) : [...list, updated as CollectionRecord];
      after = next;
      return { ...current, [collection]:next } as AppData;
    });
    await putRecord(collection, updated as CollectionRecord);
    pushHistory({ kind:'collection', collection, before, after, dedupeKey:`${collection}:${updated.id}` });
  }, [pushHistory]);

  const remove = useCallback(async (collection: CollectionName, id: string) => {
    const before = dataRef.current[collection] as CollectionRecord[];
    const after = before.filter(item => item.id !== id);
    setData(current => ({ ...current, [collection]:(current[collection] as CollectionRecord[]).filter(item => item.id !== id) } as AppData));
    await deleteRecord(collection, id);
    await addTombstones(collection, [id]);
    pushHistory({ kind:'collection', collection, before, after, dedupeKey:`remove:${collection}:${id}:${Date.now()}:${Math.random()}` });
  }, [pushHistory]);

  const updateSettings = useCallback(async (patch: Partial<AppData['settings']>) => {
    const before = dataRef.current.settings;
    const next = { ...before, ...patch };
    setData(current => ({ ...current, settings:next }));
    await saveSettings(next);
    pushHistory({ kind:'settings', before, after:next, dedupeKey:'settings' });
  }, [pushHistory]);

  const toggleTask = useCallback(async (task: Task) => {
    const completing = task.status !== 'Completed';
    const changed: Task = { ...task, status:completing ? 'Completed' : 'Not Started', completedAt:completing ? new Date().toISOString() : undefined, updatedAt:new Date().toISOString() };
    await upsert('tasks', changed);
    if (completing && task.recurring && task.frequency) {
      const next = makeRecord<Task>({
        ...task,
        id:undefined,
        status:'Not Started',
        completedAt:undefined,
        dueDate:addFrequency(task.dueDate, task.frequency),
        reminderAt:task.reminderAt ? new Date(new Date(task.reminderAt).getTime() + (new Date(`${addFrequency(task.dueDate, task.frequency)}T12:00:00`).getTime() - new Date(`${task.dueDate}T12:00:00`).getTime())).toISOString().slice(0,16) : undefined
      });
      await upsert('tasks', next);
    }
  }, [upsert]);

  const exportBackup = useCallback(() => {
    const blob = new Blob([JSON.stringify(dataRef.current, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `life-os-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importBackup = useCallback(async (file: File) => {
    const raw = JSON.parse(await file.text()) as Partial<AppData>;
    if (!Array.isArray(raw.tasks) || !raw.settings) throw new Error('This does not look like a Life OS backup.');
    const parsed = normalizeData(raw);
    const before = dataRef.current;
    await replaceAll(parsed);
    setData(parsed);
    pushHistory({ kind:'full', before, after:parsed });
  }, [pushHistory]);

  const reset = useCallback(async () => {
    const before = dataRef.current;
    const after = await resetToSeed();
    setData(after);
    pushHistory({ kind:'full', before, after });
  }, [pushHistory]);

  // `interactive` controls whether a missing/expired Google session pops the consent screen
  // (true, for the button the user tapped) or just gives up quietly (false, for anything
  // automatic) — see the matching parameter on ensureSignedIn for why.
  const syncNow = useCallback(async (interactive = true) => {
    setSyncStatus('syncing');
    setSyncError(null);
    try {
      const signedIn = await ensureSignedIn(interactive);
      if (!signedIn) { setSyncStatus('idle'); return; }

      const local = await getSyncSnapshot();
      const remoteJson = await downloadSnapshotJson();
      const remote: SyncSnapshot = remoteJson
        ? JSON.parse(remoteJson) as SyncSnapshot
        : { data: normalizeData({}), tombstones: [], settingsUpdatedAt: new Date(0).toISOString() };

      const merged = mergeSnapshots(local, remote);
      // Written back to both sides: IndexedDB so this device reflects the merge immediately,
      // and Drive so the *next* device to sync merges against the already-combined state
      // instead of just this device's half of it.
      await applySyncSnapshot(merged);
      await uploadSnapshotJson(JSON.stringify(merged));

      setData(merged.data);
      setSyncStatus('idle');
      setLastSyncedAt(new Date().toISOString());
    } catch (err) {
      setSyncStatus('error');
      setSyncError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const undo = useCallback(async () => {
    // Whatever the toast was offering to reverse is either being reversed right now or is no
    // longer the top of the stack — either way the offer is stale.
    setLastDestructive(null);
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    redoStackRef.current.push(entry);
    if (entry.kind === 'collection') {
      setData(current => ({ ...current, [entry.collection]:entry.before } as AppData));
      await replaceCollection(entry.collection, entry.before);
      // Restoring `before` straight into IndexedDB bypasses deleteRecord/putRecord, so a
      // delete's tombstone doesn't clear itself the way it would on a normal remove() — do it
      // explicitly, or the next sync sees "record exists, but there's a newer tombstone for
      // it" and deletes it right back out on every other device.
      await reconcileTombstonesForHistory(entry.collection, entry.before, entry.after);
    } else if (entry.kind === 'settings') {
      setData(current => ({ ...current, settings:entry.before }));
      await saveSettings(entry.before);
    } else {
      setData(entry.before);
      await replaceAll(entry.before);
    }
    setHistoryTick(t => t + 1);
  }, []);

  const redo = useCallback(async () => {
    const entry = redoStackRef.current.pop();
    if (!entry) return;
    undoStackRef.current.push(entry);
    if (entry.kind === 'collection') {
      setData(current => ({ ...current, [entry.collection]:entry.after } as AppData));
      await replaceCollection(entry.collection, entry.after);
      await reconcileTombstonesForHistory(entry.collection, entry.after, entry.before);
    } else if (entry.kind === 'settings') {
      setData(current => ({ ...current, settings:entry.after }));
      await saveSettings(entry.after);
    } else {
      setData(entry.after);
      await replaceAll(entry.after);
    }
    setHistoryTick(t => t + 1);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = document.activeElement;
      const editing = target instanceof HTMLElement && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
      );
      if (editing) return;
      if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); void redo(); }
      else { e.preventDefault(); void undo(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  const value = useMemo<Store>(() => ({
    data, loading, upsert, remove, updateSettings, toggleTask, exportBackup, importBackup, reset,
    undo, redo, canUndo:undoStackRef.current.length > 0, canRedo:redoStackRef.current.length > 0,
    lastDestructive, dismissDestructive, syncNow, syncStatus, syncError, lastSyncedAt,
    isSyncConfigured: isDriveConfigured()
  }), [
    data, loading, upsert, remove, updateSettings, toggleTask, exportBackup, importBackup, reset, undo, redo,
    historyTick, lastDestructive, dismissDestructive, syncNow, syncStatus, syncError, lastSyncedAt
  ]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export const useStore = () => useContext(StoreContext);
export const newRecord = makeRecord;
