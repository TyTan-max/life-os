import { openDB, type IDBPDatabase } from 'idb';
import type {
  AppData, BaseRecord, Bill, Budget, BucketListItem, CalendarEvent, CollectionName, CollectionRecord,
  Book, DailyLog, ExerciseSetLog, FinanceAccount, FinanceCategory, GlucoseEntry, Goal, Habit, MealEntry, Medication, Movie,
  Note, RoutineDay, Settings, SleepEntry, Task, Transaction, Videogame, WeightEntry, WorkoutEntry, WorkoutRoutine
} from './types';
import { COLLECTION_NAMES } from './types';
import { generateId } from './utils/id';
import { buildStarterRoutine, ROUTINE_EPOCH } from './lib/starterRoutine';
import type { SyncSnapshot, Tombstone } from './lib/syncMerge';

const DB_NAME = 'life-os';
// Bumped for the new `dailyLogs` store — IndexedDB only runs the `upgrade` callback (which is
// what actually creates a missing object store) on a version increase, not just because
// COLLECTION_NAMES grew. Existing installs stay on the old version, and the new store, forever
// if this number doesn't move.
const DB_VERSION = 21;
const META_STORE = 'meta';
const TOMBSTONES_KEY = 'tombstones';
const SETTINGS_UPDATED_AT_KEY = 'settingsUpdatedAt';
// A tombstone only needs to outlive the longest realistic gap between syncs — 90 days covers
// "went on a long trip and didn't open the laptop," without keeping deletion records forever.
const TOMBSTONE_RETENTION_DAYS = 90;

const CATEGORY_PALETTE = [
  '#4f5bd5', '#0f9488', '#e5484d', '#c47a05', '#1a8a53',
  '#3a5ccc', '#7c4fd6', '#d6409f', '#2563eb', '#ea580c'
];

const DEFAULT_CATEGORY_DEFS: { name: string; kind: 'income' | 'expense'; icon: string; budgetGroup?: 'Needs' | 'Wants' }[] = [
  { name: 'Groceries', kind: 'expense', icon: 'ShoppingCart', budgetGroup: 'Needs' },
  { name: 'Dining Out', kind: 'expense', icon: 'Utensils', budgetGroup: 'Wants' },
  { name: 'Transportation', kind: 'expense', icon: 'Car', budgetGroup: 'Needs' },
  { name: 'Utilities', kind: 'expense', icon: 'Zap', budgetGroup: 'Needs' },
  { name: 'Housing', kind: 'expense', icon: 'Home', budgetGroup: 'Needs' },
  { name: 'Subscriptions', kind: 'expense', icon: 'Repeat', budgetGroup: 'Wants' },
  { name: 'Shopping', kind: 'expense', icon: 'ShoppingBag', budgetGroup: 'Wants' },
  { name: 'Health & Fitness', kind: 'expense', icon: 'HeartPulse', budgetGroup: 'Needs' },
  { name: 'Insurance', kind: 'expense', icon: 'Shield', budgetGroup: 'Needs' },
  { name: 'Travel', kind: 'expense', icon: 'Plane', budgetGroup: 'Wants' },
  { name: 'Entertainment', kind: 'expense', icon: 'Film', budgetGroup: 'Wants' },
  { name: 'Personal Care', kind: 'expense', icon: 'Sparkles', budgetGroup: 'Wants' },
  { name: 'Education', kind: 'expense', icon: 'GraduationCap', budgetGroup: 'Needs' },
  { name: 'Gifts & Donations', kind: 'expense', icon: 'Gift', budgetGroup: 'Wants' },
  { name: 'Miscellaneous', kind: 'expense', icon: 'MoreHorizontal', budgetGroup: 'Wants' },
  { name: 'Salary', kind: 'income', icon: 'Briefcase' },
  { name: 'Freelance', kind: 'income', icon: 'Laptop' },
  { name: 'Investment Income', kind: 'income', icon: 'TrendingUp' },
  { name: 'Other Income', kind: 'income', icon: 'Plus' }
];

function buildDefaultCategories(): FinanceCategory[] {
  return DEFAULT_CATEGORY_DEFS.map((def, i) =>
    makeRecord<FinanceCategory>({
      name: def.name, kind: def.kind, icon: def.icon, budgetGroup: def.budgetGroup,
      color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length], order: i
    })
  );
}

const DEFAULT_SETTINGS: Settings = {
  userName: 'there',
  theme: 'system',
  notificationsEnabled: false,
  launchAtLogin: false,
  dailyBriefTime: '08:00',
  currency: 'USD',
  weightUnit: 'lb',
  sleepTargetHours: 8,
  dailyCalorieTarget: 2200,
  proteinTargetG: 150,
  glucoseUnit: 'mg/dL',
  glucoseTrackingEnabled: false
};

function emptyData(): AppData {
  const base = {} as AppData;
  for (const name of COLLECTION_NAMES) (base as unknown as Record<string, unknown[]>)[name] = [];
  base.settings = { ...DEFAULT_SETTINGS };
  return base;
}

export function makeRecord<T extends BaseRecord>(fields: Partial<T>): T {
  const now = new Date().toISOString();
  return { ...fields, id: fields.id ?? generateId(), createdAt: now, updatedAt: now } as T;
}

export function normalizeData(raw: Partial<AppData>): AppData {
  const base = emptyData();
  for (const name of COLLECTION_NAMES) {
    const value = raw[name];
    (base as unknown as Record<string, unknown[]>)[name] = Array.isArray(value) ? value : [];
  }
  base.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  return base;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        for (const name of COLLECTION_NAMES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        // Projects, Inbox, and Net Worth were retired (Projects/Inbox superseded by
        // Second Brain's PARA tabs; Net Worth's dedicated page was removed) — drop
        // their now-unused object stores instead of leaving orphaned data in IndexedDB.
        for (const retired of ['projects', 'inbox', 'netWorth']) {
          if (db.objectStoreNames.contains(retired)) db.deleteObjectStore(retired);
        }
      }
    });
  }
  return dbPromise;
}

async function readAllCollections(db: IDBPDatabase): Promise<AppData> {
  const data = emptyData();
  for (const name of COLLECTION_NAMES) {
    (data as unknown as Record<string, unknown[]>)[name] = await db.getAll(name);
  }
  const settings = (await db.get(META_STORE, 'settings')) as Settings | undefined;
  data.settings = settings ? { ...DEFAULT_SETTINGS, ...settings } : { ...DEFAULT_SETTINGS };
  return data;
}

