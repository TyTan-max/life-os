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
// Not wired up for the Tauri desktop build: Google's origin allowlist only accepts
// http/https origins, not Tauri's custom webview scheme, so as written this only works in
// the browser/PWA build. Tauri has its own OAuth plugin for this that would need a
// separate integration.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'life-os-sync.json';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface TokenResponse { access_token?: string; error?: string }
interface TokenClient { requestAccessToken: (opts?: { prompt?: string }) => void }

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: { client_id: string; scope: string; callback: (resp: TokenResponse) => void }): TokenClient;
          revoke(token: string, done: () => void): void;
        };
      };
    };
  }
}

let accessToken: string | null = null;
let tokenExpiresAt = 0;
let gisScriptPromise: Promise<void> | null = null;

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
      script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
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
// browsers silently block it as an unrequested popup ("Failed to open popup window... Maybe
// blocked by the browser"). Preloading as soon as the module loads means the script is already
// there by the time anyone clicks Sync, so requestAccessToken() fires synchronously within the
// click's own call stack instead of after an await — same trigger, but the trust chain holds.
if (isConfigured()) void loadGisScript().catch(() => { /* retried lazily in ensureSignedIn if this fails */ });

export function isSignedIn(): boolean {
  return Boolean(accessToken) && Date.now() < tokenExpiresAt;
}

// `interactive: false` tries a silent grant using the browser's existing Google session and
// resolves to `false` (rather than throwing) if that fails — so a background/auto sync can
// probe for a session without popping a consent screen the user didn't ask for. Pass
// `interactive: true` for the button the user actually taps.
export async function ensureSignedIn(interactive: boolean): Promise<boolean> {
  if (!CLIENT_ID) throw new Error('Google Drive sync isn’t configured — set VITE_GOOGLE_CLIENT_ID (see the setup comment at the top of googleDriveSync.ts)');
  if (isSignedIn()) return true;
  await loadGisScript();
  return new Promise((resolve, reject) => {
    const client = window.google!.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: resp => {
        if (resp.error || !resp.access_token) {
          if (!interactive) { resolve(false); return; }
          reject(new Error(resp.error || 'Google sign-in failed'));
          return;
        }
        accessToken = resp.access_token;
        // This token flow's access tokens last 1 hour; refresh a couple minutes early so a
        // sync in progress doesn't get cut off mid-request by an expiry it could have avoided.
        tokenExpiresAt = Date.now() + 58 * 60 * 1000;
        resolve(true);
      }
    });
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

export function signOut(): void {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
}

async function driveFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!accessToken) throw new Error('Not signed in to Google Drive');
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 401) {
    // Expired or revoked server-side, not just locally-expired (that case never reaches
    // here — isSignedIn() catches it first). Clear so the next call re-authenticates instead
    // of retrying with a token Google has already rejected.
    accessToken = null;
    tokenExpiresAt = 0;
  }
  return res;
}

async function findSyncFileId(): Promise<string | null> {
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const res = await driveFetch(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
  if (!res.ok) throw new Error(`Drive lookup failed (${res.status})`);
  const body = await res.json() as { files?: { id: string }[] };
  return body.files?.[0]?.id ?? null;
}

export async function downloadSnapshotJson(): Promise<string | null> {
  const fileId = await findSyncFileId();
  if (!fileId) return null;
  const res = await driveFetch(`/drive/v3/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  return res.text();
}

export async function uploadSnapshotJson(json: string): Promise<void> {
  const fileId = await findSyncFileId();
  const blob = new Blob([json], { type: 'application/json' });
  if (fileId) {
    const res = await driveFetch(`/upload/drive/v3/files/${fileId}?uploadType=media`, { method: 'PATCH', body: blob });
    if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
    return;
  }
  const metadata = { name: FILE_NAME, parents: ['appDataFolder'] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const res = await driveFetch('/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`);
}
