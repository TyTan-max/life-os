import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { DiscoveryDeck } from '../components/DiscoveryDeck';
import { useStore, newRecord } from '../store';
import { checkIgdbConfigured, searchGames } from '../lib/igdb';
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
          <button type="button" className="btn ghost" onClick={() => setDeckOpen(true)}><Sparkles size={16} /> Discover</button>
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