async function writeAll(db: IDBPDatabase, data: AppData): Promise<void> {
  const tx = db.transaction([...COLLECTION_NAMES, META_STORE], 'readwrite');
  for (const name of COLLECTION_NAMES) {
    const store = tx.objectStore(name);
    await store.clear();
    for (const record of data[name] as CollectionRecord[]) await store.put(record);
  }
  await tx.objectStore(META_STORE).put(data.settings, 'settings');
  await tx.done;
}

async function migrateFinanceV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'financeMigratedV1');
  if (done) return;

  const legacy = (await db.getAll('transactions')) as unknown as Array<Record<string, unknown>>;
  const needsMigration = legacy.some(t => !('type' in t));

  if (!needsMigration) {
    const existingCats = await db.getAll('financeCategories');
    if (!existingCats.length) {
      const tx = db.transaction(['financeCategories', META_STORE], 'readwrite');
      await Promise.all([
        ...buildDefaultCategories().map(c => tx.objectStore('financeCategories').put(c)),
        tx.objectStore(META_STORE).put(true, 'financeMigratedV1')
      ]);
      await tx.done;
    } else {
      await db.put(META_STORE, true, 'financeMigratedV1');
    }
    return;
  }

  const categoryByName = new Map<string, FinanceCategory>();
  for (const c of buildDefaultCategories()) categoryByName.set(c.name.toLowerCase(), c);
  const accountByName = new Map<string, FinanceAccount>();
  let order = DEFAULT_CATEGORY_DEFS.length;

  for (const t of legacy) {
    const catName = (String(t.category || '').trim() || 'Miscellaneous');
    if (!categoryByName.has(catName.toLowerCase())) {
      categoryByName.set(catName.toLowerCase(), makeRecord<FinanceCategory>({
        name: catName, kind: t.kind === 'Income' ? 'income' : 'expense',
        color: CATEGORY_PALETTE[order % CATEGORY_PALETTE.length], icon: 'Circle', order
      }));
      order += 1;
    }
    const accName = (String(t.account || '').trim() || 'Main Account');
    if (!accountByName.has(accName.toLowerCase())) {
      accountByName.set(accName.toLowerCase(), makeRecord<FinanceAccount>({ name: accName, type: 'Checking', balance: 0, status: 'Active' }));
    }
  }

  const rewritten: Transaction[] = legacy.map(t => {
    const catName = (String(t.category || '').trim() || 'Miscellaneous');
    const accName = (String(t.account || '').trim() || 'Main Account');
    const cat = categoryByName.get(catName.toLowerCase())!;
    const acc = accountByName.get(accName.toLowerCase())!;
    return {
      id: t.id as string,
      createdAt: t.createdAt as string,
      updatedAt: t.updatedAt as string | undefined,
      date: t.date as string,
      merchant: String(t.description || t.category || 'Transaction'),
      amount: t.amount as number,
      accountId: acc.id,
      type: t.kind === 'Income' ? 'Income' : 'Expense',
      categoryId: cat.id,
      tags: [],
      recurring: false,
      transfer: false
    };
  });

  for (const acc of accountByName.values()) {
    const total = rewritten
      .filter(r => r.accountId === acc.id)
      .reduce((sum, r) => sum + (r.type === 'Income' ? r.amount : -r.amount), 0);
    acc.balance = Math.round(total * 100) / 100;
  }

  const tx = db.transaction(['transactions', 'financeAccounts', 'financeCategories', META_STORE], 'readwrite');
  await Promise.all([
    ...rewritten.map(r => tx.objectStore('transactions').put(r)),
    ...Array.from(accountByName.values()).map(a => tx.objectStore('financeAccounts').put(a)),
    ...Array.from(categoryByName.values()).map(c => tx.objectStore('financeCategories').put(c)),
    tx.objectStore(META_STORE).put(true, 'financeMigratedV1')
  ]);
  await tx.done;
}

async function migrateBudgetsV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'budgetsMigratedV1');
  if (done) return;

  const legacy = (await db.getAll('budgets')) as unknown as Array<Record<string, unknown>>;
  const needsMigration = legacy.some(b => !('categoryId' in b));

  if (!needsMigration) {
    await db.put(META_STORE, true, 'budgetsMigratedV1');
    return;
  }

  const existingCats = await db.getAll('financeCategories') as FinanceCategory[];
  const categoryByName = new Map<string, FinanceCategory>();
  for (const c of existingCats) categoryByName.set(c.name.toLowerCase(), c);
  const newCats: FinanceCategory[] = [];
  let order = existingCats.length;

  const rewritten: Budget[] = legacy.map(b => {
    const catName = (String(b.category || '').trim() || 'Miscellaneous');
    let cat = categoryByName.get(catName.toLowerCase());
    if (!cat) {
      cat = makeRecord<FinanceCategory>({
        name: catName, kind: 'expense', icon: 'Circle',
        color: CATEGORY_PALETTE[order % CATEGORY_PALETTE.length], order
      });
      order += 1;
      categoryByName.set(catName.toLowerCase(), cat);
      newCats.push(cat);
    }
    return {
      id: b.id as string,
      createdAt: b.createdAt as string,
      updatedAt: b.updatedAt as string | undefined,
      categoryId: cat.id,
      month: b.month as string,
      limit: b.limit as number,
      rolloverEnabled: false
    };
  });

  const tx = db.transaction(['budgets', 'financeCategories', META_STORE], 'readwrite');
  await Promise.all([
    ...rewritten.map(r => tx.objectStore('budgets').put(r)),
    ...newCats.map(c => tx.objectStore('financeCategories').put(c)),
    tx.objectStore(META_STORE).put(true, 'budgetsMigratedV1')
  ]);
  await tx.done;
}

