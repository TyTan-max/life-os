import type { AppData, BaseRecord, CollectionName, CollectionRecord } from '../types';
import { COLLECTION_NAMES } from '../types';

// A tombstone is the one piece of information a hard `delete` doesn't leave behind: proof that
// a record with this id *used* to exist and was deliberately removed, so a merge can tell "never
// synced this yet" apart from "this was deleted after the last sync" — the two look identical
// from an empty gap in the data alone.
export interface Tombstone {
  collection: CollectionName;
  id: string;
  deletedAt: string;
}

export interface SyncSnapshot {
  data: AppData;
  tombstones: Tombstone[];
  // When settings last changed at all. Snapshots from before per-field times existed merge
  // settings as one whole block by this.
  settingsUpdatedAt: string;
  // When each setting last changed, so a change on one device (say, the target weight) doesn't
  // undo a different setting changed on another (a pay schedule): each field merges on its own.
  settingsFieldTimes?: Record<string, string>;
}

function recordTime(r: BaseRecord): string {
  return r.updatedAt ?? r.createdAt;
}

function mergeTombstones(a: Tombstone[], b: Tombstone[]): Tombstone[] {
  const byKey = new Map<string, Tombstone>();
  for (const t of [...a, ...b]) {
    const key = `${t.collection}:${t.id}`;
    const existing = byKey.get(key);
    if (!existing || t.deletedAt > existing.deletedAt) byKey.set(key, t);
  }
  return Array.from(byKey.values());
}

function mergeCollection<T extends CollectionRecord>(
  collection: CollectionName,
  local: T[],
  remote: T[],
  tombstoneAt: Map<string, string>
): T[] {
  // Per id, keep whichever *record* is newer — not whichever whole file is newer. A record
  // present on only one side (added on a device that hasn't synced yet) is kept outright; it
  // isn't a conflict, there's nothing to compare it against.
  const byId = new Map<string, T>();
  for (const r of local) byId.set(r.id, r);
  for (const r of remote) {
    const existing = byId.get(r.id);
    if (!existing || recordTime(r) > recordTime(existing)) byId.set(r.id, r);
  }

  const result: T[] = [];
  for (const [id, record] of byId) {
    const deletedAt = tombstoneAt.get(`${collection}:${id}`);
    // A tombstone only wins if nothing newer than the deletion survived on either side — since
    // ids are never reused for a new record (`makeRecord` always mints a fresh one), a record
    // edited *after* its own deletion can't occur in practice; this check exists as a guard
    // against clock skew between devices, not a real editing path.
    if (deletedAt && deletedAt >= recordTime(record)) continue;
    result.push(record);
  }
  return result;
}

export function snapshotHasRecords(snapshot: SyncSnapshot): boolean {
  return COLLECTION_NAMES.some(name => (snapshot.data[name] as CollectionRecord[]).length > 0);
}

/**
 * A fresh install is filled with starter (sample) data. Syncing it against an account that
 * already has real data used to merge the samples in — and, because starter ids are the same on
 * every install, overwrite real records that began life as starter records. So before merging,
 * starter records nobody has touched (created at the seed stamp and never updated since) are
 * left out of the local side. Anything edited on this device is kept. No tombstones are made:
 * the records simply aren't offered to the merge.
 */
export function withoutUntouchedStarterData(local: SyncSnapshot, seedStamp: string): SyncSnapshot {
  const data = { ...local.data };
  for (const name of COLLECTION_NAMES) {
    (data as Record<string, unknown>)[name] = (local.data[name] as CollectionRecord[])
      .filter(r => !(r.createdAt === seedStamp && (r.updatedAt ?? r.createdAt) === seedStamp));
  }
  return { ...local, data };
}

/**
 * Starter records are minted with the same ids (`seed-N`) on every install, and real records
 * that began as starters keep those ids. So a cloud copy holding *untouched* samples (never
 * edited since they were created) must not be merged into a device that has real data: being
 * stamped newer, they'd overwrite the real records sharing their ids, or re-add samples that were
 * deleted here. They're left out of the remote side whenever this device has real data.
 */
export function withoutRemoteStarterData(remote: SyncSnapshot, local: SyncSnapshot): SyncSnapshot {
  const localHasRealData = COLLECTION_NAMES.some(name =>
    (local.data[name] as CollectionRecord[]).some(r => !isUntouchedStarter(r)));
  if (!localHasRealData) return remote;
  const data = { ...remote.data };
  for (const name of COLLECTION_NAMES) {
    const localCreated = new Map((local.data[name] as CollectionRecord[]).map(r => [r.id, r.createdAt]));
    (data as Record<string, unknown>)[name] = (remote.data[name] as CollectionRecord[]).filter(r =>
      !(isUntouchedStarter(r) && localCreated.get(r.id) !== r.createdAt));
  }
  return { ...remote, data };
}

function isUntouchedStarter(r: CollectionRecord): boolean {
  return String(r.id).startsWith('seed-') && (r.updatedAt ?? r.createdAt) === r.createdAt;
}

/** The newest change anywhere in a set of data — "when this backup was taken". */
export function latestRecordTime(data: AppData): string {
  let latest = '';
  for (const name of COLLECTION_NAMES) {
    for (const r of data[name] as CollectionRecord[]) { const t = recordTime(r); if (t > latest) latest = t; }
  }
  return latest || new Date(0).toISOString();
}

