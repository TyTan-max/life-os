// Google Drive appDataFolder sync transport.
//
// One-time setup required before this works — none of this can be provisioned from code,
// it needs your own Google account and project:
//   1. Create a project at https://console.cloud.google.com/
//   2. Enable the "Google Drive API" for it (APIs & Services → Enable APIs).
//   3. Configure the OAuth consent screen (External is fine for personal use) — the only
//      scope this needs is https://www.googleapis.com/auth/drive.appdata, which grants
//      access to a hidden per-app folder only, never the user's visible Drive files.
//   4. Create an OAuth 2.0 Client ID of type "Web application," and add this app's
//      origin(s) to "Authorized JavaScript origins" (e.g. http://localhost:5173 for dev,
//      your deployed https:// origin for prod). No redirect URI is needed — this uses
//      Google Identity Services' token flow, not a redirect-based one.
//   5. Put the client ID in .env.local as VITE_GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
//
// What lives in the hidden folder:
//   - life-os-sync.json — the snapshot, gzipped. Photos inside it are replaced by short
//     `lifeos-blob:<hash>` references, so it stays around a megabyte.
//   - blob-<hash> — one file per photo, uploaded once and never re-sent (the name is the hash of
//     its contents, so the same photo is never stored twice).

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'life-os-sync.json';
const BLOB_PREFIX = 'blob-';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
// The access token survives a reload (until it expires, an hour after sign-in), so reopening the
// app — or an automatic sync — doesn't need the Google popup again. It only grants this app's
// hidden Drive folder.
const TOKEN_KEY = 'lifeos.driveToken';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string }
interface TokenClient { requestAccessToken: (opts?: { prompt?: string }) => void }

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string; scope: string;
            callback: (resp: TokenResponse) => void;
            error_callback?: (err: { type?: string; message?: string }) => void;
          }): TokenClient;
          revoke(token: string, done: () => void): void;
        };
      };
    };
  }
}

let accessToken: string | null = null;
let tokenExpiresAt = 0;
let gisScriptPromise: Promise<void> | null = null;

try {
  const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null') as { token: string; exp: number } | null;
  if (saved && saved.exp > Date.now()) { accessToken = saved.token; tokenExpiresAt = saved.exp; }
} catch { /* storage unavailable — sign in each session instead */ }

function rememberToken(): void {
  try {
    if (accessToken) localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: accessToken, exp: tokenExpiresAt }));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

function loadGisScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisScriptPromise) {
    gisScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
      if (existing) { existing.addEventListener('load', () => resolve()); return; }
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => { gisScriptPromise = null; reject(new Error('Failed to load Google Identity Services')); };
      document.head.appendChild(script);
    });
  }
  return gisScriptPromise;
}

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID);
}

// Fetching the GIS script for the first time takes a real network round-trip — if that happens
// *inside* the click handler (i.e. `await`ed before requestAccessToken()), the popup it tries
// to open no longer reads as triggered by that click by the time the script resolves, and
// browsers silently block it as an unrequested popup. Preloading as soon as the module loads
// means requestAccessToken() fires synchronously within the click's own call stack.
if (isConfigured()) void loadGisScript().catch(() => { /* retried lazily in ensureSignedIn if this fails */ });

export function isSignedIn(): boolean {
  return Boolean(accessToken) && Date.now() < tokenExpiresAt;
}

// `interactive: false` never opens anything: it reports whether a still-valid token is on hand.
// (Google's token flow can only get a new one through a popup, and a popup that isn't the direct
// result of a tap is blocked by the browser — so automatic syncs just wait for the next tap.)
// `interactive: true` is for the Sync button; Google shows its consent screen only the first time.
export async function ensureSignedIn(interactive: boolean): Promise<boolean> {
  if (!CLIENT_ID) throw new Error('Google Drive sync isn’t configured — set VITE_GOOGLE_CLIENT_ID (see the setup comment at the top of googleDriveSync.ts)');
  if (isSignedIn()) return true;
  if (!interactive) return false;
  await loadGisScript();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        if (resp.error || !resp.access_token) { reject(new Error(resp.error || 'Google sign-in failed')); return; }
        accessToken = resp.access_token;
        // Refresh a couple of minutes early so a sync in progress isn't cut off by an expiry.
        tokenExpiresAt = Date.now() + Math.max(60, (resp.expires_in ?? 3600) - 120) * 1000;
        rememberToken();
        resolve(true);
      },
      // Closing the popup, or the browser blocking it, lands here — without it the promise
      // would never settle and the button would spin forever.
      error_callback: err => reject(new Error(err.type === 'popup_closed' ? 'popup_closed' : err.type === 'popup_failed_to_open' ? 'popup_blocked' : (err.message || 'Google sign-in failed')))
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function signOut(): void {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  rememberToken();
}