// Categories created before `budgetGroup` existed on the default set (Phase 1 installs,
// or any migrated free-text category) never got backfilled — 50/30/20 relies on it, so
// fill in the gap for anything whose name matches a known default.
async function backfillCategoryBudgetGroups(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'categoryBudgetGroupBackfilledV1');
  if (done) return;

  const defByName = new Map(DEFAULT_CATEGORY_DEFS.map(d => [d.name.toLowerCase(), d]));
  const categories = await db.getAll('financeCategories') as FinanceCategory[];
  const toUpdate = categories
    .filter(c => !c.budgetGroup && defByName.has(c.name.toLowerCase()))
    .map(c => ({ ...c, budgetGroup: defByName.get(c.name.toLowerCase())!.budgetGroup }))
    .filter(c => c.budgetGroup);

  const tx = db.transaction(['financeCategories', META_STORE], 'readwrite');
  await Promise.all([
    ...toUpdate.map(c => tx.objectStore('financeCategories').put(c)),
    tx.objectStore(META_STORE).put(true, 'categoryBudgetGroupBackfilledV1')
  ]);
  await tx.done;
}

// Bills and subscriptions were unified into one collection distinguished by `kind`;
// records written before that change have no `kind` and should be treated as bills.
async function backfillRecurringKindV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'recurringKindBackfilledV1');
  if (done) return;

  const bills = await db.getAll('bills') as Bill[];
  const toUpdate = bills.filter(b => !b.kind).map(b => ({ ...b, kind: 'Bill' as const }));

  const tx = db.transaction(['bills', META_STORE], 'readwrite');
  await Promise.all([
    ...toUpdate.map(b => tx.objectStore('bills').put(b)),
    tx.objectStore(META_STORE).put(true, 'recurringKindBackfilledV1')
  ]);
  await tx.done;
}

// 'On Hold' and 'Abandoned' were retired from VideogameStatus — any game left in one
// of those states falls back to 'To Play' rather than becoming an invalid value.
async function migrateVideogameStatusV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'videogameStatusMigratedV1');
  if (done) return;

  const games = await db.getAll('videogames') as Videogame[];
  const retired = new Set(['On Hold', 'Abandoned']);
  const toUpdate = games
    .filter(g => retired.has(g.status))
    .map(g => ({ ...g, status: 'To Play' as const }));

  const tx = db.transaction(['videogames', META_STORE], 'readwrite');
  await Promise.all([
    ...toUpdate.map(g => tx.objectStore('videogames').put(g)),
    tx.objectStore(META_STORE).put(true, 'videogameStatusMigratedV1')
  ]);
  await tx.done;
}

// Sleep quality moved from a 1-5 scale to 1-10 — doubles any existing value so past entries
// keep the same relative meaning (a "4 out of 5" night reads as "8 out of 10") instead of
// suddenly looking half as good under the new scale's label.
async function migrateSleepQualityScaleV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'sleepQualityScaleMigratedV1');
  if (done) return;

  const entries = await db.getAll('sleepEntries') as SleepEntry[];
  const toUpdate = entries
    .filter(e => e.quality != null && e.quality <= 5)
    .map(e => ({ ...e, quality: Math.min(10, e.quality! * 2) }));

  const tx = db.transaction(['sleepEntries', META_STORE], 'readwrite');
  await Promise.all([
    ...toUpdate.map(e => tx.objectStore('sleepEntries').put(e)),
    tx.objectStore(META_STORE).put(true, 'sleepQualityScaleMigratedV1')
  ]);
  await tx.done;
}

// Exercise logs moved off RoutineExercise onto a flat, exerciseId-keyed array on the routine
// (so log history survives structural edits), and days moved under a dated `versions` list
// (so structural edits only apply going forward from whichever date they were made on).
async function migrateWorkoutRoutineVersionsV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'workoutRoutineVersionsMigratedV1');
  if (done) return;

  const legacy = (await db.getAll('workoutRoutines')) as unknown as Array<Record<string, unknown>>;
  const toMigrate = legacy.filter(r => !('versions' in r) && Array.isArray(r.days));

  const rewritten: WorkoutRoutine[] = toMigrate.map(r => {
    const exerciseLogs: ExerciseSetLog[] = [];
    const days = (r.days as Array<Record<string, unknown>>).map(d => ({
      ...d,
      exercises: (d.exercises as Array<Record<string, unknown>>).map(e => {
        const { log, ...rest } = e;
        for (const entry of (log as Array<Record<string, unknown>> | undefined) ?? []) {
          exerciseLogs.push({ exerciseId: rest.id as string, date: entry.date as string, weights: entry.weights as (number | undefined)[], lastReps: entry.lastReps as number | undefined });
        }
        return rest;
      })
    })) as unknown as RoutineDay[];
    const { days: _oldDays, ...rest } = r;
    return { ...rest, versions: [{ effectiveFrom: ROUTINE_EPOCH, days }], exerciseLogs } as WorkoutRoutine;
  });

  const tx = db.transaction(['workoutRoutines', META_STORE], 'readwrite');
  await Promise.all([
    ...rewritten.map(r => tx.objectStore('workoutRoutines').put(r)),
    tx.objectStore(META_STORE).put(true, 'workoutRoutineVersionsMigratedV1')
  ]);
  await tx.done;
}

