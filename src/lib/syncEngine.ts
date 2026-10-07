// One sync, start to finish. The cheap checks come first so a sync with nothing to do costs a
// single tiny request:
//   1. Ask Drive for the cloud file's version. Same version as after our last sync, and nothing
//      changed here → done.
//   2. Download only if another device has synced since (the version moved).
//   3. Upload only if the merge differs from what the cloud already has — and right before
//      uploading, re-check the version; if another device synced meanwhile, merge again first.
//   4. Write back only the records that changed, merged with anything edited here *during* the
//      sync, so typing while it runs is never lost.
import type { AppData } from '../types';
import {
  applySyncResult, getLocalChangedAt, getReplaceCloudOnNextSync, getSeedStamp, getSyncSnapshot, getSyncState,
  normalizeData, setReplaceCloudOnNextSync, setSyncState, type SyncState
} from '../storage';
import {
  downloadBlob, downloadSnapshot, getSnapshotInfo, listBlobFiles, uploadBlob, uploadSnapshot, type RemoteFileInfo
} from './googleDriveSync';
import {
  mergeSnapshots, replaceRemoteWith, snapshotFingerprint, snapshotHasRecords, withoutRemoteStarterData,
  withoutUntouchedStarterData, type SyncSnapshot
} from './syncMerge';
import { extractBlobs, inBatches, restoreBlobs } from './syncBlobs';

export interface SyncOutcome {
  /** This device's data after the sync, when the sync changed it (null = nothing changed here). */
  data: AppData | null;
  downloaded: boolean;
  uploaded: boolean;
  state: SyncState;
}

const EPOCH = new Date(0).toISOString();

function parseRemote(json: string): SyncSnapshot {
  const parsed = JSON.parse(json) as Partial<SyncSnapshot>;
  return { tombstones: [], settingsUpdatedAt: EPOCH, ...parsed, data: normalizeData(parsed.data ?? {}) };
}

export function hasUnsyncedChanges(localChangedAt: string | undefined, state: SyncState): boolean {
  if (!state.syncedThrough) return true;
  return Boolean(localChangedAt && localChangedAt > state.syncedThrough);
}

export async function runSync(): Promise<SyncOutcome> {
  let state = await getSyncState();
  const changedAtStart = await getLocalChangedAt();
  const dirty = hasUnsyncedChanges(changedAtStart, state);
  const replaceCloud = await getReplaceCloudOnNextSync();
  let info = await getSnapshotInfo(state.fileId);

  if (info && info.version === state.remoteVersion && !dirty && !replaceCloud) {
    state = await setSyncState({ fileId: info.id, lastSyncedAt: new Date().toISOString(), cloudBytes: info.size });
    return { data: null, downloaded: false, uploaded: false, state };
  }

  const local0 = await getSyncSnapshot();
  const seedStamp = await getSeedStamp();
  // Photos already on this device, by hash — the cloud's photo references resolve from here first.
  const known = (await extractBlobs(JSON.stringify(local0.data))).blobs;
  let blobIds = { ...(state.blobIds ?? {}) };
  let listedBlobs = false;
  const refreshBlobIds = async () => {
    if (listedBlobs) return;
    blobIds = { ...blobIds, ...(await listBlobFiles()) };
    listedBlobs = true;
  };
  const fetchMissing = async (hashes: string[]) => {
    if (hashes.some(h => !blobIds[h])) await refreshBlobIds();
    const out = new Map<string, string>();
    await inBatches(hashes.filter(h => blobIds[h]), 4, async h => { out.set(h, await downloadBlob(blobIds[h])); });
    return out;
  };

  let base = local0;
  let merged: SyncSnapshot = local0;
  let downloaded = false;
  let uploaded = false;
  let finalInfo: RemoteFileInfo | null = info;
  let photoCount = state.photoCount;
  let photoBytes = state.photoBytes;

  for (let attempt = 0; attempt < 3; attempt++) {
    let remoteFingerprint: string | null = null;
    if (!info) {
      merged = base;
    } else if (info.version === state.remoteVersion && !replaceCloud) {
      // Nobody else has synced since our last sync: the cloud holds exactly what we left there,
      // which this device already has — no need to download it.
      merged = base;
    } else {
      const remote = parseRemote(await restoreBlobs(await downloadSnapshot(info.id), known, fetchMissing));
      downloaded = true;
      if (replaceCloud) {
        merged = replaceRemoteWith(base, remote, replaceCloud);
      } else {
        const localForMerge = seedStamp && snapshotHasRecords(remote) ? withoutUntouchedStarterData(base, seedStamp) : base;
        merged = mergeSnapshots(localForMerge, withoutRemoteStarterData(remote, localForMerge));
      }
      remoteFingerprint = snapshotFingerprint(remote);
    }

    // The cloud already has exactly this — nothing to upload.
    if (remoteFingerprint !== null && snapshotFingerprint(merged) === remoteFingerprint) { finalInfo = info; break; }

    const { json: slim, blobs } = await extractBlobs(JSON.stringify(merged));
    photoCount = blobs.size;
    photoBytes = Array.from(blobs.values()).reduce((sum, b) => sum + b.length, 0);
    let toUpload = Array.from(blobs.keys()).filter(h => !blobIds[h]);
    if (toUpload.length) {
      await refreshBlobIds();
      toUpload = toUpload.filter(h => !blobIds[h]);
      await inBatches(toUpload, 4, async h => { blobIds[h] = await uploadBlob(h, blobs.get(h)!); });
    }

    // Another device may have synced while we were merging — if so, merge with that first.
    if (info) {
      const latest = await getSnapshotInfo(info.id);
      if (latest && latest.version !== info.version) { info = latest; base = merged; continue; }
    }
    finalInfo = await uploadSnapshot(slim, info?.id ?? null);
    uploaded = true;
    break;
  }

  // Anything edited on this device while the sync ran is merged in, not overwritten.
  const localNow = await getSyncSnapshot();
  const editedDuringSync = snapshotFingerprint(localNow) !== snapshotFingerprint(local0);
  const final = editedDuringSync
    ? mergeSnapshots(merged, seedStamp ? withoutUntouchedStarterData(localNow, seedStamp) : localNow)
    : merged;
  const writes = await applySyncResult(final, localNow);
  if (replaceCloud) await setReplaceCloudOnNextSync(false);

  state = await setSyncState({
    fileId: finalInfo?.id ?? state.fileId,
    remoteVersion: finalInfo?.version ?? state.remoteVersion,
    // Everything up to the last change seen when the sync started is in the cloud now; anything
    // edited after that wasn't uploaded and stays "unsynced" for the next sync.
    syncedThrough: changedAtStart ?? EPOCH,
    lastSyncedAt: new Date().toISOString(),
    blobIds,
    cloudBytes: finalInfo?.size ?? state.cloudBytes,
    photoCount,
    photoBytes
  });
  return { data: writes > 0 ? final.data : null, downloaded, uploaded, state };
}
