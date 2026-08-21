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
  // `settings` has no per-field or per-record updatedAt of its own, so it merges as a single
  // whole-object last-write-wins unit, tracked separately from the record-level timestamps
  // everything else in this file uses.
  settingsUpdatedAt: string;
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

export function mergeSnapshots(local: SyncSnapshot, remote: SyncSnapshot): SyncSnapshot {
  const tombstones = mergeTombstones(local.tombstones, remote.tombstones);
  const tombstoneAt = new Map<string, string>();
  for (const t of tombstones) tombstoneAt.set(`${t.collection}:${t.id}`, t.deletedAt);

  const data = {} as AppData;
  for (const name of COLLECTION_NAMES) {
    (data as unknown as Record<string, CollectionRecord[]>)[name] =
      mergeCollection(name, local.data[name] as CollectionRecord[], remote.data[name] as CollectionRecord[], tombstoneAt);
  }

  const localSettingsNewer = local.settingsUpdatedAt >= remote.settingsUpdatedAt;
  data.settings = localSettingsNewer ? local.data.settings : remote.data.settings;
  const settingsUpdatedAt = localSettingsNewer ? local.settingsUpdatedAt : remote.settingsUpdatedAt;

  return { data, tombstones, settingsUpdatedAt };
}