// Trading Journal used to live entirely in three page-local `localStorage` keys, never routed
// through IndexedDB/AppData at all — which is exactly why it was the one collection Export,
// Import, and Drive sync all silently skipped. This carries whatever's sitting in those keys
// into the real `dailyLogs` store and the two new Settings fields, once, on whichever device
// opens the app first after this shipped. The old localStorage keys are left in place afterward
// rather than cleared — harmless dead weight if the migration succeeded, a safety net if it
// somehow didn't reach every entry.
async function migrateTradingJournalV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'tradingJournalMigratedV1');
  if (done) return;
  if (typeof window === 'undefined') return;

  try {
    const rawLogs = window.localStorage.getItem('life-os-trading-journal-daily-v1');
    const legacy = rawLogs ? (JSON.parse(rawLogs) as Array<Record<string, unknown>>) : [];
    const existing = await db.getAll('dailyLogs') as DailyLog[];
    const existingIds = new Set(existing.map(l => l.id));

    const rewritten: DailyLog[] = legacy
      .filter(l => typeof l.id === 'string' && !existingIds.has(l.id as string))
      .map(l => {
        // The legacy shape never had timestamps at all — anchoring to the log's own trading
        // date (rather than "now") keeps a year-old entry from suddenly looking like it was
        // just edited, which matters once this is compared against another device's copy.
        const anchor = typeof l.date === 'string' && l.date ? `${l.date}T12:00:00.000Z` : new Date().toISOString();
        return { ...l, createdAt: anchor, updatedAt: anchor } as DailyLog;
      });

    const rawBalance = window.localStorage.getItem('life-os-trading-journal-balance-v1');
    const rawLabels = window.localStorage.getItem('life-os-trading-journal-labels-v1');
    const settings = (await db.get(META_STORE, 'settings')) as Settings | undefined;
    const settingsPatch: Partial<Settings> = {};
    if (rawBalance != null && settings?.tradingStartBalance == null) {
      const n = JSON.parse(rawBalance) as number;
      if (typeof n === 'number' && Number.isFinite(n)) settingsPatch.tradingStartBalance = n;
    }
    if (rawLabels != null && settings?.tradingPresetLabels == null) {
      const arr = JSON.parse(rawLabels) as string[];
      if (Array.isArray(arr)) settingsPatch.tradingPresetLabels = arr;
    }

    const tx = db.transaction(['dailyLogs', META_STORE], 'readwrite');
    await Promise.all([
      ...rewritten.map(l => tx.objectStore('dailyLogs').put(l)),
      Object.keys(settingsPatch).length
        ? tx.objectStore(META_STORE).put({ ...settings, ...settingsPatch }, 'settings')
        : Promise.resolve(),
      tx.objectStore(META_STORE).put(true, 'tradingJournalMigratedV1')
    ]);
    await tx.done;
  } catch {
    // A malformed value in one of the old keys shouldn't block the app from loading — leave the
    // flag unset so this is retried next launch rather than silently giving up forever.
  }
}

// Deep, key-order-independent stringify — two structurally-identical objects always produce the
// same string, regardless of the order their fields happened to be written in at each call site.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Content fingerprint for a record, ignoring the fields that are *expected* to differ between
// two otherwise-identical copies: identity (id/createdAt/updatedAt) and, for habits, `checkins` —
// two duplicate copies of the same seed habit may have picked up different real check-ins on
// their respective devices before anyone noticed the duplication, so that field is unioned back
// together separately rather than used to tell copies apart.
function seedContentKey(record: Record<string, unknown>): string {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, checkins: _checkins, ...rest } = record;
  return stableStringify(rest);
}

// One-time cleanup for the fresh-seed-then-sync duplication bug fixed by buildSeedData() now
// using deterministic ids (see `seed()` above): before that fix, every device that seeded its own
// fresh install minted the *same* seed content under a *different* random id, and Drive sync's
// per-id dedup had no way to recognize them as one record — each sync round permanently kept
// every copy. This finds any stored record whose content exactly matches one of this app's own
// hardcoded seed records (a real user's own data essentially never coincidentally matches this
// app's specific placeholder text) and collapses every duplicate found down to one, under the
// canonical deterministic id, unioning habit check-ins across copies rather than picking one
// arbitrarily. Tombstones the removed ids so the cleanup propagates to every other device the
// next time each one syncs, instead of Drive resurrecting the duplicates right back.
async function dedupeLegacySeedDuplicatesV1(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'seedDuplicatesDedupedV1');
  if (done) return;

  const canonical = buildSeedData();
  const tombstones: Tombstone[] = [];
  const deletedAt = new Date().toISOString();

  for (const name of COLLECTION_NAMES) {
    const canonicalRecords = canonical[name] as CollectionRecord[];
    if (!canonicalRecords.length) continue;
    const canonicalByKey = new Map<string, CollectionRecord>();
    for (const r of canonicalRecords) canonicalByKey.set(seedContentKey(r as unknown as Record<string, unknown>), r);

    const stored = await db.getAll(name) as CollectionRecord[];
    const groups = new Map<string, CollectionRecord[]>();
    for (const r of stored) {
      const key = seedContentKey(r as unknown as Record<string, unknown>);
      if (!canonicalByKey.has(key)) continue; // doesn't match any known seed record — real user data, leave it alone
      const arr = groups.get(key) ?? [];
      arr.push(r);
      groups.set(key, arr);
    }
    if (!groups.size) continue;

    const tx = db.transaction([name, META_STORE], 'readwrite');
    for (const [key, matches] of groups) {
      const canonicalId = canonicalByKey.get(key)!.id;
      const checkinsUnion = matches.some(m => Array.isArray((m as unknown as Record<string, unknown>).checkins))
        ? Array.from(new Set(matches.flatMap(m => ((m as unknown as Record<string, unknown>).checkins as string[] | undefined) ?? []))).sort()
        : undefined;
      const consolidated = {
        ...matches[0],
        ...(checkinsUnion ? { checkins: checkinsUnion } : {}),
        id: canonicalId,
        createdAt: matches.map(m => m.createdAt).sort()[0],
        updatedAt: matches.map(m => m.updatedAt ?? m.createdAt).sort().slice(-1)[0]
      } as CollectionRecord;

      await tx.objectStore(name).put(consolidated);
      for (const m of matches) {
        if (m.id === canonicalId) continue;
        await tx.objectStore(name).delete(m.id);
        tombstones.push({ collection: name, id: m.id, deletedAt });
      }
    }
    await tx.done;
  }

  if (tombstones.length) {
    const existing = ((await db.get(META_STORE, TOMBSTONES_KEY)) ?? []) as Tombstone[];
    await db.put(META_STORE, [...existing, ...tombstones], TOMBSTONES_KEY);
  }
  await db.put(META_STORE, true, 'seedDuplicatesDedupedV1');
}

