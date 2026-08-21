import type { AutofillResult } from '../components/CollectionPage';

// Looks up the real cover/poster/box-art for a title using the same search + resolve
// pipeline the collection's own autofill feature already uses (TMDb/IGDB/Open Library) —
// takes the first match and resolves it to its full-size cover art, falling back to the
// search result's thumbnail if the full resolve didn't turn one up.
export async function resolveRealCoverArt(
  title: string,
  search: (query: string) => Promise<AutofillResult[]>
): Promise<string | undefined> {
  const results = await search(title).catch(() => []);
  const first = results[0];
  if (!first) return undefined;
  try {
    const patch = await first.resolvePatch();
    const coverArt = patch.coverArt;
    return typeof coverArt === 'string' && coverArt ? coverArt : first.cover;
  } catch {
    return first.cover;
  }
}
