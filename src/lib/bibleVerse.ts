// bible-api.com is free, keyless, and CORS-enabled — no local proxy needed, unlike IGDB. Used to
// auto-fill a chapter table's "Text / Passage" column from what's typed into "Chapter / Verse"
// when a Book Note is in verse-labeled mode (see SecondBrain.tsx's BookNotesLog).
export async function fetchVerseText(reference: string): Promise<string | undefined> {
  const trimmed = reference.trim();
  if (!trimmed) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://bible-api.com/${encodeURIComponent(trimmed)}?translation=kjv`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const data = await res.json();
    // The API's own text often carries a leading newline and per-verse line breaks even for a
    // single-verse reference — collapsed to one clean line since this fills a single table cell.
    const text = typeof data.text === 'string' ? data.text.replace(/\s+/g, ' ').trim() : undefined;
    return text || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
