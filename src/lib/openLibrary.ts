import type { AutofillResult } from '../components/CollectionPage';

// Open Library is fetched directly from the browser (no local proxy, unlike IGDB) with no
// timeout of its own — if the host is slow or unreachable, a bare fetch() can hang far longer
// than a user will wait, instead of failing fast to the placeholder cover/empty result the
// callers already handle gracefully. Caps every request here at 8s.
async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Open Library request failed: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// The search endpoint doesn't return a description — only the per-work page does. Fetched
// only here, in resolvePatch (called once for the book actually being added), rather than
// during search itself, so it doesn't multiply the request count across every result row.
async function fetchDescription(workKey: string | undefined): Promise<string | undefined> {
  if (!workKey) return undefined;
  try {
    const work = await fetchJson(`https://openlibrary.org${workKey}.json`);
    const desc = work.description;
    if (typeof desc === 'string') return desc;
    if (desc && typeof desc.value === 'string') return desc.value;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function searchBooks(query: string): Promise<AutofillResult[]> {
  // Let a failed request (network hiccup, Open Library rate limit) throw instead of silently
  // becoming an empty result — swallowing it made bulk import report a real match as "No match
  // found — skipped" instead of the retryable error it actually was.
  const data = await fetchJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`);

  return (data.docs ?? []).slice(0, 5).map((d: any) => {
    const author = d.author_name?.[0];
    const year = d.first_publish_year;
    const coverThumb = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined;
    const coverFull = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined;
    return {
      label: `${d.title}${author ? ` · ${author}` : ''}${year ? ` · ${year}` : ''}`,
      cover: coverThumb,
      resolvePatch: async () => ({
        title: d.title,
        author,
        coverArt: coverFull,
        pageCount: d.number_of_pages_median || undefined,
        description: await fetchDescription(d.key)
      })
    };
  });
}