/**
 * After a backup import, the backup replaces the cloud copy *as of when the backup was taken*
 * (`asOf`): anything the cloud had back then that the backup doesn't is removed (tombstoned, so
 * other devices drop it too). But a backup can't speak for what happened after it was made — a
 * night logged on the phone yesterday isn't "missing from" last week's backup — so records
 * added, edited or deleted in the cloud after `asOf` are kept as they are.
 * "Make this the cloud copy" passes the current time as `asOf`, making it a strict replace.
 */
export function replaceRemoteWith(local: SyncSnapshot, remote: SyncSnapshot, asOf: string): SyncSnapshot {
  const now = new Date().toISOString();
  const extra: Tombstone[] = [];
  const data = { ...local.data };
  // Things deleted elsewhere after the backup was taken stay deleted.
  const laterDeletes = remote.tombstones.filter(t => t.deletedAt > asOf);
  const deletedLater = new Set(laterDeletes.map(t => `${t.collection}:${t.id}`));
  for (const name of COLLECTION_NAMES) {
    const mine = new Map((local.data[name] as CollectionRecord[]).map(r => [r.id, r]));
    for (const r of remote.data[name] as CollectionRecord[]) {
      const sample = isUntouchedStarter(r);
      const existing = mine.get(r.id);
      if (existing) {
        if (!sample && recordTime(r) > asOf && recordTime(r) > recordTime(existing)) mine.set(r.id, r); // edited since the backup
      } else if (!sample && r.createdAt > asOf) {
        mine.set(r.id, r); // added since the backup
      } else {
        extra.push({ collection: name, id: r.id, deletedAt: now });
      }
    }
    (data as Record<string, unknown>)[name] = Array.from(mine.values()).filter(r => !deletedLater.has(`${name}:${r.id}`));
  }
  // Old tombstones for records the backup has are dropped, so those records aren’t deleted again.
  const kept = new Set(COLLECTION_NAMES.flatMap(name => (data[name] as CollectionRecord[]).map(r => `${name}:${r.id}`)));
  const tombstones = mergeTombstones(
    [...local.tombstones, ...laterDeletes].filter(t => !kept.has(`${t.collection}:${t.id}`)),
    extra
  );
  return { data, tombstones, settingsUpdatedAt: now, settingsFieldTimes: local.settingsFieldTimes };
}

function mergeSettings(local: SyncSnapshot, remote: SyncSnapshot): Pick<SyncSnapshot, 'settingsUpdatedAt' | 'settingsFieldTimes'> & { settings: AppData['settings'] } {
  const localWholeNewer = local.settingsUpdatedAt >= remote.settingsUpdatedAt;
  const settingsUpdatedAt = localWholeNewer ? local.settingsUpdatedAt : remote.settingsUpdatedAt;
  const lt = local.settingsFieldTimes ?? {};
  const rt = remote.settingsFieldTimes ?? {};
  const ls = local.data.settings as unknown as Record<string, unknown>;
  const rs = remote.data.settings as unknown as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  const fieldTimes: Record<string, string> = {};
  for (const key of new Set([...Object.keys(ls), ...Object.keys(rs), ...Object.keys(lt), ...Object.keys(rt)])) {
    const a = lt[key];
    const b = rt[key];
    // A field neither side has a time for falls back to whichever block changed last.
    const useLocal = a || b ? (a ?? '') >= (b ?? '') : localWholeNewer;
    const value = useLocal ? ls[key] : rs[key];
    if (value !== undefined) settings[key] = value;
    const time = useLocal ? a : b;
    if (time) fieldTimes[key] = time;
  }
  return { settings: settings as unknown as AppData['settings'], settingsUpdatedAt, settingsFieldTimes: fieldTimes };
}

/**
 * A cheap summary of a snapshot — every record's id + last-changed time, the tombstones and the
 * settings times. Two snapshots with the same fingerprint hold the same data, so there's nothing
 * to upload.
 */
export function snapshotFingerprint(s: SyncSnapshot): string {
  const parts: string[] = [];
  for (const name of COLLECTION_NAMES) {
    const keys = (s.data[name] as CollectionRecord[]).map(r => `${r.id}@${recordTime(r)}`).sort();
    parts.push(`${name}:${keys.join(',')}`);
  }
  parts.push(`t:${s.tombstones.map(t => `${t.collection}:${t.id}@${t.deletedAt}`).sort().join(',')}`);
  const ft = s.settingsFieldTimes ?? {};
  parts.push(`s:${s.settingsUpdatedAt}|${Object.keys(ft).sort().map(k => `${k}@${ft[k]}`).join(',')}`);
  return parts.join('\n');
}

export function mergeSnapshots(local: SyncSnapshot, remote: SyncSnapshot): SyncSnapshot {
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);
  const tombstoneAt = new Map<string, string>();
  for (const t of tombstones) tombstoneAt.set(`${t.collection}:${t.id}`, t.deletedAt);

  const data = {} as AppData;
  for (const name of COLLECTION_NAMES) {
    (data as unknown as Record<string, CollectionRecord[]>)[name] =
      mergeCollection(name, local.data[name] as CollectionRecord[], remote.data[name] as CollectionRecord[], tombstoneAt);
  }

  const { settings, settingsUpdatedAt, settingsFieldTimes } = mergeSettings(local, remote);
  data.settings = settings;

  return { data, tombstones, settingsUpdatedAt, settingsFieldTimes };
}