// V1 above only collapsed habits whose stored content matched a canonical seed record *exactly*
// — deliberately conservative, so it could never mistake a real user record for a duplicate. In
// practice, plenty of the duplicated habits had already drifted slightly since being created
// (a different `order` after being dragged in the list, or some other field nudged by unrelated
// code), so V1 quietly left them all standing rather than risk a wrong guess: seen on a real
// account, it took a 73-habit pileup down to 47, not 13. This pass is looser but still safe: this
// app never seeds two habits with the same name, and a real user creating two genuinely distinct
// habits that happen to share that exact name is effectively unheard of — so any group of stored
// habits sharing a seed habit's name is treated as duplicates of that one logical habit, whatever
// else about them has drifted.
async function dedupeLegacySeedDuplicatesV2(db: IDBPDatabase): Promise<void> {
  const done = await db.get(META_STORE, 'seedDuplicatesDedupedV2');
  if (done) return;

  const canonical = buildSeedData();
  const canonicalHabitIdByName = new Map<string, string>();
  for (const h of canonical.habits) canonicalHabitIdByName.set(h.name, h.id);

  const storedHabits = await db.getAll('habits') as Habit[];
  const groups = new Map<string, Habit[]>();
  for (const h of storedHabits) {
    if (!canonicalHabitIdByName.has(h.name)) continue; // not a known seed habit name — real user habit, leave alone
    const arr = groups.get(h.name) ?? [];
    arr.push(h);
    groups.set(h.name, arr);
  }

  const tombstones: Tombstone[] = [];
  const deletedAt = new Date().toISOString();

  if (groups.size) {
    const tx = db.transaction(['habits', META_STORE], 'readwrite');
    for (const [name, matches] of groups) {
      const canonicalId = canonicalHabitIdByName.get(name)!;
      if (matches.length === 1 && matches[0].id === canonicalId) continue; // already correct

      // Whichever copy was edited most recently wins for fields that might carry a real
      // intentional edit (reminder time, order, active, etc.); check-ins are unioned across every
      // copy instead, so a check-off recorded on any duplicate is never lost in the consolidation.
      const mostRecent = [...matches].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))[0];
      const checkinsUnion = Array.from(new Set(matches.flatMap(m => m.checkins ?? []))).sort();

      const consolidated: Habit = {
        ...mostRecent,
        id: canonicalId,
        checkins: checkinsUnion,
        createdAt: matches.map(m => m.createdAt).sort()[0],
        updatedAt: matches.map(m => m.updatedAt ?? m.createdAt).sort().slice(-1)[0]
      };

      await tx.objectStore('habits').put(consolidated);
      for (const m of matches) {
        if (m.id === canonicalId) continue;
        await tx.objectStore('habits').delete(m.id);
        tombstones.push({ collection: 'habits', id: m.id, deletedAt });
      }
    }
    await tx.done;
  }

  if (tombstones.length) {
    const existing = ((await db.get(META_STORE, TOMBSTONES_KEY)) ?? []) as Tombstone[];
    await db.put(META_STORE, [...existing, ...tombstones], TOMBSTONES_KEY);
  }
  await db.put(META_STORE, true, 'seedDuplicatesDedupedV2');
}

let loadPromise: Promise<AppData> | null = null;

// React StrictMode double-invokes effects in dev, which would otherwise race two
// concurrent loadAll() calls into running the one-time migration/seed logic twice.
// A module-level in-flight promise makes concurrent callers share the same run.
export function loadAll(): Promise<AppData> {
  if (!loadPromise) {
    loadPromise = loadAllInternal().finally(() => { loadPromise = null; });
  }
  return loadPromise;
}

async function loadAllInternal(): Promise<AppData> {
  const db = await getDb();
  const seeded = await db.get(META_STORE, 'seeded');
  if (!seeded) {
    const seedData = buildSeedData();
    await writeAll(db, seedData);
    await db.put(META_STORE, true, 'seeded');
    await db.put(META_STORE, true, 'financeMigratedV1');
    await db.put(META_STORE, true, 'budgetsMigratedV1');
    await db.put(META_STORE, true, 'categoryBudgetGroupBackfilledV1');
    await db.put(META_STORE, true, 'recurringKindBackfilledV1');
    await db.put(META_STORE, true, 'videogameStatusMigratedV1');
    await db.put(META_STORE, true, 'workoutRoutineVersionsMigratedV1');
    await db.put(META_STORE, true, 'sleepQualityScaleMigratedV1');
    await db.put(META_STORE, true, 'tradingJournalMigratedV1');
    // A brand-new install seeds directly from the now-deterministic-id buildSeedData() — there's
    // nothing to have duplicated yet, so there's nothing for either cleanup pass to do.
    await db.put(META_STORE, true, 'seedDuplicatesDedupedV1');
    await db.put(META_STORE, true, 'seedDuplicatesDedupedV2');
    return seedData;
  }
  await migrateFinanceV1(db);
  await migrateBudgetsV1(db);
  await backfillCategoryBudgetGroups(db);
  await backfillRecurringKindV1(db);
  await migrateVideogameStatusV1(db);
  await migrateWorkoutRoutineVersionsV1(db);
  await migrateSleepQualityScaleV1(db);
  await migrateTradingJournalV1(db);
  await dedupeLegacySeedDuplicatesV1(db);
  await dedupeLegacySeedDuplicatesV2(db);
  return readAllCollections(db);
}

export async function putRecord(collection: CollectionName, record: CollectionRecord): Promise<void> {
  const db = await getDb();
  await db.put(collection, record);
}

export async function deleteRecord(collection: CollectionName, id: string): Promise<void> {
  const db = await getDb();
  await db.delete(collection, id);
}

function pruneTombstoneList(list: Tombstone[]): Tombstone[] {
  const cutoff = Date.now() - TOMBSTONE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return list.filter(t => new Date(t.deletedAt).getTime() >= cutoff);
}

// A hard `delete` leaves no trace a sync merge could use to tell "never synced this record
// yet" apart from "this was deleted after the last sync" — both look like a gap in the data.
// This is what fills that gap: called alongside every `deleteRecord`, never instead of it, so
// local reads/writes stay exactly as fast as before.
export async function addTombstones(collection: CollectionName, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  const existing = ((await db.get(META_STORE, TOMBSTONES_KEY)) ?? []) as Tombstone[];
  const idSet = new Set(ids);
  const deletedAt = new Date().toISOString();
  const kept = pruneTombstoneList(existing).filter(t => !(t.collection === collection && idSet.has(t.id)));
  for (const id of ids) kept.push({ collection, id, deletedAt });
  await db.put(META_STORE, kept, TOMBSTONES_KEY);
}

export async function addTombstone(collection: CollectionName, id: string): Promise<void> {
  await addTombstones(collection, [id]);
}

