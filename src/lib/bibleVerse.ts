// bible-api.com is free, keyless, and CORS-enabled — no local proxy needed, unlike IGDB. Used to
// auto-fill a chapter table's "Text / Passage" column from what's typed into "Chapter / Verse"
// when a Book Note is in verse-labeled mode (see SecondBrain.tsx's BookNotesLog).
export async function fetchVerseText(reference: string): Promise<string | undefined> {
  // The API only knows books by their bare name ("Matthew", "John") — a traditional "St."/"Saint"
  // prefix (St. Matthew, Saint John) it doesn't recognize, and would otherwise 404 on.
  const trimmed = reference.trim().replace(/^(st\.?|saint)\s+/i, '');
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

// Standard 66-book id order used by bolls.life's translation endpoints — there's no name-based
// lookup on that API, only numeric book ids, so this is the mapping their own book list uses.
const BOOK_IDS: Record<string, number> = {
  genesis: 1, exodus: 2, leviticus: 3, numbers: 4, deuteronomy: 5, joshua: 6, judges: 7, ruth: 8,
  '1 samuel': 9, '2 samuel': 10, '1 kings': 11, '2 kings': 12, '1 chronicles': 13, '2 chronicles': 14,
  ezra: 15, nehemiah: 16, esther: 17, job: 18, psalms: 19, psalm: 19, proverbs: 20, ecclesiastes: 21,
  'song of solomon': 22, 'song of songs': 22, isaiah: 23, jeremiah: 24, lamentations: 25, ezekiel: 26,
  daniel: 27, hosea: 28, joel: 29, amos: 30, obadiah: 31, jonah: 32, micah: 33, nahum: 34, habakkuk: 35,
  zephaniah: 36, haggai: 37, zechariah: 38, malachi: 39, matthew: 40, mark: 41, luke: 42, john: 43,
  acts: 44, romans: 45, '1 corinthians': 46, '2 corinthians': 47, galatians: 48, ephesians: 49,
  philippians: 50, colossians: 51, '1 thessalonians': 52, '2 thessalonians': 53, '1 timothy': 54,
  '2 timothy': 55, titus: 56, philemon: 57, hebrews: 58, james: 59, '1 peter': 60, '2 peter': 61,
  '1 john': 62, '2 john': 63, '3 john': 64, jude: 65, revelation: 66
};

// Bolls-specific reference parse — separate from bible-api.com's own (looser) parsing above,
// since this endpoint needs a numeric book id rather than a name.
function parseReference(reference: string): { bookId: number; chapter: number; verseStart: number; verseEnd: number } | undefined {
  const trimmed = reference.trim().replace(/^(st\.?|saint)\s+/i, '');
  const match = trimmed.match(/^([1-3]?\s*[A-Za-z][A-Za-z\s]*?)\s+(\d+):(\d+)(?:[-–](\d+))?$/);
  if (!match) return undefined;
  const bookId = BOOK_IDS[match[1].trim().toLowerCase().replace(/\s+/g, ' ')];
  if (!bookId) return undefined;
  const chapter = Number(match[2]);
  const verseStart = Number(match[3]);
  const verseEnd = match[4] ? Number(match[4]) : verseStart;
  return { bookId, chapter, verseStart, verseEnd };
}

function stripHtml(html: string): string {
  return html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// The Geneva Bible (1599) is the one free, public-domain translation on bolls.life whose per-verse
// "comment" field is genuine explanatory/devotional notes rather than bare cross-references — the
// closest free source to an "Observation & Meaning" starting point. Still just a starting point:
// it's 16th-century marginalia, not a substitute for the reader's own reflection.
export async function fetchVerseObservation(reference: string): Promise<string | undefined> {
  const parsed = parseReference(reference);
  if (!parsed) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://bolls.life/get-chapter/GNV/${parsed.bookId}/${parsed.chapter}/`, { signal: controller.signal });
    if (!res.ok) return undefined;
    const verses: { verse: number; comment?: string }[] = await res.json();
    const notes = verses
      .filter(v => v.verse >= parsed.verseStart && v.verse <= parsed.verseEnd && v.comment)
      .map(v => stripHtml(v.comment!))
      .filter(Boolean);
    return notes.length ? notes.join(' ') : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
