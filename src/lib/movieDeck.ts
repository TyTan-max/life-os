export interface MovieDeckIdea {
  id: string;
  title: string;
  director?: string;
  releaseYear?: number;
  genre: string;
  coverArt: string;
  blurb: string;
}

export const picsum = (seed: string) => `https://picsum.photos/seed/${seed}/900/700`;

// A curated, hand-picked set of well-regarded titles — bundled locally rather than fetched
// live, since there's no backend to search or rank a real catalog against.
export const MOVIE_DISCOVERY_DECK: MovieDeckIdea[] = [
  {
    id: 'parasite', title: 'Parasite', director: 'Bong Joon-ho', releaseYear: 2019, genre: 'Thriller',
    coverArt: picsum('parasite-2019'),
    blurb: 'A broke family cons their way into a wealthy household, one job at a time.'
  },
  {
    id: 'everything-everywhere', title: 'Everything Everywhere All at Once', director: 'Daniels', releaseYear: 2022, genre: 'Science Fiction',
    coverArt: picsum('everything-everywhere-2022'),
    blurb: 'A laundromat owner discovers she must save the multiverse — during her tax audit.'
  },
  {
    id: 'spirited-away', title: 'Spirited Away', director: 'Hayao Miyazaki', releaseYear: 2001, genre: 'Animation',
    coverArt: picsum('spirited-away-2001'),
    blurb: 'A girl gets trapped in a spirit world and has to work in a bathhouse to survive it.'
  },
  {
    id: 'the-wire', title: 'The Wire', director: 'David Simon', releaseYear: 2002, genre: 'Crime',
    coverArt: picsum('the-wire-2002'),
    blurb: 'Baltimore, told through cops, dealers, dockworkers, and the systems that fail them all.'
  },
  {
    id: 'in-the-mood-for-love', title: 'In the Mood for Love', director: 'Wong Kar-wai', releaseYear: 2000, genre: 'Romance',
    coverArt: picsum('in-the-mood-for-love-2000'),
    blurb: 'Two neighbors, both married to someone else, fall into something they never name.'
  },
  {
    id: 'whiplash', title: 'Whiplash', director: 'Damien Chazelle', releaseYear: 2014, genre: 'Drama',
    coverArt: picsum('whiplash-2014'),
    blurb: 'A jazz drummer and a conductor push each other past where either should stop.'
  },
  {
    id: 'the-good-place', title: 'The Good Place', director: 'Michael Schur', releaseYear: 2016, genre: 'Comedy',
    coverArt: picsum('the-good-place-2016'),
    blurb: 'A woman who definitely doesn’t belong in the afterlife’s best neighborhood tries to earn her spot.'
  },
  {
    id: 'chernobyl', title: 'Chernobyl', director: 'Craig Mazin', releaseYear: 2019, genre: 'Documentary',
    coverArt: picsum('chernobyl-2019'),
    blurb: 'The true story of the disaster, told through the people who had to lie about it and the ones who didn’t.'
  },
  {
    id: 'her', title: 'Her', director: 'Spike Jonze', releaseYear: 2013, genre: 'Romance',
    coverArt: picsum('her-2013'),
    blurb: 'A lonely writer falls for his AI operating system, and it’s not played for laughs.'
  },
  {
    id: 'the-grand-budapest-hotel', title: 'The Grand Budapest Hotel', director: 'Wes Anderson', releaseYear: 2014, genre: 'Comedy',
    coverArt: picsum('grand-budapest-2014'),
    blurb: 'A legendary concierge and his lobby boy get tangled in a stolen painting and a war.'
  },
  {
    id: 'get-out', title: 'Get Out', director: 'Jordan Peele', releaseYear: 2017, genre: 'Horror',
    coverArt: picsum('get-out-2017'),
    blurb: 'A weekend meeting the girlfriend’s parents turns into something much stranger.'
  },
  {
    id: 'planet-earth-ii', title: 'Planet Earth II', director: 'BBC Natural History Unit', releaseYear: 2016, genre: 'Documentary',
    coverArt: picsum('planet-earth-ii-2016'),
    blurb: 'Nature footage so good it barely feels like a nature documentary anymore.'
  },
  {
    id: 'knives-out', title: 'Knives Out', director: 'Rian Johnson', releaseYear: 2019, genre: 'Mystery',
    coverArt: picsum('knives-out-2019'),
    blurb: 'A wealthy novelist is dead, and everyone in his family had a reason.'
  },
  {
    id: 'the-bear', title: 'The Bear', director: 'Christopher Storer', releaseYear: 2022, genre: 'Drama',
    coverArt: picsum('the-bear-2022'),
    blurb: 'A fine-dining chef comes home to run his late brother’s chaotic sandwich shop.'
  }
];

export const MOVIE_DECK_SYSTEM_PROMPT =
  'You generate movie and TV watchlist ideas for a personal media-tracking app. Respond with ' +
  'STRICT JSON only — no markdown code fences, no commentary before or after — as a JSON array of ' +
  'objects shaped exactly like: [{"title": string, "director": string or null, "releaseYear": ' +
  'number or null, "genre": string, "blurb": string}]. Only suggest real, existing movies or TV ' +
  'shows — never invent a title. genre is a single primary genre word (e.g. "Drama", "Comedy", ' +
  '"Thriller"). Blurbs are one enticing sentence, at most 20 words, no spoilers, no clichés like ' +
  '"a must-watch". Never repeat or closely resemble anything in the avoid list.';

export function buildMovieDeckPrompt(count: number, avoidTitles: string[]): string {
  const avoid = avoidTitles.length ? avoidTitles.map(t => `- ${t}`).join('\n') : '(nothing yet)';
  return (
    `Suggest ${count} real movies or TV shows worth watching, mixing genres and eras. ` +
    `Avoid anything similar to these existing titles:\n${avoid}\n\nRespond with JSON only.`
  );
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'idea';
}

/** Defensively parses a model's reply into MovieDeckIdea objects — see bucketListDeck.ts for why. */
export function parseMovieDeckIdeas(raw: string): MovieDeckIdea[] {
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

  const out: MovieDeckIdea[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    const director = typeof e.director === 'string' && e.director.trim() ? e.director.trim() : undefined;
    const releaseYear = typeof e.releaseYear === 'number' ? e.releaseYear : undefined;
    const genre = typeof e.genre === 'string' && e.genre.trim() ? e.genre.trim() : 'Drama';
    const blurb = typeof e.blurb === 'string' && e.blurb.trim() ? e.blurb.trim() : 'A new title worth checking out.';
    out.push({
      id: `ai-${slugify(title)}-${Date.now()}-${out.length}`,
      title, director, releaseYear, genre, blurb,
      coverArt: picsum(slugify(title))
    });
  }
  return out;
}