// The other half of the reconciliation: undo/redo restore a deleted record by writing the old
// collection array straight back (`replaceCollection`), not through `deleteRecord`/`putRecord`
// — so a delete's tombstone has to be cleared explicitly here, or a sync after an undo would
// see "record exists, but there's a newer tombstone for it" and delete it right back out from
// under the user on every other device.
export async function clearTombstones(collection: CollectionName, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await getDb();
  const existing = ((await db.get(META_STORE, TOMBSTONES_KEY)) ?? []) as Tombstone[];
  const idSet = new Set(ids);
  const next = pruneTombstoneList(existing).filter(t => !(t.collection === collection && idSet.has(t.id)));
  await db.put(META_STORE, next, TOMBSTONES_KEY);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const db = await getDb();
  await db.put(META_STORE, settings, 'settings');
  await db.put(META_STORE, new Date().toISOString(), SETTINGS_UPDATED_AT_KEY);
}

// The read/write pair a sync transport actually moves. `getSyncSnapshot` never mutates state —
// safe to call speculatively before knowing whether there's anything to sync against.
export async function getSyncSnapshot(): Promise<SyncSnapshot> {
  const db = await getDb();
  const data = await readAllCollections(db);
  const tombstones = pruneTombstoneList(((await db.get(META_STORE, TOMBSTONES_KEY)) ?? []) as Tombstone[]);
  const settingsUpdatedAt = ((await db.get(META_STORE, SETTINGS_UPDATED_AT_KEY)) as string | undefined) ?? new Date(0).toISOString();
  return { data, tombstones, settingsUpdatedAt };
}

// Writes an already-merged snapshot back to IndexedDB. Distinct from `replaceAll` (which backs
// the JSON-file import/restore flow and has no concept of tombstones) even though both end up
// calling the same clear-and-rewrite `writeAll` — this one also persists the merge's tombstone
// and settings-timestamp state, which import/restore deliberately doesn't touch.
export async function applySyncSnapshot(snapshot: SyncSnapshot): Promise<void> {
  const db = await getDb();
  await writeAll(db, snapshot.data);
  await db.put(META_STORE, snapshot.tombstones, TOMBSTONES_KEY);
  await db.put(META_STORE, snapshot.settingsUpdatedAt, SETTINGS_UPDATED_AT_KEY);
  await db.put(META_STORE, true, 'seeded');
}

export async function replaceAll(data: AppData): Promise<void> {
  const db = await getDb();
  await writeAll(db, data);
  await db.put(META_STORE, true, 'seeded');
}

