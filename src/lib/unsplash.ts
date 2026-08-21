/**
 * unsplash — real keyword-based photo search, used to give bucket-list ideas an
 * actually-relevant cover image instead of a random Picsum placeholder.
 *
 * Needs a free Unsplash developer key:
 *   1. Create an app at https://unsplash.com/oauth/applications (free, demo tier
 *      is plenty for this — 50 requests/hour).
 *   2. Copy its "Access Key".
 *   3. Add to `.env.local` in the project root:
 *        VITE_UNSPLASH_ACCESS_KEY=your_key_here
 *   4. Restart the dev server (Vite only reads env files on startup).
 *
 * Without a key configured, `resolveCover` just returns the fallback you pass
 * it unchanged — everything degrades gracefully rather than breaking.
 */

const UNSPLASH_ACCESS_KEY: string =
  (import.meta.env.VITE_UNSPLASH_ACCESS_KEY as string | undefined) ?? '';

export function isUnsplashConfigured(): boolean {
  return Boolean(UNSPLASH_ACCESS_KEY);
}

interface UnsplashPhoto {
  urls?: { regular?: string; small?: string; thumb?: string };
  alt_description?: string | null;
  user?: { name?: string };
}
interface UnsplashSearchResult {
  results?: UnsplashPhoto[];
}

export interface PhotoOption {
  id: string;
  url: string;
  thumb: string;
  alt: string;
  credit?: string;
}

// Query → resolved URL, so re-opening the deck or re-rendering a card in the
// same session doesn't re-spend requests against the free-tier rate limit.
const cache = new Map<string, string>();

/**
 * Looks up a real photo for `query`. Returns `fallback` unchanged if no key is
 * configured, the search errors, or nothing matches — this never throws.
 */
export async function resolveCover(query: string, fallback: string): Promise<string> {
  if (!UNSPLASH_ACCESS_KEY) return fallback;
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape&content_filter=high`;
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) return fallback;
    const data = await res.json() as UnsplashSearchResult;
    const photo = data.results?.[0]?.urls?.regular ?? data.results?.[0]?.urls?.small;
    const result = photo ?? fallback;
    cache.set(key, result);
    return result;
  } catch {
    return fallback;
  }
}

/** Builds a search query from an idea's title + location — more specific than title alone. */
export function coverQuery(title: string, location?: string): string {
  return location ? `${title}, ${location}` : title;
}

/**
 * Returns up to `count` photo options for a manual picker — unlike `resolveCover`,
 * this always hits the network (no cache) since the point is showing several
 * different choices, not settling on one. Returns [] if unconfigured or the
 * search fails, so callers can just show "no results" rather than handle an error.
 */
export async function searchPhotos(query: string, count = 9): Promise<PhotoOption[]> {
  if (!UNSPLASH_ACCESS_KEY || !query.trim()) return [];
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape&content_filter=high`;
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${UNSPLASH_ACCESS_KEY}` } });
    if (!res.ok) return [];
    const data = await res.json() as UnsplashSearchResult;
    return (data.results ?? [])
      .filter(p => p.urls?.regular && p.urls?.thumb)
      .map((p, i) => ({
        id: `${query}-${i}`,
        url: p.urls!.regular!,
        thumb: p.urls!.thumb!,
        alt: p.alt_description ?? query,
        credit: p.user?.name
      }));
  } catch {
    return [];
  }
}