/** A sync error rewritten as something a person can act on. */
export function friendlySyncError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/popup_closed/.test(msg)) return 'The Google sign-in window was closed before finishing.';
  if (/popup_blocked|Failed to open popup/i.test(msg)) return 'Your browser blocked the Google sign-in window — allow pop-ups for this site, then tap Sync again.';
  if (/\(401\)|Not signed in/.test(msg)) return 'Your Google sign-in expired — tap Sync to reconnect.';
  if (/\(403\)/.test(msg)) return 'Google Drive refused access (403). Tap Sync to sign in again; if it keeps happening, check the app’s Google Cloud setup.';
  if (/\(404\)/.test(msg)) return 'The cloud copy went missing mid-sync — tap Sync to try again.';
  if (/\(429\)|\(5\d\d\)/.test(msg)) return 'Google Drive is busy right now — it’ll try again shortly.';
  if (/Failed to fetch|NetworkError|network/i.test(msg) || (typeof navigator !== 'undefined' && !navigator.onLine)) return 'You’re offline — changes are saved on this device and will sync when you’re back online.';
  if (/Failed to load Google Identity/.test(msg)) return 'Couldn’t reach Google to sign in — check your connection.';
  if (/isn’t configured/.test(msg)) return msg;
  return `Sync failed: ${msg}`;
}

async function driveFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!accessToken) throw new Error('Not signed in to Google Drive');
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 401) {
    // Expired or revoked server-side. Clear so the next call re-authenticates instead of
    // retrying with a token Google has already rejected.
    accessToken = null;
    tokenExpiresAt = 0;
    rememberToken();
  }
  return res;
}

// ---- The snapshot file ----

export interface RemoteFileInfo { id: string; version: string; size: number }

/** The snapshot file's id, version and size — one small request. `knownId` skips the name search. */
export async function getSnapshotInfo(knownId?: string): Promise<RemoteFileInfo | null> {
  if (knownId) {
    const res = await driveFetch(`/drive/v3/files/${knownId}?fields=id,version,size,trashed`);
    if (res.ok) {
      const f = await res.json() as { id: string; version: string; size?: string; trashed?: boolean };
      if (!f.trashed) return { id: f.id, version: f.version, size: Number(f.size ?? 0) };
    } else if (res.status !== 404) {
      throw new Error(`Drive lookup failed (${res.status})`);
    }
  }
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const res = await driveFetch(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,version,size)`);
  if (!res.ok) throw new Error(`Drive lookup failed (${res.status})`);
  const body = await res.json() as { files?: { id: string; version: string; size?: string }[] };
  const f = body.files?.[0];
  return f ? { id: f.id, version: f.version, size: Number(f.size ?? 0) } : null;
}

async function gzip(text: string): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') return new Blob([text], { type: 'application/json' });
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Blob([await new Response(stream).arrayBuffer()], { type: 'application/gzip' });
}

async function gunzipIfNeeded(buffer: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  // Older, uncompressed snapshot.
  return new TextDecoder().decode(bytes);
}

export async function downloadSnapshot(fileId: string): Promise<string> {
  const res = await driveFetch(`/drive/v3/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  return gunzipIfNeeded(await res.arrayBuffer());
}

/** Uploads the snapshot (gzipped) and returns the file's new id + version. */
export async function uploadSnapshot(json: string, fileId: string | null): Promise<RemoteFileInfo> {
  const body = await gzip(json);
  if (fileId) {
    const res = await driveFetch(`/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,version,size`, { method: 'PATCH', body });
    if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
    const f = await res.json() as { id: string; version: string; size?: string };
    return { id: f.id, version: f.version, size: Number(f.size ?? body.size) };
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })], { type: 'application/json' }));
  form.append('file', body);
  const res = await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id,version,size', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`);
  const f = await res.json() as { id: string; version: string; size?: string };
  return { id: f.id, version: f.version, size: Number(f.size ?? body.size) };
}

// ---- Photo files ----

/** Every photo file already in the cloud, as hash → file id (one paged listing). */
export async function listBlobFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let pageToken = '';
  const q = encodeURIComponent(`name contains '${BLOB_PREFIX}' and trashed=false`);
  do {
    const res = await driveFetch(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`);
    if (!res.ok) throw new Error(`Drive lookup failed (${res.status})`);
    const body = await res.json() as { nextPageToken?: string; files?: { id: string; name: string }[] };
    for (const f of body.files ?? []) if (f.name.startsWith(BLOB_PREFIX)) out[f.name.slice(BLOB_PREFIX.length)] = f.id;
    pageToken = body.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export async function uploadBlob(hash: string, dataUrl: string): Promise<string> {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: `${BLOB_PREFIX}${hash}`, parents: ['appDataFolder'] })], { type: 'application/json' }));
  form.append('file', new Blob([dataUrl], { type: 'text/plain' }));
  const res = await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Drive photo upload failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

export async function downloadBlob(fileId: string): Promise<string> {
  const res = await driveFetch(`/drive/v3/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive photo download failed (${res.status})`);
  return res.text();
}
