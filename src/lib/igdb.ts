import type { AutofillResult } from '../components/CollectionPage';

// In dev, Vite's own middleware (vite.config.ts) serves /api/igdb/* locally, so this stays empty
// and requests resolve relative to the current origin exactly as before. In production there's
// no server behind the built static site to run that middleware, so requests instead go to a
// small standalone Cloudflare Worker that implements the same two endpoints — see
// cloudflare/igdb-proxy/. Left unset, this just means "not configured" rather than erroring.
const IGDB_ORIGIN = import.meta.env.DEV ? '' : (import.meta.env.VITE_IGDB_PROXY_URL as string | undefined) ?? '';

interface IgdbCompany {
  company?: { name: string };
  developer?: boolean;
  publisher?: boolean;
}

interface IgdbGame {
  name: string;
  cover?: { image_id: string };
  first_release_date?: number;
  platforms?: { name: string }[];
  genres?: { name: string }[];
  summary?: string;
  involved_companies?: IgdbCompany[];
}

function coverUrl(imageId: string | undefined, size: 'thumb' | 'cover_big'): string | undefined {
  return imageId ? `https://images.igdb.com/igdb/image/upload/t_${size}/${imageId}.jpg` : undefined;
}

function toPatch(g: IgdbGame): Record<string, unknown> {
  return {
    title: g.name,
    coverArt: coverUrl(g.cover?.image_id, 'cover_big'),
    developer: g.involved_companies?.find(c => c.developer)?.company?.name,
    publisher: g.involved_companies?.find(c => c.publisher)?.company?.name,
    platforms: (g.platforms ?? []).map(p => p.name),
    genre: (g.genres ?? []).map(gn => gn.name),
    description: g.summary || undefined,
    releaseDate: g.first_release_date ? new Date(g.first_release_date * 1000).toISOString().slice(0, 10) : undefined
  };
}

export async function checkIgdbConfigured(): Promise<boolean> {
  try {
    const res = await fetch(`${IGDB_ORIGIN}/api/igdb/status`);
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data.configured);
  } catch {
    return false;
  }
}

export async function searchGames(query: string): Promise<AutofillResult[]> {
  const res = await fetch(`${IGDB_ORIGIN}/api/igdb/search?q=${encodeURIComponent(query)}`);
  // A failed request (rate-limited, network hiccup, proxy error) is not the same thing as
  // "this game doesn't exist" — swallowing it into an empty array made bulk import report a
  // real match as "No match found — skipped" instead of a retryable error. Throwing lets
  // BulkImportModal tell the two apart and only offer a retry for the former.
  if (!res.ok) throw new Error(`IGDB search failed: ${res.status}`);
  const data: IgdbGame[] = await res.json();

  return data.map(g => {
    const patch = toPatch(g);
    return {
      label: `${g.name}${g.first_release_date ? ` · ${new Date(g.first_release_date * 1000).getFullYear()}` : ''}`,
      cover: coverUrl(g.cover?.image_id, 'thumb'),
      resolvePatch: async () => patch
    };
  });
}
