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

// Open Library has no explicit "book 3 of 7" field anywhere — the closest available signal is
// publish order within the series' own subject listing. Only trusted when the book being added
// actually shows up in that listing (its work key must be present) — some editions across a
// series get tagged inconsistently, so a series that's incompletely indexed here returns
// undefined rather than a confidently-wrong number.
async function fetchSeriesNumber(seriesTag: string, workKey: string | undefined): Promise<number | undefined> {
  if (!workKey) return undefined;
  try {
    const slug = seriesTag.toLowerCase();
    const data = await fetchJson(`https://openlibrary.org/subjects/${encodeURIComponent(slug)}.json?limit=100`);
    const works: { key: string; first_publish_year?: number }[] = data.works ?? [];
    const sorted = [...works].sort((a, b) => (a.first_publish_year ?? Infinity) - (b.first_publish_year ?? Infinity));
    const index = sorted.findIndex(w => w.key === workKey);
    return index >= 0 ? index + 1 : undefined;
  } catch {
    return undefined;
  }
}

export async function searchBooks(query: string): Promise<AutofillResult[]> {
  // Let a failed request (network hiccup, Open Library rate limit) throw instead of silently
  // becoming an empty result — swallowing it made bulk import report a real match as "No match
  // found — skipped" instead of the retryable error it actually was.
  // `subject` isn't in the default field set (Open Library omits it unless asked), so every
  // field the mapping below reads has to be listed explicitly once any `fields` param is given.
  const fields = 'key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject';
  const data = await fetchJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&fields=${fields}`);

  return (data.docs ?? []).slice(0, 5).map((d: any) => {
    const author = d.author_name?.[0];
    const year = d.first_publish_year;
    const coverThumb = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined;
    const coverFull = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined;
    // Open Library folds series membership into the same subject list as genre tags, marked
    // with a "series:" prefix (e.g. "series:Harry_Potter") — pull that one out separately so it
    // doesn't get picked as the genre, and clean up its underscore-for-space encoding.
    const seriesTag = d.subject?.find((s: string) => s.startsWith('series:'));
    const series = seriesTag ? seriesTag.slice('series:'.length).replace(/_/g, ' ') : undefined;
    const genreTag = d.subject?.find((s: string) => !s.startsWith('series:'));
    return {
      label: `${d.title}${author ? ` · ${author}` : ''}${year ? ` · ${year}` : ''}`,
      cover: coverThumb,
      resolvePatch: async () => ({
        title: d.title,
        author,
        series,
        // A best-effort guess from publish order, not a fact — series with prequels, spin-offs,
        // or box sets can still publish out of reading order. Still worth defaulting to, same as
        // every other autofilled field here: a starting point the caller can correct.
        seriesNumber: seriesTag ? await fetchSeriesNumber(seriesTag, d.key) : undefined,
        // Open Library's own subject ordering leads with its most-curated tag — a reasonable
        // one-line "main topic" default, but still just a starting point the caller can edit.
        // Two keys for the same value: `category` is what the Second Brain Book Note form reads
        // (a single string field); `genre` is what the Movies/Books collection page reads (its
        // multiselect field wants an array). Each caller's form only has one of these fields, so
        // the other key is silently ignored there — this isn't duplicated data, just two shapes.
        category: genreTag,
        genre: genreTag ? [genreTag] : undefined,
        coverArt: coverFull,
        pageCount: d.number_of_pages_median || undefined,
        description: await fetchDescription(d.key)
      })
    };
  });
}
