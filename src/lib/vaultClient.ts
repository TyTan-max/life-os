// Thin wrapper around the Tauri commands defined in src-tauri/src/{config,notes}.rs,
// plus the in-memory FlexSearch index built from whatever the Rust-side SQLite cache
// returns. Every export here is a no-op (or throws) outside a Tauri window — call
// `isVaultAvailable()` before touching anything else in this module.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import FlexSearchPkg, { type DocumentValue } from 'flexsearch';

const { Document: FlexSearchDocument } = FlexSearchPkg;

export interface NoteRecord {
  id: string;
  path: string;
  title: string;
  body: string;
  tags: string[];
  mtime: number;
}

// FlexSearch's Document index requires an explicit string-keyed index
// signature (its DocumentData constraint) — NoteRecord's fields already
// satisfy DocumentValue, this just spells that out for the type checker.
type SearchableNote = NoteRecord & { [key: string]: DocumentValue | DocumentValue[] };

export function isVaultAvailable(): boolean {
  return isTauri();
}

/**
 * Purely a display string for the UI ("connected: <path>") — nothing else
 * in this module feeds it back into a command. Every mutating call below
 * (save/trash/rescan) carries no path at all; the Rust side resolves the
 * vault root itself from its own VaultState. That's what keeps this whole
 * module portable to a future backend (mobile / cloud-sync) that might not
 * have a filesystem path to give out in the first place.
 */
export async function getVaultRoot(): Promise<string | null> {
  if (!isVaultAvailable()) return null;
  const root = await invoke<string | null>('get_vault_root');
  return root ?? null;
}

/** Opens the native OS folder picker. Returns null if the user cancels. */
export async function pickVaultFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: 'Choose your notes folder' });
  if (!selected) return null;
  return Array.isArray(selected) ? selected[0] ?? null : selected;
}

/**
 * The one place a path crosses the boundary in the other direction: the
 * native OS dialog handed the frontend a folder the human just picked, and
 * this relays it once so Rust can adopt it as VaultState. After this call
 * returns, no other function in this module ever needs a path again.
 */
export function setVaultRoot(path: string): Promise<number> {
  return invoke<number>('set_vault_root', { path });
}

export function rescanVault(): Promise<number> {
  return invoke<number>('rescan_vault');
}

export function trashNote(noteId: string): Promise<void> {
  return invoke('trash_note', { noteId });
}

export function saveNote(note: NoteRecord): Promise<void> {
  searchIndex.update(note as SearchableNote);
  return invoke('save_note', { note });
}

/** Listens for external file changes reported by the Rust-side watcher. */
export function onVaultChanged(cb: (paths: string[]) => void): Promise<() => void> {
  return listen<string[]>('vault-changed', e => cb(e.payload));
}

const searchIndex = new FlexSearchDocument<SearchableNote>({
  document: {
    id: 'id',
    index: [
      { field: 'title', tokenize: 'forward' },
      { field: 'body', tokenize: 'forward' },
      { field: 'tags', tokenize: 'strict' }
    ]
  }
});

/** Fetches the whole vault from the cache and (re)builds the in-memory search index. */
export async function loadVaultNotes(): Promise<NoteRecord[]> {
  const notes = await invoke<NoteRecord[]>('list_notes');
  for (const n of notes) searchIndex.add(n as SearchableNote);
  return notes;
}

export function searchNotes(query: string): string[] {
  if (!query.trim()) return [];
  const results = searchIndex.search(query, { limit: 20 });
  const ids = new Set<string>();
  for (const r of results) {
    for (const id of r.result) ids.add(String(id));
  }
  return Array.from(ids);
}
