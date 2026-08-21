import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { DiscoveryDeck } from '../components/DiscoveryDeck';
import { useStore, newRecord } from '../store';
import { searchMoviesAndTv, tmdbConfigured } from '../lib/tmdb';
import { resolveRealCoverArt } from '../lib/coverArt';
import {
  MOVIE_DISCOVERY_DECK, MOVIE_DECK_SYSTEM_PROMPT, buildMovieDeckPrompt, parseMovieDeckIdeas, type MovieDeckIdea
} from '../lib/movieDeck';
import type { Movie } from '../types';

export function Movies() {
  const { data, upsert } = useStore();
  const [deckOpen, setDeckOpen] = useState(false);
  const existingTitles = new Set(data.movies.map(m => m.title.trim().toLowerCase()));

  const addFromDeck = (idea: MovieDeckIdea) => {
    void upsert('movies', newRecord<Movie>({
      title: idea.title,
      coverArt: idea.coverArt,
      director: idea.director,
      releaseYear: idea.releaseYear,
      genres: [idea.genre],
      description: idea.blurb,
      status: 'To Watch'
    }));
  };

  return (
    <>
      <CollectionPage<Movie>
        collection="movies"
        itemLabel="Movie"
        title="Movies & TV"
        subtitle="What to watch, what you're watching, what you've seen"
        fields={[
          { key: 'coverArt', label: 'Cover / Poster Art', type: 'image', placeholder: 'https://…' },
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'mediaType', label: 'Type', type: 'select', options: ['Movie', 'TV Series', 'Documentary', 'Anime'] },
          { key: 'director', label: 'Director / Creator', type: 'text' },
          { key: 'releaseYear', label: 'Release Year', type: 'number' },
          { key: 'genres', label: 'Genres', type: 'multiselect', placeholder: 'Select genres…', options: [
            'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
            'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'TV Movie',
            'Thriller', 'War', 'Western'
          ] },
          { key: 'runtimeMin', label: 'Runtime (min)', type: 'number', placeholder: 'Movies only' },
          { key: 'seasonsEpisodes', label: 'Seasons / Episodes', type: 'text', placeholder: 'e.g. 3 / 24 — TV only' },
          { key: 'episodeProgress', label: 'Episode Progress', type: 'number', placeholder: 'Episodes watched — TV only' },
          { key: 'status', label: 'Status', type: 'select', options: ['To Watch', 'Watching', 'Watched'] },
          { key: 'rating', label: 'Rating (1-5)', type: 'number' },
          { key: 'whereToWatch', label: 'Where to Watch', type: 'tags', placeholder: 'Netflix, Theater…' },
          { key: 'dateCompleted', label: 'Date Completed', type: 'date' },
          { key: 'tags', label: 'Tags', type: 'tags', placeholder: 'Date Night, Rewatch…' },
          { key: 'description', label: 'Description', type: 'richtext', placeholder: 'What is this movie or show about?' },
          { key: 'notes', label: 'Notes / Review', type: 'richtext' }
        ]}
        defaults={{ title: '', status: 'To Watch' }}
        renderTitle={m => m.title}
        renderSubtitle={m => `${m.mediaType ?? 'Movie'} · ${m.status}${m.rating ? ` · ${m.rating}/5` : ''}`}
        sortBy={(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()}
        gallery={{
          coverKey: 'coverArt',
          coverAccent: 'linear-gradient(155deg, var(--amber-soft), var(--amber) 130%)',
          badge: m => m.status,
          rating: m => m.rating,
          meta: m => [m.director, m.releaseYear].filter(Boolean).join(' · ') || undefined
        }}
        statusFilter={{
          key: 'status',
          groups: [
            { label: 'In Progress', values: ['Watching'] },
            { label: 'Completed', values: ['Watched'] }
          ],
          allExcludesGrouped: true
        }}
        genreFilter={{ key: 'genres' }}
        autofill={{
          titleKey: 'title',
          search: searchMoviesAndTv,
          disabledReason: tmdbConfigured ? undefined : 'Add a free TMDb API key in .env.local to autofill from a title'
        }}
        needsReviewKey="needsReview"
        headerExtra={
          <button type="button" className="btn ghost" onClick={() => setDeckOpen(true)}><Sparkles size={16} /> Discover</button>
        }
      />
      {deckOpen && (
        <DiscoveryDeck<MovieDeckIdea>
          eyebrow="Movie Discovery Deck"
          heading="Need something to watch?"
          curatedDeck={MOVIE_DISCOVERY_DECK}
          existingTitles={existingTitles}
          systemPrompt={MOVIE_DECK_SYSTEM_PROMPT}
          buildPrompt={buildMovieDeckPrompt}
          parseIdeas={parseMovieDeckIdeas}
          addLabel="Add to my list"
          onAdd={addFromDeck}
          onClose={() => setDeckOpen(false)}
          resolveCover={tmdbConfigured ? title => resolveRealCoverArt(title, searchMoviesAndTv) : undefined}
          renderPills={idea => <span className="bucket-status-pill status-someday">{idea.genre}</span>}
          renderSubline={idea => (idea.director || idea.releaseYear)
            ? <small>{[idea.director, idea.releaseYear].filter(Boolean).join(' · ')}</small>
            : null}
        />
      )}
    </>
  );
}
