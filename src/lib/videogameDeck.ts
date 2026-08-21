export interface VideogameDeckIdea {
  id: string;
  title: string;
  developer?: string;
  platform?: string;
  genre: string;
  coverArt: string;
  blurb: string;
}

export const picsum = (seed: string) => `https://picsum.photos/seed/${seed}/900/700`;

// A curated, hand-picked set of well-regarded games — bundled locally rather than fetched
// live, since there's no backend to search or rank a real catalog against.
export const VIDEOGAME_DISCOVERY_DECK: VideogameDeckIdea[] = [
  {
    id: 'elden-ring', title: 'Elden Ring', developer: 'FromSoftware', platform: 'PC / PS5 / Xbox', genre: 'RPG',
    coverArt: picsum('elden-ring'),
    blurb: 'An open world built to punish curiosity and reward it in equal measure.'
  },
  {
    id: 'hades', title: 'Hades', developer: 'Supergiant Games', platform: 'PC / Switch', genre: 'Roguelike',
    coverArt: picsum('hades-game'),
    blurb: 'Fight your way out of the underworld, again and again, and the story keeps moving anyway.'
  },
  {
    id: 'outer-wilds', title: 'Outer Wilds', developer: 'Mobius Digital', platform: 'PC / PS4 / Xbox', genre: 'Adventure',
    coverArt: picsum('outer-wilds-game'),
    blurb: 'A 22-minute time loop and a solar system full of secrets nobody tells you how to find.'
  },
  {
    id: 'stardew-valley', title: 'Stardew Valley', developer: 'ConcernedApe', platform: 'PC / Switch / Mobile', genre: 'Simulation',
    coverArt: picsum('stardew-valley-game'),
    blurb: 'Inherit a rundown farm and somehow lose forty hours before you notice.'
  },
  {
    id: 'disco-elysium', title: 'Disco Elysium', developer: 'ZA/UM', platform: 'PC / PS5 / Xbox', genre: 'RPG',
    coverArt: picsum('disco-elysium-game'),
    blurb: 'A detective with amnesia, a dead body, and a personality made entirely of dice rolls.'
  },
  {
    id: 'celeste', title: 'Celeste', developer: 'Maddy Makes Games', platform: 'PC / Switch', genre: 'Platformer',
    coverArt: picsum('celeste-game'),
    blurb: 'A brutal mountain-climbing platformer that’s secretly about anxiety, and it lands.'
  },
  {
    id: 'baldurs-gate-3', title: "Baldur's Gate 3", developer: 'Larian Studios', platform: 'PC / PS5', genre: 'RPG',
    coverArt: picsum('baldurs-gate-3-game'),
    blurb: 'A tabletop-faithful RPG where nearly everything you try to do actually works.'
  },
  {
    id: 'return-of-the-obra-dinn', title: 'Return of the Obra Dinn', developer: 'Lucas Pope', platform: 'PC / Switch', genre: 'Mystery',
    coverArt: picsum('obra-dinn-game'),
    blurb: 'A ghost ship, sixty deaths, and a stopwatch that lets you witness each one.'
  },
  {
    id: 'hollow-knight', title: 'Hollow Knight', developer: 'Team Cherry', platform: 'PC / Switch', genre: 'Metroidvania',
    coverArt: picsum('hollow-knight-game'),
    blurb: 'A tiny knight, a collapsed kingdom of bugs, and a map that never holds your hand.'
  },
  {
    id: 'it-takes-two', title: 'It Takes Two', developer: 'Hazelight Studios', platform: 'PC / PS5 / Xbox', genre: 'Co-op',
    coverArt: picsum('it-takes-two-game'),
    blurb: 'A couple turned into dolls, forced to fix their marriage by beating a game together.'
  },
  {
    id: 'portal-2', title: 'Portal 2', developer: 'Valve', platform: 'PC / PS3 / Xbox 360', genre: 'Puzzle',
    coverArt: picsum('portal-2-game'),
    blurb: 'Still the smartest puzzle game ever made, and it’s funnier than most comedies.'
  },
  {
    id: 'slay-the-spire', title: 'Slay the Spire', developer: 'MegaCrit', platform: 'PC / Switch / Mobile', genre: 'Deckbuilder',
    coverArt: picsum('slay-the-spire-game'),
    blurb: 'A deckbuilding roguelike so tight you’ll say "one more run" until 2am.'
  },
  {
    id: 'inscryption', title: 'Inscryption', developer: 'Daniel Mullins Games', platform: 'PC', genre: 'Card Game',
    coverArt: picsum('inscryption-game'),
    blurb: 'A card game in a cabin that turns into something you really shouldn’t spoil.'
  },
  {
    id: 'the-witness', title: 'The Witness', developer: 'Thekla, Inc.', platform: 'PC / PS4', genre: 'Puzzle',
    coverArt: picsum('the-witness-game'),
    blurb: 'A silent island covered in line puzzles that quietly retrain how you see everything.'
  }
];

export const VIDEOGAME_DECK_SYSTEM_PROMPT =
  'You generate video game backlog ideas for a personal game-tracking app. Respond with STRICT ' +
  'JSON only — no markdown code fences, no commentary before or after — as a JSON array of ' +
  'objects shaped exactly like: [{"title": string, "developer": string or null, "platform": ' +
  'string or null, "genre": string, "blurb": string}]. Only suggest real, existing video games — ' +
  'never invent a title. genre is a single primary genre word (e.g. "RPG", "Platformer", ' +
  '"Roguelike"). Blurbs are one enticing sentence, at most 20 words, no spoilers, no clichés like ' +
  '"a must-play". Never repeat or closely resemble anything in the avoid list.';

export function buildVideogameDeckPrompt(count: number, avoidTitles: string[]): string {
  const avoid = avoidTitles.length ? avoidTitles.map(t => `- ${t}`).join('\n') : '(nothing yet)';
  return (
    `Suggest ${count} real video games worth playing, mixing genres and eras. ` +
    `Avoid anything similar to these existing titles:\n${avoid}\n\nRespond with JSON only.`
  );
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'idea';
}

/** Defensively parses a model's reply into VideogameDeckIdea objects — see bucketListDeck.ts for why. */
export function parseVideogameDeckIdeas(raw: string): VideogameDeckIdea[] {
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

  const out: VideogameDeckIdea[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    const developer = typeof e.developer === 'string' && e.developer.trim() ? e.developer.trim() : undefined;
    const platform = typeof e.platform === 'string' && e.platform.trim() ? e.platform.trim() : undefined;
    const genre = typeof e.genre === 'string' && e.genre.trim() ? e.genre.trim() : 'Adventure';
    const blurb = typeof e.blurb === 'string' && e.blurb.trim() ? e.blurb.trim() : 'A new title worth checking out.';
    out.push({
      id: `ai-${slugify(title)}-${Date.now()}-${out.length}`,
      title, developer, platform, genre, blurb,
      coverArt: picsum(slugify(title))
    });
  }
  return out;
}
