import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Layers, Plus, RotateCcw, Shuffle, Trash2, Upload, X } from 'lucide-react';
import { newRecord, useStore } from '../store';
import type { Flashcard, FlashcardDeck } from '../types';
import { generateId } from '../utils/id';
import { EmptyState, Modal } from './UI';

const blankCard = (): Flashcard => ({ id: generateId(), term: '', definition: '' });

// A textarea that grows to fit its text instead of scrolling. Height is reset to auto first so it
// can also shrink back when text is deleted, and re-measured on window resize because a narrower
// column wraps the same text onto more lines.
function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight excludes the border, but the box is border-box — add it back or the last
    // line ends up clipped by a couple of pixels.
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  };
  useLayoutEffect(fit, [props.value]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return <textarea {...props} ref={ref} rows={1} />;
}

// Bulk import: one card per line. Picks whichever separator actually appears in the pasted text
// (tab first — what copying two spreadsheet/Quizlet columns produces — then " - ", then a comma)
// and splits each line on the first occurrence only, so a definition can itself contain the
// separator without being cut short.
function parseImport(text: string): Flashcard[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const separator = lines.some(l => l.includes('\t')) ? '\t'
    : lines.some(l => / [-–—] /.test(l)) ? / [-–—] /
    : ',';
  const cards: Flashcard[] = [];
  for (const line of lines) {
    const match = typeof separator === 'string' ? line.indexOf(separator) : line.search(separator);
    if (match === -1) continue;
    const len = typeof separator === 'string' ? separator.length : (line.match(separator)?.[0].length ?? 0);
    const term = line.slice(0, match).trim();
    const definition = line.slice(match + len).trim();
    if (term && definition) cards.push({ id: generateId(), term, definition });
  }
  return cards;
}