export async function replaceCollection(collection: CollectionName, records: CollectionRecord[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(collection, 'readwrite');
  const store = tx.objectStore(collection);
  await store.clear();
  for (const record of records) await store.put(record);
  await tx.done;
}

export async function resetToSeed(): Promise<AppData> {
  const db = await getDb();
  const seed = buildSeedData();
  await writeAll(db, seed);
  await db.put(META_STORE, true, 'seeded');
  return seed;
}

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Every seed record gets a stable, deterministic id (via `seed()` below) instead of makeRecord's
// usual random one. Without this, two devices that each seed their own fresh install — before
// either has synced in real data — mint the *same* 13 habits (etc.) under two different random
// ids, and Google Drive sync's per-id dedup has no way to recognize them as the same record: it
// just keeps both, forever, compounding on every fresh-seed-then-sync. Deterministic ids mean
// the same logical seed record always lands on the same id no matter which device produced it,
// so it merges as one record like it should. See dedupeLegacySeedDuplicatesV1 for cleaning up
// duplicates that already happened before this fix.
let seedIdCounter = 0;
function seed<T extends BaseRecord>(fields: Partial<T>): T {
  return makeRecord<T>({ id: `seed-${seedIdCounter++}`, ...fields } as Partial<T>);
}

function buildSeedData(): AppData {
  seedIdCounter = 0;
  const data = emptyData();
  data.settings = { ...DEFAULT_SETTINGS, userName: 'Khuong' };

  data.tasks = [
    seed<Task>({ title: 'Review weekly budget', status: 'Not Started', priority: 'High', dueDate: iso(-1), category: 'Finance' }),
    seed<Task>({ title: 'Plan trip itinerary', status: 'Not Started', priority: 'Medium', dueDate: iso(0), category: 'Personal' }),
    seed<Task>({ title: 'Ship Life OS v1', status: 'In Progress', priority: 'Urgent', dueDate: iso(2), project: 'Life OS' }),
    seed<Task>({ title: 'Call the dentist', status: 'Not Started', priority: 'Low', dueDate: iso(5), category: 'Health' })
  ];

  data.habits = [
    seed<Habit>({ name: 'Wake Up', description: 'One focused action can change the direction of your whole day.', frequency: 'Daily', checkins: ['2026-08-04', '2026-08-05'], active: true, reminderAt: '06:00', order: 0, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Work Out', description: 'Do it with purpose, even when it feels small.', frequency: 'Daily', checkins: ['2026-08-05'], active: true, reminderAt: '06:15', order: 1, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Shower', description: 'Your habits are votes for the person you are becoming.', frequency: 'Daily', checkins: [], active: true, reminderAt: '07:15', order: 2, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Read', description: 'Consistency turns ordinary effort into extraordinary results.', frequency: 'Daily', checkins: [], active: true, reminderAt: '07:30', order: 3, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Trading Setup', description: 'Keep the promise you made to yourself.', frequency: 'Weekdays', checkins: ['2026-08-03', '2026-08-04', '2026-08-05'], active: true, reminderAt: '08:10', order: 4, targetPerWeek: 5 }),
    seed<Habit>({ name: 'Day Trading', description: 'Let purpose lead and discipline carry you forward.', frequency: 'Weekdays', checkins: ['2026-08-03', '2026-08-04', '2026-08-05'], active: true, reminderAt: '08:30', order: 5, targetPerWeek: 5 }),
    seed<Habit>({ name: 'WIFE', description: 'Build quietly; the results will speak for you.', frequency: 'Daily', checkins: ['2026-08-05'], active: true, reminderAt: '10:30', order: 6, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Lunch', description: 'Show up today; your future self is counting on you.', frequency: 'Daily', checkins: ['2026-08-05'], active: true, reminderAt: '12:30', order: 7, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Deep Work', description: 'Small wins, repeated daily, become a powerful life.', frequency: 'Weekdays', checkins: ['2026-08-05'], active: true, reminderAt: '13:00', order: 8, targetPerWeek: 5 }),
    seed<Habit>({ name: 'Gaming', description: 'Choose the action that makes you proud tonight.', frequency: 'Daily', checkins: ['2026-08-03', '2026-08-04'], active: true, reminderAt: '18:00', order: 9, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Relax', description: 'Your habits are votes for the person you are becoming.', frequency: 'Daily', checkins: ['2026-08-03', '2026-08-04', '2026-08-05'], active: true, reminderAt: '20:30', order: 10, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Read Bible', description: 'Begin with courage and finish with consistency.', frequency: 'Daily', checkins: ['2026-08-05'], active: true, reminderAt: '21:30', order: 11, targetPerWeek: 7 }),
    seed<Habit>({ name: 'Sleep', description: 'Today is another chance to strengthen your standard.', frequency: 'Daily', checkins: ['2026-08-05'], active: true, reminderAt: '23:00', order: 12, targetPerWeek: 7 })
  ];

  const annualHealth = seed<Goal>({ title: 'Get healthier', horizon: 'Annual', category: 'Health', progress: 60, status: 'In Progress', targetDate: '2026-12-31' });
  const annualCareer = seed<Goal>({ title: 'Advance my career', horizon: 'Annual', category: 'Career', progress: 25, status: 'In Progress', targetDate: '2026-12-31' });
  const quarterlyHealth = seed<Goal>({ title: 'Build a consistent workout habit', horizon: 'Quarterly', category: 'Health', progress: 60, status: 'In Progress', targetDate: '2026-09-30', parentId: annualHealth.id });
  const quarterlyCareer = seed<Goal>({ title: 'Lead a major project at work', horizon: 'Quarterly', category: 'Career', progress: 25, status: 'On Track', targetDate: '2026-09-30', parentId: annualCareer.id });
  const monthlyHealth = seed<Goal>({ title: 'Work out 4x per week this month', horizon: 'Monthly', category: 'Health', progress: 60, status: 'In Progress', targetDate: '2026-07-31', parentId: quarterlyHealth.id });
  const monthlyCareer = seed<Goal>({ title: 'Finish project scoping', horizon: 'Monthly', category: 'Career', progress: 25, status: 'In Progress', targetDate: '2026-07-31', parentId: quarterlyCareer.id });
  const weeklyHealth = seed<Goal>({ title: 'Hit the gym Mon / Wed / Fri this week', horizon: 'Weekly', category: 'Health', progress: 60, status: 'In Progress', targetDate: '2026-07-26', parentId: monthlyHealth.id });
  const weeklyCareer = seed<Goal>({ title: 'Draft the project brief', horizon: 'Weekly', category: 'Career', progress: 25, status: 'In Progress', targetDate: '2026-07-26', parentId: monthlyCareer.id });
  data.goals = [weeklyHealth, weeklyCareer, monthlyHealth, monthlyCareer, quarterlyHealth, quarterlyCareer, annualHealth, annualCareer];

  data.events = [
    seed<CalendarEvent>({ title: 'Team sync', date: iso(0), startTime: '10:00', endTime: '10:30' }),
    seed<CalendarEvent>({ title: 'Dentist appointment', date: iso(5), startTime: '14:00' })
  ];

  const seedCategories = buildDefaultCategories();
  const catByName = (n: string) => seedCategories.find(c => c.name === n)!;
  const seedAccount = seed<FinanceAccount>({
    name: 'Everyday Checking', type: 'Checking', institution: 'Chase', balance: 4381.24, status: 'Active'
  });
  data.financeCategories = seedCategories;
  data.financeAccounts = [seedAccount];

  data.budgets = [
    seed<Budget>({ categoryId: catByName('Groceries').id, month: iso(0).slice(0, 7), limit: 500, rolloverEnabled: true }),
    seed<Budget>({ categoryId: catByName('Dining Out').id, month: iso(0).slice(0, 7), limit: 200, rolloverEnabled: false })
  ];

  data.transactions = [
    seed<Transaction>({ date: iso(-3), merchant: 'Paycheck', amount: 4200, accountId: seedAccount.id, type: 'Income', categoryId: catByName('Salary').id }),
    seed<Transaction>({ date: iso(-2), merchant: 'Trader Joes', amount: 86.42, accountId: seedAccount.id, type: 'Expense', categoryId: catByName('Groceries').id }),
    seed<Transaction>({ date: iso(-1), merchant: 'Lunch', amount: 34.5, accountId: seedAccount.id, type: 'Expense', categoryId: catByName('Dining Out').id })
  ];

  data.bills = [
    seed<Bill>({ name: 'Rent', amount: 1800, nextDue: iso(10), frequency: 'Monthly', autopay: true, kind: 'Bill' }),
    seed<Bill>({ name: 'Internet', amount: 65, nextDue: iso(12), frequency: 'Monthly', autopay: true, kind: 'Bill' }),
    seed<Bill>({ name: 'Netflix', amount: 15.99, nextDue: iso(20), frequency: 'Monthly', autopay: true, kind: 'Subscription', usageRating: 4 })
  ];

  data.movies = [
    seed<Movie>({
      title: 'Dune: Part Two', mediaType: 'Movie', director: 'Denis Villeneuve', releaseYear: 2024,
      genres: ['Sci-Fi', 'Drama'], runtimeMin: 166, status: 'To Watch', whereToWatch: ['Theater']
    })
  ];

  data.videogames = [
    seed<Videogame>({
      title: "Baldur's Gate 3", developer: 'Larian Studios', platforms: ['PC'],
      genre: ['RPG'], status: 'Playing', rating: 5, playtimeHours: 40, multiplayer: true
    })
  ];

  data.books = [
    seed<Book>({
      title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', format: 'Physical',
      genre: ['Non-Fiction'], pageCount: 616, status: 'Reading', rating: 4, progress: 45
    })
  ];

  const welcomeNote = seed<Note>({
    title: 'Welcome to your Second Brain',
    body:
      'This is a place to capture notes, ideas, and knowledge for later.\n\n' +
      'Type [[Note Title]] anywhere in a note to link it to another note — linked notes ' +
      'show up as "Linked mentions" at the bottom of whichever note they point to. Try it ' +
      'by opening [[Life OS Ideas]].\n\nUse tags to group related notes, and pin the ones you ' +
      'want to keep at the top of the list.',
    tags: ['meta'],
    pinned: true
  });
  const ideasNote = seed<Note>({
    title: 'Life OS Ideas',
    body:
      'Random ideas for Life OS, captured as they come up:\n\n' +
      '- Weekly review ritual tied to [[Welcome to your Second Brain]]\n' +
      '- Auto-tagging notes based on content\n' +
      '- Graph view of note links',
    tags: ['life-os', 'ideas']
  });
  data.notes = [welcomeNote, ideasNote];

  data.bucketList = [
    seed<BucketListItem>({
      title: 'Hike Machu Picchu', category: 'Travel', status: 'Someday',
      location: 'Peru', costTier: '$$$',
      coverArt: 'https://images.unsplash.com/photo-1526392060635-9d6019884377?w=800',
      notes: 'Multi-day trek along the Inca Trail, ending at sunrise over the ruins.'
    }),
    seed<BucketListItem>({
      title: 'Run a half marathon', category: 'Experience', status: 'Planning',
      costTier: '$', targetDate: iso(120),
      coverArt: 'https://images.unsplash.com/photo-1552674605-db6ffd4facb5?w=800',
      notes: 'First half marathon — building up from the 10K training block.',
      subtasks: [
        { id: 'seed-subtask-0', text: 'Pick a race and register', done: true },
        { id: 'seed-subtask-1', text: 'Build a 12-week training plan', done: true },
        { id: 'seed-subtask-2', text: 'Run a 15K training run', done: false },
        { id: 'seed-subtask-3', text: 'Break in race-day shoes', done: false }
      ]
    }),
    seed<BucketListItem>({
      title: 'Learn to make sourdough bread', category: 'Skill', status: 'Achieved',
      costTier: '$',
      coverArt: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800',
      subtasks: [
        { id: 'seed-subtask-4', text: 'Grow a starter from scratch', done: true },
        { id: 'seed-subtask-5', text: 'Bake a loaf that actually rises', done: true }
      ],
      achievedAt: iso(-14),
      memoryPhotos: ['https://images.unsplash.com/photo-1585478259715-4d3a5f3e9a3a?w=800'],
      reflection: 'Took four dense, sad loaves before one finally opened up properly. Worth every failed attempt.'
    })
  ];

  data.workouts = [
    seed<WorkoutEntry>({ date: iso(-6), type: 'Run', durationMin: 32, avgHr: 152, maxHr: 171, caloriesBurned: 340, rpe: 6, notes: 'Easy morning loop.' }),
    seed<WorkoutEntry>({ date: iso(-4), type: 'Strength', durationMin: 50, avgHr: 118, maxHr: 145, caloriesBurned: 280, rpe: 7, notes: 'Upper body — push day.' }),
    seed<WorkoutEntry>({ date: iso(-2), type: 'Cycling', durationMin: 45, avgHr: 140, maxHr: 168, caloriesBurned: 410, rpe: 7 }),
    seed<WorkoutEntry>({ date: iso(-1), type: 'Yoga', durationMin: 25, avgHr: 95, rpe: 3, notes: 'Recovery flow.' }),
    seed<WorkoutEntry>({ date: iso(0), type: 'Run', durationMin: 40, avgHr: 158, maxHr: 176, caloriesBurned: 420, rpe: 8, notes: 'Tempo intervals.' })
  ];

  const startWeight = 186;
  data.weightEntries = [-28, -24, -21, -17, -14, -10, -7, -3, -1, 0].map((offset, i) =>
    seed<WeightEntry>({
      date: iso(offset),
      weight: Math.round((startWeight - i * 0.9 + (i % 3 === 0 ? 0.6 : -0.2)) * 10) / 10,
      bodyFatPct: i === 9 ? 19.5 : undefined
    })
  );

  data.sleepEntries = [-6, -5, -4, -3, -2, -1, 0].map(offset =>
    seed<SleepEntry>({
      date: iso(offset),
      bedTime: '22:45',
      wakeTime: '06:30',
      durationHours: [7.1, 6.4, 7.8, 6.9, 7.5, 8.1, 7.3][6 + offset],
      quality: [6, 4, 8, 6, 8, 10, 8][6 + offset],
      remHours: 1.6,
      deepHours: 1.2,
      restingHr: 58
    })
  );

  data.meals = [
    seed<MealEntry>({ date: iso(0), mealType: 'Breakfast', description: 'Greek yogurt with berries and granola', calories: 380, proteinG: 28, carbsG: 45, fatG: 9 }),
    seed<MealEntry>({ date: iso(0), mealType: 'Lunch', description: 'Grilled chicken bowl with rice and veggies', calories: 620, proteinG: 48, carbsG: 60, fatG: 18 }),
    seed<MealEntry>({ date: iso(-1), mealType: 'Dinner', description: 'Salmon, sweet potato, asparagus', calories: 590, proteinG: 42, carbsG: 38, fatG: 24 })
  ];

  data.glucoseEntries = [
    seed<GlucoseEntry>({ date: iso(-2), time: '07:15', value: 92, context: 'Fasting' }),
    seed<GlucoseEntry>({ date: iso(-1), time: '07:10', value: 88, context: 'Fasting' }),
    seed<GlucoseEntry>({ date: iso(0), time: '07:20', value: 95, context: 'Fasting' })
  ];

  data.workoutRoutines = [seed<WorkoutRoutine>(buildStarterRoutine())];

  data.medications = [
    seed<Medication>({
      name: 'Vitamin D3', dosage: '2000 IU', frequency: 'Once Daily', times: ['08:00'],
      withFood: true, pillsRemaining: 42, refillThreshold: 7, active: true,
      doseLog: [-3, -2, -1].map(offset => ({ date: iso(offset), time: '08:00', takenAt: `${iso(offset)}T08:05:00.000Z` }))
    }),
    seed<Medication>({
      name: 'Metformin', dosage: '500mg', frequency: 'Twice Daily', times: ['08:00', '20:00'],
      withFood: true, pillsRemaining: 18, refillThreshold: 10, prescriber: 'Dr. Patel', active: true,
      doseLog: [-2, -1].flatMap(offset => [
        { date: iso(offset), time: '08:00', takenAt: `${iso(offset)}T08:05:00.000Z` },
        { date: iso(offset), time: '20:00', takenAt: `${iso(offset)}T20:15:00.000Z` }
      ])
    })
  ];

  return data;
}
