export interface BookDeckIdea {
  id: string;
  title: string;
  author?: string;
  genre: string;
  coverArt: string;
  blurb: string;
}

export const picsum = (seed: string) => `https://picsum.photos/seed/${seed}/900/700`;

// A curated, hand-picked set of well-regarded books — bundled locally rather than fetched
// live, since there's no backend to search or rank a real catalog against.
export const BOOK_DISCOVERY_DECK: BookDeckIdea[] = [
  {
    id: 'project-hail-mary', title: 'Project Hail Mary', author: 'Andy Weir', genre: 'Science Fiction',
    coverArt: picsum('project-hail-mary-book'),
    blurb: 'A lone astronaut wakes up with no memory and the fate of Earth riding on him.'
  },
  {
    id: 'piranesi', title: 'Piranesi', author: 'Susanna Clarke', genre: 'Fantasy',
    coverArt: picsum('piranesi-book'),
    blurb: 'A man lives alone in an infinite, flooding house full of statues, and it isn’t what it seems.'
  },
  {
    id: 'the-midnight-library', title: 'The Midnight Library', author: 'Matt Haig', genre: 'Fiction',
    coverArt: picsum('midnight-library-book'),
    blurb: 'A library between life and death where every book is a different version of the life you didn’t live.'
  },
  {
    id: 'sapiens', title: 'Sapiens', author: 'Yuval Noah Harari', genre: 'Non-Fiction',
    coverArt: picsum('sapiens-book'),
    blurb: 'A history of humankind that makes you a little suspicious of every story we tell ourselves.'
  },
  {
    id: 'circe', title: 'Circe', author: 'Madeline Miller', genre: 'Fantasy',
    coverArt: picsum('circe-book'),
    blurb: 'A minor witch from Greek myth gets the retelling that finally makes her the main character.'
  },
  {
    id: 'atomic-habits', title: 'Atomic Habits', author: 'James Clear', genre: 'Self-Help',
    coverArt: picsum('atomic-habits-book'),
    blurb: 'Tiny, boring, repeatable changes explained in a way that actually makes you do them.'
  },
  {
    id: 'the-remains-of-the-day', title: 'The Remains of the Day', author: 'Kazuo Ishiguro', genre: 'Fiction',
    coverArt: picsum('remains-of-the-day-book'),
    blurb: 'An English butler drives across the country and slowly realizes what his loyalty cost him.'
  },
  {
    id: 'educated', title: 'Educated', author: 'Tara Westover', genre: 'Memoir',
    coverArt: picsum('educated-book'),
    blurb: 'A girl raised off the grid teaches herself enough to leave, and it costs her the family.'
  },
  {
    id: 'the-name-of-the-wind', title: 'The Name of the Wind', author: 'Patrick Rothfuss', genre: 'Fantasy',
    coverArt: picsum('name-of-the-wind-book'),
    blurb: 'A legendary figure tells his own life story, and it’s stranger than the legend.'
  },
  {
    id: 'the-three-body-problem', title: 'The Three-Body Problem', author: 'Liu Cixin', genre: 'Science Fiction',
    coverArt: picsum('three-body-problem-book'),
    blurb: 'A physics puzzle, a video game, and first contact with something that shouldn’t be listening.'
  },
  {
    id: 'braiding-sweetgrass', title: 'Braiding Sweetgrass', author: 'Robin Wall Kimmerer', genre: 'Non-Fiction',
    coverArt: picsum('braiding-sweetgrass-book'),
    blurb: 'A botanist blends Indigenous knowledge and plant science into something genuinely rewiring.'
  },
  {
    id: 'gone-girl', title: 'Gone Girl', author: 'Gillian Flynn', genre: 'Thriller',
    coverArt: picsum('gone-girl-book'),
    blurb: 'A wife disappears on her anniversary, and both spouses turn out to be lying.'
  },
  {
    id: 'the-song-of-achilles', title: 'The Song of Achilles', author: 'Madeline Miller', genre: 'Fantasy',
    coverArt: picsum('song-of-achilles-book'),
    blurb: 'The Iliad retold through the eyes of the person who loved Achilles most.'
  },
  {
    id: 'thinking-fast-and-slow', title: 'Thinking, Fast and Slow', author: 'Daniel Kahneman', genre: 'Non-Fiction',
    coverArt: picsum('thinking-fast-slow-book'),
    blurb: 'A Nobel laureate explains exactly how and why your own brain keeps fooling you.'
  }
];

export const BOOK_DECK_SYSTEM_PROMPT =
  'You generate to-read list ideas for a personal book-tracking app. Respond with STRICT JSON ' +
  'only — no markdown code fences, no commentary before or after — as a JSON array of objects ' +
  'shaped exactly like: [{"title": string, "author": string or null, "genre": string, "blurb": ' +
  'string}]. Only suggest real, existing published books — never invent a title. genre is a ' +
  'single primary genre word (e.g. "Fiction", "Fantasy", "Memoir"). Blurbs are one enticing ' +
  'sentence, at most 20 words, no spoilers, no clichés like "a must-read". Never repeat or ' +
  'closely resemble anything in the avoid list.';

export function buildBookDeckPrompt(count: number, avoidTitles: string[]): string {
  const avoid = avoidTitles.length ? avoidTitles.map(t => `- ${t}`).join('\n') : '(nothing yet)';
  return (
    `Suggest ${count} real published books worth reading, mixing genres and eras. ` +
    `Avoid anything similar to these existing titles:\n${avoid}\n\nRespond with JSON only.`
  );
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'idea';
}

/** Defensively parses a model's reply into BookDeckIdea objects — see bucketListDeck.ts for why. */
export function parseBookDeckIdeas(raw: string): BookDeckIdea[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const out: BookDeckIdea[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    const author = typeof e.author === 'string' && e.author.trim() ? e.author.trim() : undefined;
    const genre = typeof e.genre === 'string' && e.genre.trim() ? e.genre.trim() : 'Fiction';
    const blurb = typeof e.blurb === 'string' && e.blurb.trim() ? e.blurb.trim() : 'A new title worth checking out.';
    out.push({
      id: `ai-${slugify(title)}-${Date.now()}-${out.length}`,
      title, author, genre, blurb,
      coverArt: picsum(slugify(title))
    });
  }
  return out;
}
