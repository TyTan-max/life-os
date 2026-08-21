import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FolderOpen, FolderSync, HardDrive } from 'lucide-react';
import {
  getVaultRoot, isVaultAvailable, loadVaultNotes, onVaultChanged, pickVaultFolder, rescanVault, setVaultRoot
} from '../lib/vaultClient';

type Status = 'checking' | 'none' | 'connected';

// Shown at the top of the Second Brain tab, but only inside the actual Tauri
// desktop shell — isVaultAvailable() is false in the plain browser dev
// server, so this renders nothing there and the existing IndexedDB-backed
// notes experience is completely untouched.
export function VaultOnboarding() {
  const [status, setStatus] = useState<Status>('checking');
  const [vaultRoot, setVaultRootState] = useState<string | null>(null);
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isVaultAvailable()) return;
    let cancelled = false;

    (async () => {
      const root = await getVaultRoot();
      if (cancelled) return;
      if (!root) { setStatus('none'); return; }
      setVaultRootState(root);
      const notes = await loadVaultNotes();
      if (cancelled) return;
      setNoteCount(notes.length);
      setStatus('connected');

      const unlisten = await onVaultChanged(async () => {
        const count = await rescanVault();
        const refreshed = await loadVaultNotes();
        if (!cancelled) { setNoteCount(Math.max(count, refreshed.length)); }
      });
      unlistenRef.current = unlisten;
    })().catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });

    return () => {
      cancelled = true;
      unlistenRef.current?.();
    };
  }, []);

  if (!isVaultAvailable() || status === 'checking') return null;

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const folder = await pickVaultFolder();
      if (!folder) return;
      const count = await setVaultRoot(folder);
      await loadVaultNotes();
      setVaultRootState(folder);
      setNoteCount(count);
      setStatus('connected');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const rescan = async () => {
    setBusy(true);
    setError(null);
    try {
      const count = await rescanVault();
      await loadVaultNotes();
      setNoteCount(count);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (status === 'none') {
    return (
      <div className="vault-onboarding">
        <HardDrive size={18} />
        <div className="vault-onboarding-copy">
          <b>Connect a local vault</b>
          <span>Link a folder of .md files to back your notes with real files instead of the in-app database.</span>
        </div>
        <button type="button" className="btn primary" onClick={() => void choose()} disabled={busy}>
          <FolderOpen size={14} /> {busy ? 'Connecting…' : 'Choose folder'}
        </button>
        {error && <p className="vault-onboarding-error"><AlertTriangle size={13} /> {error}</p>}
      </div>
    );
  }

  return (
    <div className="vault-status-bar">
      <HardDrive size={14} />
      <span className="vault-status-path" title={vaultRoot ?? ''}>{vaultRoot}</span>
      <span className="vault-status-count">{noteCount ?? 0} note{noteCount === 1 ? '' : 's'} indexed</span>
      <button type="button" className="btn ghost small" onClick={() => void rescan()} disabled={busy}>
        <FolderSync size={13} /> {busy ? 'Scanning…' : 'Re-scan'}
      </button>
      <button type="button" className="btn ghost small" onClick={() => void choose()} disabled={busy}>
        <FolderOpen size={13} /> Change folder
      </button>
      {error && <p className="vault-onboarding-error"><AlertTriangle size={13} /> {error}</p>}
    </div>
  );
}
