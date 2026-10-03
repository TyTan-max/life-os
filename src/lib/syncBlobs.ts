// Photos (base64 data URLs inside notes, daily logs, …) are ~95% of the data by size, yet almost
// never change. Before upload they're swapped for short `lifeos-blob:<hash>` references and sent
// once each as their own Drive file; after download the references are swapped back. The app's
// own data never sees a reference — it still holds the real images.

const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{1000,}/g;
const BLOB_REF = /lifeos-blob:([0-9a-f]{40})/g;

const hashCache = new Map<string, string>();

async function hashOf(dataUrl: string): Promise<string> {
  const cached = hashCache.get(dataUrl);
  if (cached) return cached;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl));
  const hex = Array.from(new Uint8Array(digest).slice(0, 20), b => b.toString(16).padStart(2, '0')).join('');
  hashCache.set(dataUrl, hex);
  return hex;
}

/** Replaces every photo in `json` with a reference; returns the slim JSON and hash → photo. */
export async function extractBlobs(json: string): Promise<{ json: string; blobs: Map<string, string> }> {
  const blobs = new Map<string, string>();
  const found = new Set(json.match(DATA_URL) ?? []);
  const hashes = new Map<string, string>();
  await Promise.all(Array.from(found, async url => {
    const h = await hashOf(url);
    hashes.set(url, h);
    blobs.set(h, url);
  }));
  const slim = found.size ? json.replace(DATA_URL, url => `lifeos-blob:${hashes.get(url)}`) : json;
  return { json: slim, blobs };
}

export function blobRefsIn(json: string): Set<string> {
  return new Set(Array.from(json.matchAll(BLOB_REF), m => m[1]));
}

/** Puts the photos back. `fetchMissing` is asked for any hash not already in `known`. */
export async function restoreBlobs(
  json: string, known: Map<string, string>, fetchMissing: (hashes: string[]) => Promise<Map<string, string>>
): Promise<string> {
  const refs = blobRefsIn(json);
  if (!refs.size) return json;
  const missing = Array.from(refs).filter(h => !known.has(h));
  const fetched = missing.length ? await fetchMissing(missing) : new Map<string, string>();
  return json.replace(BLOB_REF, (whole, h: string) => known.get(h) ?? fetched.get(h) ?? whole);
}

/** Runs `task` over `items`, at most `limit` at a time. */
export async function inBatches<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  }));
  return results;
}
