import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { DiscoveryDeck } from '../components/DiscoveryDeck';
import { useStore, newRecord } from '../store';
import { searchBooks } from '../lib/openLibrary';
import { resolveRealCoverArt } from '../lib/coverArt';
import {
  BOOK_DISCOVERY_DECK, BOOK_DECK_SYSTEM_PROMPT, buildBookDeckPrompt, parseBookDeckIdeas, type BookDeckIdea
} from '../lib/bookDeck';
import type { Book } from '../types';

export function Books() {
  const { data, upsert } = useStore();
  const [deckOpen, setDeckOpen] = useState(false);
  const existingTitles = new Set(data.books.map(b => b.title.trim().toLowerCase()));

  const addFromDeck = (idea: BookDeckIdea) => {
    void upsert('books', newRecord<Book>({
      title: idea.title,
      coverArt: idea.coverArt,
      author: idea.author,
      genre: [idea.genre],
      description: idea.blurb,
      status: 'To Read'
    }));
  };

  return (
    <>
      <CollectionPage<Book>
        collection="books"
        itemLabel="Book"
        title="Books"
        subtitle="What to read, what you're reading, what you've finished"
        fields={[
          { key: 'coverArt', label: 'Cover Art', type: 'image', placeholder: 'https://…' },
          { key: 'title', label: 'Title', type: 'text' },
          { key: 'author', label: 'Author', type: 'text' },
          { key: 'series', label: 'Series', type: 'text' },
          { key: 'seriesNumber', label: 'Book #', type: 'number' },
          { key: 'genre', label: 'Genre', type: 'multiselect', placeholder: 'Select genres…', options: [
            'Fiction', 'Non-Fiction', 'Fantasy', 'Science Fiction', 'Mystery', 'Thriller', 'Romance',
            'Horror', 'Biography', 'Memoir', 'History', 'Self-Help', 'Business', 'Science', 'Philosophy',
            'Poetry', 'Young Adult', "Children's", 'Classics', 'Graphic Novel'
          ] },
          { key: 'format', label: 'Format', type: 'select', options: ['Physical', 'Ebook', 'Audiobook'] },
          { key: 'pageCount', label: 'Page Count', type: 'number' },
          { key: 'status', label: 'Status', type: 'select', options: ['To Read', 'Reading', 'Read'] },
          { key: 'rating', label: 'Rating (1-5)', type: 'number' },
          { key: 'progress', label: 'Progress', type: 'number', placeholder: 'Current page or %' },
          { key: 'dateStarted', label: 'Date Started', type: 'date' },
          { key: 'dateFinished', label: 'Date Finished', type: 'date' },
          { key: 'tags', label: 'Tags', type: 'tags', placeholder: 'Book Club, Re-read…' },
          { key: 'description', label: 'Description', type: 'richtext', placeholder: 'What is this book about?' },
          { key: 'notes', label: 'Notes / Quotes', type: 'richtext' }
        ]}
        defaults={{ title: '', status: 'To Read' }}
        renderTitle={b => b.title}
        renderSubtitle={b => `${b.author ? `${b.author} · ` : ''}${b.status}${b.rating ? ` · ${b.rating}/5` : ''}`}
        sortBy={(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()}
        gallery={{
          coverKey: 'coverArt',
          coverAccent: 'linear-gradient(155deg, var(--teal-soft), var(--teal) 130%)',
          badge: b => b.status,
          rating: b => b.rating,
          meta: b => b.author
        }}
        statusFilter={{
          key: 'status',
          groups: [
            { label: 'In Progress', values: ['Reading'] },
            { label: 'Completed', values: ['Read'] }
          ],
          allExcludesGrouped: true
        }}
        genreFilter={{ key: 'genre' }}
        autofill={{ titleKey: 'title', search: searchBooks }}
        needsReviewKey="needsReview"
        headerExtra={
          <button type="button" className="btn ghost" onClick={() => setDeckOpen(true)}><Sparkles size={16} /> Discover</button>
        }
      />
      {deckOpen && (
        <DiscoveryDeck<BookDeckIdea>
          eyebrow="Book Discovery Deck"
          heading="Need something to read?"
          curatedDeck={BOOK_DISCOVERY_DECK}
          existingTitles={existingTitles}
          systemPrompt={BOOK_DECK_SYSTEM_PROMPT}
          buildPrompt={buildBookDeckPrompt}
          parseIdeas={parseBookDeckIdeas}
          addLabel="Add to my list"
          onAdd={addFromDeck}
          onClose={() => setDeckOpen(false)}
          resolveCover={title => resolveRealCoverArt(title, searchBooks)}
          renderPills={idea => <span className="bucket-status-pill status-someday">{idea.genre}</span>}
          renderSubline={idea => idea.author ? <small>{idea.author}</small> : null}
        />
      )}
    </>
  );
}
