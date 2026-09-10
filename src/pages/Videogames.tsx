import { useEffect, useState } from 'react';
import { Clock, Sparkles } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { DiscoveryDeck } from '../components/DiscoveryDeck';
import { useStore, newRecord } from '../store';
import { checkIgdbConfigured, fetchTimeToBeatByTitle, searchGames } from '../lib/igdb';
import { resolveRealCoverArt } from '../lib/coverArt';
import {
  VIDEOGAME_DISCOVERY_DECK, VIDEOGAME_DECK_SYSTEM_PROMPT, buildVideogameDeckPrompt, parseVideogameDeckIdeas,
  type VideogameDeckIdea
} from '../lib/videogameDeck';
import type { Videogame } from '../types';

export function Videogames() {
  const [igdbReady, setIgdbReady] = useState(true);
  useEffect(() => { void checkIgdbConfigured().then(setIgdbReady); }, []);

  const { data, upsert } = useStore();
  const [deckOpen, setDeckOpen] = useState(false);
  const existingTitles = new Set(data.videogames.map(v => v.title.trim().toLowerCase()));

  // Fills in the three new How Long to Beat fields for games added before that feature
  // existed — a game already carrying any of them is left alone, so re-running this later
  // (say, after adding more games) only ever touches what's still missing, never a value
  // you've since edited by hand.
  const [backfilling, setBackfilling] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  const backfillTimeToBeat = async () => {
    const todo = data.videogames.filter(v => v.hltbMain === undefined && v.hltbMainExtra === undefined && v.hltbCompletionist === undefined);
    if (!todo.length) { setBackfillStatus('Every game already has this — nothing to backfill.'); return; }
    setBackfilling(true);
    let updated = 0;
    for (let i = 0; i < todo.length; i++) {
      const game = todo[i];
      setBackfillStatus(`Checking ${i + 1} / ${todo.length}: ${game.title}`);
      try {
        const patch = await fetchTimeToBeatByTitle(game.title);
        if (patch) { await upsert('videogames', { ...game, ...patch }); updated++; }
      } catch {
        // A transient failure just leaves this one for the next run — not worth aborting the
        // whole backfill over a single title.
      }
      // Same IGDB rate limit (4 req/sec) as the bulk importer — two requests per game here
      // (search + time-to-beat), so a longer pause between games than that importer uses.
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    setBackfilling(false);
    setBackfillStatus(`Done — filled in ${updated} of ${todo.length} game${todo.length === 1 ? '' : 's'} (the rest have no How Long to Beat entry on IGDB yet).`);
  };

  const addFromDeck = (idea: VideogameDeckIdea) => {
    void upsert('videogames', newRecord<Videogame>({
      title: idea.title,
      coverArt: idea.coverArt,
      developer: idea.developer,
      platforms: idea.platform ? idea.platform.split('/').map(p => p.trim()).filter(Boolean) : undefined,
      genre: [idea.genre],
      description: idea.blurb,
      status: 'To Play'
    }));
  };

  return (
    <>
      <CollectionPage<Videogame>
        collection="videogames"
        itemLabel="Videogame"
        title="Games"
        subtitle="What to play, what you're playing, what you've beaten"
        fields={[
          { key: 'coverArt', label: 'Cover / Box Art', type: 'image', placeholder: 'https://…' },
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'developer', label: 'Developer', type: 'text' },
          { key: 'publisher', label: 'Publisher', type: 'text' },
          { key: 'platforms', label: 'Platform(s)', type: 'tags', placeholder: 'PC, PS5, Switch…' },
          { key: 'genre', label: 'Genre', type: 'multiselect', placeholder: 'Select genres…', options: [
            'Point-and-click', 'Fighting', 'Shooter', 'Music', 'Platform', 'Puzzle', 'Racing',
            'Real Time Strategy (RTS)', 'Role-playing (RPG)', 'Simulator', 'Sport', 'Strategy',
            'Turn-based strategy (TBS)', 'Tactical', 'Quiz/Trivia', "Hack and slash/Beat 'em up",
            'Pinball', 'Adventure', 'Indie', 'Arcade', 'Visual Novel', 'Card & Board Game', 'MOBA'
          ] },
          { key: 'releaseDate', label: 'Release Date', type: 'date' },
          { key: 'status', label: 'Status', type: 'select', options: ['To Play', 'Playing', 'Completed'] },
          { key: 'rating', label: 'Rating (1-5)', type: 'number' },
          { key: 'hltbMain', label: 'How Long to Beat — Main Story (hrs)', type: 'number' },
          { key: 'hltbMainExtra', label: 'How Long to Beat — Main + Extra (hrs)', type: 'number' },
          { key: 'hltbCompletionist', label: 'How Long to Beat — Completionist (hrs)', type: 'number' },
          { key: 'playtimeHours', label: 'Playtime (hrs)', type: 'number' },
          { key: 'completionPct', label: 'Completion %', type: 'number' },
          { key: 'dateCompleted', label: 'Date Completed', type: 'date' },
          { key: 'multiplayer', label: 'Multiplayer', type: 'checkbox' },
          { key: 'tags', label: 'Tags', type: 'tags', placeholder: 'Co-op, Replay…' },
          { key: 'description', label: 'Description', type: 'richtext', placeholder: 'What is this game about?' },
          { key: 'notes', label: 'Notes', type: 'richtext' }
        ]}
        defaults={{ title: '', status: 'To Play' }}
        renderTitle={v => v.title}
        renderSubtitle={v => `${v.platforms?.length ? `${v.platforms.join(' / ')} · ` : ''}${v.status}${v.rating ? ` · ${v.rating}/5` : ''}`}
        sortBy={(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()}
        gallery={{
          coverKey: 'coverArt',
          coverAccent: 'linear-gradient(155deg, var(--purple-soft), var(--purple) 130%)',
          badge: v => v.status,
          rating: v => v.rating,
          meta: v => [v.developer, v.platforms?.join(' / ')].filter(Boolean).join(' · ') || undefined
        }}
        statusFilter={{
          key: 'status',
          groups: [
            { label: 'In Progress', values: ['Playing'] },
            { label: 'Completed', values: ['Completed'] }
          ],
          allExcludesGrouped: true
        }}
        genreFilter={{ key: 'genre' }}
        autofill={{
          titleKey: 'title',
          search: searchGames,
          disabledReason: igdbReady ? undefined : 'Add IGDB (Twitch) API credentials in .env.local to autofill from a title'
        }}
        needsReviewKey="needsReview"
        dateSortKey="releaseDate"
        dateSortLabel="release date"
        headerExtra={
          <>
            <button type="button" className="btn ghost" onClick={() => setDeckOpen(true)}><Sparkles size={16} /> Discover</button>
            <button
              type="button" className="btn ghost" onClick={() => void backfillTimeToBeat()} disabled={backfilling}
              title="Fill in How Long to Beat for games added before that field existed"
            >
              <Clock size={16} /> {backfilling ? 'Backfilling…' : 'Backfill How Long to Beat'}
            </button>
            {backfillStatus && <small className="muted">{backfillStatus}</small>}
          </>
        }
      />
      {deckOpen && (
        <DiscoveryDeck<VideogameDeckIdea>
          eyebrow="Game Discovery Deck"
          heading="Need something to play?"
          curatedDeck={VIDEOGAME_DISCOVERY_DECK}
          existingTitles={existingTitles}
          systemPrompt={VIDEOGAME_DECK_SYSTEM_PROMPT}
          buildPrompt={buildVideogameDeckPrompt}
          parseIdeas={parseVideogameDeckIdeas}
          addLabel="Add to my list"
          onAdd={addFromDeck}
          onClose={() => setDeckOpen(false)}
          resolveCover={igdbReady ? title => resolveRealCoverArt(title, searchGames) : undefined}
          renderPills={idea => <span className="bucket-status-pill status-someday">{idea.genre}</span>}
          renderSubline={idea => (idea.developer || idea.platform)
            ? <small>{[idea.developer, idea.platform].filter(Boolean).join(' · ')}</small>
            : null}
        />
      )}
    </>
  );
}
