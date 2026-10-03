import { CloudUpload, LogOut, RefreshCw } from 'lucide-react';
import { useStore } from '../store';

type SyncTone = 'ok' | 'pending' | 'syncing' | 'warn' | 'error' | 'off';

function timeOf(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** One status for every place that shows sync: the toolbar button, the mobile menu and Settings. */
export function useSyncDescription(): { tone: SyncTone; short: string; long: string } {
  const { isSyncConfigured, syncStatus, syncError, syncNeedsSignIn, hasUnsyncedChanges, lastSyncedAt } = useStore();
  if (!isSyncConfigured) return { tone: 'off', short: 'Sync off', long: 'Google Drive sync isn’t set up on this copy of the app.' };
  if (syncStatus === 'syncing') return { tone: 'syncing', short: 'Syncing…', long: 'Syncing with Google Drive…' };
  if (syncStatus === 'error' && syncError) return { tone: 'error', short: 'Sync failed', long: syncError };
  if (syncNeedsSignIn) {
    return {
      tone: 'warn',
      short: 'Tap to connect',
      long: hasUnsyncedChanges
        ? 'Not connected to Google Drive — changes are saved on this device. Tap Sync to connect and send them.'
        : 'Not connected to Google Drive. Tap Sync to connect.'
    };
  }
  if (hasUnsyncedChanges) return { tone: 'pending', short: 'Unsynced changes', long: 'Unsynced changes — they’ll sync automatically in a few seconds.' };
  return {
    tone: 'ok',
    short: lastSyncedAt ? `Synced ${timeOf(lastSyncedAt)}` : 'Up to date',
    long: lastSyncedAt ? `Up to date — last synced ${timeOf(lastSyncedAt)}.` : 'Up to date.'
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Settings → Sync: status, what's in the cloud, and the less common actions. */
export function SyncPanel({ mobile }: { mobile?: boolean }) {
  const { isSyncConfigured, syncStatus, syncNow, syncNeedsSignIn, syncState, replaceCloudCopy, disconnectSync } = useStore();
  const status = useSyncDescription();
  const busy = syncStatus === 'syncing';

  const onReplace = () => {
    if (window.confirm('Make this device’s data the cloud copy?\n\nAnything in the cloud that this device doesn’t have is deleted there, and from your other devices when they next sync.')) {
      void replaceCloudCopy();
    }
  };

  const cloudLine = syncState.cloudBytes != null
    ? `Cloud copy: ${formatBytes(syncState.cloudBytes)} of data${syncState.photoCount ? ` + ${syncState.photoCount} photo${syncState.photoCount === 1 ? '' : 's'} (${formatBytes(syncState.photoBytes ?? 0)}), each uploaded once` : ''}.`
    : null;

  return (
    <div className={`sync-panel ${mobile ? 'sync-panel-mobile' : ''}`}>
      <p className={`sync-panel-status tone-${status.tone}`}><i aria-hidden="true" />{status.long}</p>
      {cloudLine && <p className="muted sync-panel-line">{cloudLine}</p>}
      {isSyncConfigured && (
        <p className="muted sync-panel-line">
          Syncs on its own when you open the app, shortly after you make a change, and when you come back to it.
          Google sign-ins last about an hour; after that, tap Sync once to reconnect.
        </p>
      )}
      <div className="sync-panel-actions">
        <button type="button" className="btn primary" disabled={!isSyncConfigured || busy} onClick={() => void syncNow(true)}>
          <RefreshCw size={16} className={busy ? 'sheet-action-spin' : ''} /> {syncNeedsSignIn ? 'Connect & sync' : 'Sync now'}
        </button>
        <button type="button" className="btn ghost" disabled={!isSyncConfigured || busy} onClick={onReplace} title="Replace the cloud copy with exactly what's on this device">
          <CloudUpload size={16} /> Make this the cloud copy
        </button>
        {!syncNeedsSignIn && isSyncConfigured && (
          <button type="button" className="btn ghost" disabled={busy} onClick={disconnectSync}>
            <LogOut size={16} /> Disconnect
          </button>
        )}
      </div>
    </div>
  );
}