function shuffled<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function Flashcards({ workspaceId }: { workspaceId: string }) {
  const { data, upsert, remove } = useStore();
  const decks = useMemo(
    () => data.flashcardDecks.filter(d => d.workspaceId === workspaceId).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')),
    [data.flashcardDecks, workspaceId]
  );
  const [openDeckId, setOpenDeckId] = useState<string | null>(null);
  const [studyDeckId, setStudyDeckId] = useState<string | null>(null);
  const [newDeckName, setNewDeckName] = useState('');

  // A workspace switch (or a deleted deck) can leave these pointing at a deck that's no longer in view.
  const openDeck = decks.find(d => d.id === openDeckId) ?? null;
  const studyDeck = decks.find(d => d.id === studyDeckId) ?? null;

  const createDeck = async () => {
    const name = newDeckName.trim();
    if (!name) return;
    const deck = newRecord<FlashcardDeck>({ name, workspaceId, cards: [blankCard(), blankCard(), blankCard()] });
    await upsert('flashcardDecks', deck);
    setNewDeckName('');
    setOpenDeckId(deck.id);
  };

  if (studyDeck) return <StudyMode deck={studyDeck} onExit={() => setStudyDeckId(null)} />;

  if (openDeck) {
    return (
      <DeckEditor
        deck={openDeck}
        onBack={() => setOpenDeckId(null)}
        onStudy={() => setStudyDeckId(openDeck.id)}
        onDelete={async () => {
          await remove('flashcardDecks', openDeck.id);
          setOpenDeckId(null);
        }}
      />
    );
  }

  return (
    <div className="fc-shell">
      <div className="fc-decks-header">
        <h2>Flashcard decks</h2>
        <div className="fc-new-deck">
          <input
            type="text"
            value={newDeckName}
            placeholder="New deck name…"
            onChange={e => setNewDeckName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void createDeck(); }}
          />
          <button type="button" className="btn primary small" onClick={() => void createDeck()} disabled={!newDeckName.trim()}>
            <Plus size={14} /> Create deck
          </button>
        </div>
      </div>
      {decks.length ? (
        <div className="fc-deck-grid">
          {decks.map(deck => {
            const filled = deck.cards.filter(c => c.term.trim() && c.definition.trim()).length;
            return (
              <button type="button" key={deck.id} className="fc-deck-card" onClick={() => setOpenDeckId(deck.id)}>
                <Layers size={18} />
                <b>{deck.name}</b>
                <span>{filled} card{filled === 1 ? '' : 's'}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState>No decks in this workspace yet — name one above to start adding cards.</EmptyState>
      )}
    </div>
  );
}

function DeckEditor({ deck, onBack, onStudy, onDelete }: {
  deck: FlashcardDeck; onBack: () => void; onStudy: () => void; onDelete: () => void;
}) {
  const { upsert } = useStore();
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = (patch: Partial<FlashcardDeck>) => { void upsert('flashcardDecks', { ...deck, ...patch }); };
  const setCard = (id: string, patch: Partial<Flashcard>) =>
    save({ cards: deck.cards.map(c => (c.id === id ? { ...c, ...patch } : c)) });
  const studyable = deck.cards.filter(c => c.term.trim() && c.definition.trim()).length;
  const preview = useMemo(() => parseImport(importText), [importText]);

  const runImport = () => {
    if (!preview.length) return;
    // Drop untouched blank rows first so an import into a fresh deck doesn't leave 3 empty rows on top.
    const kept = deck.cards.filter(c => c.term.trim() || c.definition.trim());
    save({ cards: [...kept, ...preview] });
    setImportText('');
    setImportOpen(false);
  };

  return (
    <div className="fc-shell">
      <div className="fc-editor-top">
        <button type="button" className="btn ghost small" onClick={onBack}><ArrowLeft size={14} /> Decks</button>
        <div className="fc-editor-actions">
          <button type="button" className="btn ghost small" onClick={() => setImportOpen(true)}><Upload size={14} /> Import</button>
          <button type="button" className="icon-btn danger" onClick={() => setConfirmDelete(true)} title="Delete deck" aria-label="Delete deck"><Trash2 size={15} /></button>
          <button type="button" className="btn primary" onClick={onStudy} disabled={studyable === 0} title={studyable === 0 ? 'Fill in at least one card first' : undefined}>
            <Layers size={15} /> Study ({studyable})
          </button>
        </div>
      </div>

      <input
        type="text"
        className="fc-deck-title"
        value={deck.name}
        placeholder="Deck name"
        onChange={e => save({ name: e.target.value })}
      />

      <div className="fc-list">
        <div className="fc-list-head"><span>#</span><span>Term</span><span>Definition</span><span /></div>
        {deck.cards.map((card, index) => (
          <div className="fc-row" key={card.id}>
            <span className="fc-row-num">{index + 1}</span>
            <AutoTextarea
              value={card.term}
              placeholder="Term"
              onChange={e => setCard(card.id, { term: e.target.value })}
            />
            <AutoTextarea
              value={card.definition}
              placeholder="Definition"
              onChange={e => setCard(card.id, { definition: e.target.value })}
            />
            <button type="button" className="icon-btn" onClick={() => save({ cards: deck.cards.filter(c => c.id !== card.id) })} aria-label={`Delete card ${index + 1}`}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn teal fc-add-card" onClick={() => save({ cards: [...deck.cards, blankCard()] })}>
        <Plus size={16} /> Add card
      </button>

      {importOpen && (
        <Modal
          eyebrow="Flashcards"
          title="Import cards"
          onClose={() => setImportOpen(false)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setImportOpen(false)}>Cancel</button>
            <button type="button" className="btn teal" onClick={runImport} disabled={!preview.length}>
              Import {preview.length || ''} card{preview.length === 1 ? '' : 's'}
            </button>
          </>}
        >
          <p className="muted">One card per line — term, then definition, separated by a tab, a dash (<code>term - definition</code>), or a comma.</p>
          <textarea
            className="fc-import-text"
            rows={9}
            value={importText}
            placeholder={'mitosis - cell division that produces two identical cells\nphotosynthesis - how plants turn light into energy'}
            onChange={e => setImportText(e.target.value)}
            autoFocus
          />
          <p className="muted">{importText.trim() ? `${preview.length} card${preview.length === 1 ? '' : 's'} detected` : 'Paste your list above.'}</p>
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          eyebrow="Flashcards"
          title="Delete deck"
          onClose={() => setConfirmDelete(false)}
          footer={<>
            <button type="button" className="btn ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button type="button" className="btn danger" onClick={onDelete}>Delete</button>
          </>}
        >
          <p>Delete “{deck.name || 'Untitled deck'}” and all {deck.cards.length} of its cards? This cannot be undone.</p>
        </Modal>
      )}
    </div>
  );
}

function StudyMode({ deck, onExit }: { deck: FlashcardDeck; onExit: () => void }) {
  const playable = useMemo(() => deck.cards.filter(c => c.term.trim() && c.definition.trim()), [deck.cards]);
  const [queue, setQueue] = useState<Flashcard[]>(playable);
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [round, setRound] = useState(1);

  const finished = index >= queue.length;
  const card = queue[index];

  const go = (next: number) => { setIndex(Math.max(0, next)); setFlipped(false); };
  const mark = (didKnow: boolean) => {
    if (!card) return;
    setKnown(prev => {
      const next = new Set(prev);
      if (didKnow) next.add(card.id); else next.delete(card.id);
      return next;
    });
    go(index + 1);
  };
  const restart = (cards: Flashcard[]) => {
    setQueue(cards);
    setKnown(new Set());
    setRound(r => r + 1);
    go(0);
  };
  const stillLearning = queue.filter(c => !known.has(c.id));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFlipped(f => !f); }
      else if (e.key === 'ArrowRight') go(index + 1);
      else if (e.key === 'ArrowLeft') go(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, index]);

  return (
    <div className="fc-shell fc-study">
      <div className="fc-editor-top">
        <button type="button" className="btn ghost small" onClick={onExit}><ArrowLeft size={14} /> Back to deck</button>
        <b className="fc-study-title">{deck.name || 'Untitled deck'}</b>
        <button type="button" className="btn ghost small" onClick={() => restart(shuffled(queue))} title="Shuffle the cards and start over">
          <Shuffle size={14} /> Shuffle
        </button>
      </div>

      {finished ? (
        <div className="fc-done">
          <h2>{stillLearning.length === 0 ? 'You knew them all!' : 'Round complete'}</h2>
          <p>
            You knew <b>{known.size}</b> of <b>{queue.length}</b> card{queue.length === 1 ? '' : 's'}.
          </p>
          <div className="fc-done-actions">
            {stillLearning.length > 0 && (
              <button type="button" className="btn primary" onClick={() => restart(shuffled(stillLearning))}>
                Study {stillLearning.length} still learning
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => restart(playable)}><RotateCcw size={14} /> Restart all {playable.length}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="fc-progress">
            <div className="fc-progress-bar"><span style={{ width: `${(index / queue.length) * 100}%` }} /></div>
            <small>{index + 1} / {queue.length}{round > 1 ? ` · round ${round}` : ''}</small>
          </div>
          <button
            type="button"
            key={`${round}-${card.id}`}
            className={`fc-card ${flipped ? 'flipped' : ''}`}
            onClick={() => setFlipped(f => !f)}
            aria-label={flipped ? 'Showing definition — click to flip' : 'Showing term — click to flip'}
          >
            <span className="fc-face fc-front"><small>Term</small>{card.term}</span>
            <span className="fc-face fc-back"><small>Definition</small>{card.definition}</span>
          </button>
          <p className="fc-hint">Click the card or press Space to flip · ← → to move</p>
          <div className="fc-study-actions">
            <button type="button" className="btn ghost" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous card"><ChevronLeft size={16} /></button>
            <button type="button" className="btn ghost fc-learning" onClick={() => mark(false)}>Still learning</button>
            <button type="button" className="btn teal" onClick={() => mark(true)}>Got it</button>
            <button type="button" className="btn ghost" onClick={() => go(index + 1)} aria-label="Skip card"><ChevronRight size={16} /></button>
          </div>
        </>
      )}
    </div>
  );
}
