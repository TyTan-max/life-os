import type { BucketListCategory, CostTier } from '../types';

export interface DeckIdea {
  id: string;
  title: string;
  category: BucketListCategory;
  costTier: CostTier;
  location?: string;
  coverArt: string;
  blurb: string;
}

export const picsum = (seed: string) => `https://picsum.photos/seed/${seed}/900/700`;

// A curated, hand-picked set of ideas — bundled locally rather than fetched live,
// since there's no backend to search or rank a real catalog against.
export const DISCOVERY_DECK: DeckIdea[] = [
  {
    id: 'angkor-sunrise', title: 'Watch the sunrise at Angkor Wat', category: 'Travel', costTier: '$$',
    location: 'Siem Reap, Cambodia', coverArt: picsum('angkor-wat-sunrise'),
    blurb: 'The temple silhouettes against a pink sky, before the crowds arrive.'
  },
  {
    id: 'iceland-ring-road', title: 'Drive the Ring Road around Iceland', category: 'Travel', costTier: '$$$',
    location: 'Iceland', coverArt: picsum('iceland-ring-road'),
    blurb: 'Glaciers, black sand beaches, and waterfalls you’ll have almost entirely to yourself.'
  },
  {
    id: 'glass-igloo', title: 'Sleep in a glass igloo under the northern lights', category: 'Travel', costTier: '$$$',
    location: 'Finnish Lapland', coverArt: picsum('glass-igloo-aurora'),
    blurb: 'Fall asleep watching the sky do something you can’t plan for.'
  },
  {
    id: 'marrakech-souks', title: 'Get lost in the souks of Marrakech', category: 'Travel', costTier: '$$',
    location: 'Marrakech, Morocco', coverArt: picsum('marrakech-souk'),
    blurb: 'No map, no plan — just follow the smell of spice stalls and leather.'
  },
  {
    id: 'whale-sharks', title: 'Swim alongside whale sharks', category: 'Experience', costTier: '$$',
    location: 'Cebu, Philippines', coverArt: picsum('whale-shark-swim'),
    blurb: 'The largest fish in the ocean, and it’s gentle as anything.'
  },
  {
    id: 'cappadocia-balloon', title: 'Ride a hot air balloon over fairy chimneys at sunrise', category: 'Experience', costTier: '$$',
    location: 'Cappadocia, Türkiye', coverArt: picsum('cappadocia-balloons'),
    blurb: 'Hundreds of balloons lifting off together over a landscape like nowhere else.'
  },
  {
    id: 'broadway-front-row', title: 'Watch a Broadway show from the front row', category: 'Experience', costTier: '$$',
    location: 'New York, USA', coverArt: picsum('broadway-theater'),
    blurb: 'Close enough to see the sweat and hear every breath before the big note.'
  },
  {
    id: 'stage-kitchen', title: 'Stage a night in a professional kitchen', category: 'Experience', costTier: '$',
    coverArt: picsum('professional-kitchen-service'),
    blurb: 'One dinner service on the line — find out what "in the weeds" really means.'
  },
  {
    id: 'freediving', title: 'Learn to free dive on a single breath', category: 'Skill', costTier: '$$',
    coverArt: picsum('freediving-breath'),
    blurb: 'No tank, no bubbles — just you, held breath, and quiet water.'
  },
  {
    id: 'knife-skills', title: 'Take a real knife-skills course', category: 'Skill', costTier: '$',
    coverArt: picsum('knife-skills-class'),
    blurb: 'A proper dice, a proper julienne — the difference shows in every meal after.'
  },
  {
    id: 'calligraphy', title: 'Learn calligraphy', category: 'Skill', costTier: '$',
    coverArt: picsum('calligraphy-practice'),
    blurb: 'Slow down enough to make even a grocery list look intentional.'
  },
  {
    id: 'scuba-cert', title: 'Get scuba certified', category: 'Skill', costTier: '$$',
    coverArt: picsum('scuba-certification'),
    blurb: 'Opens up an entire planet you’ve only ever seen the surface of.'
  },
  {
    id: 'off-grid-week', title: 'Go completely off-grid for a week', category: 'Other', costTier: '$',
    coverArt: picsum('off-grid-cabin'),
    blurb: 'No signal, no notifications — just to see who you are without them.'
  },
  {
    id: 'ten-languages', title: 'Learn to say "I love you" in ten languages', category: 'Other', costTier: '$',
    coverArt: picsum('language-notebook'),
    blurb: 'A small thing that makes the whole world feel a little more reachable.'
  },
  {
    id: 'plant-a-tree', title: 'Plant a tree you’ll watch grow for decades', category: 'Other', costTier: '$',
    coverArt: picsum('planting-a-tree'),
    blurb: 'Something that gets bigger every single year you’re not paying attention.'
  },
  {
    id: 'letter-to-future-self', title: 'Write a letter to your future self, seal it for ten years', category: 'Other', costTier: '$',
    coverArt: picsum('sealed-letter-envelope'),
    blurb: 'Whatever you’re worried about right now — you probably won’t remember it the same way.'
  }
];

export const DECK_SYSTEM_PROMPT =
  'You generate bucket-list ideas for a personal goals app. Respond with STRICT JSON only — ' +
  'no markdown code fences, no commentary before or after — as a JSON array of objects shaped ' +
  'exactly like: [{"title": string, "category": "Travel" | "Experience" | "Skill" | "Other", ' +
  '"costTier": "$" | "$$" | "$$$", "location": string or null, "blurb": string}]. ' +
  'Titles are short action phrases (e.g. "Learn to sail a boat"), 3-8 words. Blurbs are one ' +
  'evocative sentence, at most 20 words, no clichés like "unforgettable" or "once in a lifetime". ' +
  'location is a real place name for Travel ideas, null otherwise. Never repeat or closely ' +
  'resemble anything in the avoid list.';

export function buildDeckPrompt(count: number, avoidTitles: string[]): string {
  const avoid = avoidTitles.length
    ? avoidTitles.map(t => `- ${t}`).join('\n')
    : '(nothing yet)';
  return (
    `Generate ${count} fresh bucket-list ideas, mixing Travel, Experience, Skill, and Other ` +
    `categories. Avoid anything similar to these existing titles:\n${avoid}\n\nRespond with JSON only.`
  );
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'idea';
}

const VALID_CATEGORIES: BucketListCategory[] = ['Travel', 'Experience', 'Skill', 'Other'];
const VALID_COST_TIERS: CostTier[] = ['$', '$$', '$$$'];

/**
 * Defensively parses a model's reply into DeckIdea objects. Models often wrap JSON in
 * markdown fences or add a sentence of preamble despite instructions not to, so this
 * extracts the first `[...]` span rather than assuming the whole reply is clean JSON.
 * Cover art is always generated locally (picsum) — never trusted from the model, since
 * an invented image URL would just 404.
 */
export function parseDeckIdeas(raw: string): DeckIdea[] {
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

  const out: DeckIdea[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    const category = VALID_CATEGORIES.includes(e.category as BucketListCategory)
      ? (e.category as BucketListCategory) : 'Other';
    const costTier = VALID_COST_TIERS.includes(e.costTier as CostTier)
      ? (e.costTier as CostTier) : '$';
    const location = typeof e.location === 'string' && e.location.trim() ? e.location.trim() : undefined;
    const blurb = typeof e.blurb === 'string' && e.blurb.trim() ? e.blurb.trim() : 'A new idea worth exploring.';
    out.push({
      id: `ai-${slugify(title)}-${Date.now()}-${out.length}`,
      title, category, costTier, location, blurb,
      coverArt: picsum(slugify(title))
    });
  }
  return out;
}
