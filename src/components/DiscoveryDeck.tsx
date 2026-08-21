import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Plus, Sparkles, X } from 'lucide-react';
import { complete, loadSavedEngine, ENGINE_LABELS, ENGINE_STORAGE_KEY, type Engine } from '../lib/aiEngine';

const GENERATE_COUNT = 6;

export interface BaseDeckIdea {
  id: string;
  title: string;
  coverArt: string;
  blurb: string;
}

// A generic swipeable "discovery deck" modal — curated ideas plus on-demand AI-generated
// ones, deduplicated against what's already in the collection. Extracted from the Travel
// tab's bucket-list deck so Movies/Videogames/Books can reuse the same mechanic with their
// own curated lists, prompts, and card rendering.
export function DiscoveryDeck<T extends BaseDeckIdea>({
  eyebrow, heading, curatedDeck, existingTitles, systemPrompt, buildPrompt, parseIdeas,
  renderPills, renderSubline, addLabel = 'Add to my list', onAdd, onClose, resolveCover
}: {
  eyebrow: string;
  heading: string;
  curatedDeck: T[];
  existingTitles: Set<string>;
  systemPrompt: string;
  buildPrompt: (count: number, avoidTitles: string[]) => string;
  parseIdeas: (raw: string) => T[];
  renderPills?: (idea: T) => ReactNode;
  renderSubline?: (idea: T) => ReactNode;
  addLabel?: string;
  onAdd: (idea: T) => void;
  onClose: () => void;
  // Looks up the real poster/cover/box-art for a title (e.g. via TMDb/IGDB/Open Library —
  // whatever the collection's own autofill already uses), replacing the placeholder image.
  resolveCover?: (title: string) => Promise<string | undefined>;
}) {
  const [generatedIdeas, setGeneratedIdeas] = useState<T[]>([]);
  const [engine, setEngine] = useState<Engine>(loadSavedEngine);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [resolvedCovers, setResolvedCovers] = useState<Record<string, string>>({});

  const deck = useMemo(() => {
    const seen = new Set(existingTitles);
    const combined = [...curatedDeck, ...generatedIdeas];
    const out: T[] = [];
    for (const d of combined) {
      const key = d.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
    return out;
  }, [existingTitles, generatedIdeas, curatedDeck]);

  // Resolves real cover art for any deck entry that doesn't have one cached yet — runs for
  // the curated deck on open and again whenever new AI ideas are generated.
  useEffect(() => {
    if (!resolveCover) return;
    const missing = deck.filter(d => !(d.id in resolvedCovers));
    if (!missing.length) return;
    let cancelled = false;
    Promise.all(missing.map(async d => [d.id, await resolveCover(d.title).catch(() => undefined)] as const))
      .then(pairs => {
        if (cancelled) return;
        const found = pairs.filter((p): p is [string, string] => Boolean(p[1]));
        if (found.length) setResolvedCovers(prev => ({ ...prev, ...Object.fromEntries(found) }));
      });
    return () => { cancelled = true; };
  }, [deck, resolveCover, resolvedCovers]);

  const [index, setIndex] = useState(0);
  const [justAddedId, setJustAddedId] = useState<string | null>(null);

  const idea = deck[index];

  const goNext = () => setIndex(i => Math.min(i + 1, deck.length - 1));
  const goPrev = () => setIndex(i => Math.max(i - 1, 0));

  const handleAdd = () => {
    if (!idea) return;
    const resolved = resolvedCovers[idea.id];
    onAdd(resolved ? { ...idea, coverArt: resolved } : idea);
    setJustAddedId(idea.id);
    window.setTimeout(() => {
      setJustAddedId(null);
      setIndex(i => Math.min(i + 1, deck.length - 1));
    }, 650);
  };

  const changeEngine = (next: Engine) => {
    setEngine(next);
    window.localStorage.setItem(ENGINE_STORAGE_KEY, next);
  };

  const generateMore = async () => {
    if (generating) return;
    setGenerating(true);
    setGenError(null);
    const jumpTo = deck.length;
    try {
      const avoid = [...existingTitles, ...deck.map(d => d.title.toLowerCase())];
      const raw = await complete(engine, systemPrompt, buildPrompt(GENERATE_COUNT, avoid));
      const parsed = parseIdeas(raw);
      if (!parsed.length) throw new Error('Got a response but couldn’t make sense of it as ideas — try again, or switch engines.');
      setGeneratedIdeas(prev => [...prev, ...parsed]);
      setIndex(jumpTo);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Something went wrong generating ideas.');
    } finally {
      setGenerating(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  return (
    <div className="deck-overlay" onClick={onClose}>
      <div className="deck-panel" onClick={e => e.stopPropagation()}>
        <div className="deck-header">
          <div>
            <span className="modal-eyebrow">{eyebrow}</span>
            <h2>{heading}</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="deck-generate-row">
          <select
            className="deck-engine-select"
            value={engine}
            onChange={e => changeEngine(e.target.value as Engine)}
            disabled={generating}
            aria-label="AI engine"
          >
            <option value="local">{ENGINE_LABELS.local}</option>
            <option value="cloud">{ENGINE_LABELS.cloud}</option>
          </select>
          <button type="button" className="btn ghost small" onClick={() => void generateMore()} disabled={generating}>
            <Sparkles size={13} /> {generating ? 'Generating…' : 'Generate new ideas'}
          </button>
        </div>
        {genError && (
          <div className="deck-error"><AlertTriangle size={13} /> {genError}</div>
        )}

        {idea ? (
          <>
            <div className="deck-stage">
              <button type="button" className="deck-nav" onClick={goPrev} disabled={index === 0} aria-label="Previous idea"><ChevronLeft size={20} /></button>
              <div className="deck-card" key={idea.id} style={{ backgroundImage: `url(${resolvedCovers[idea.id] ?? idea.coverArt})` }}>
                <span className="deck-card-scrim" aria-hidden="true" />
                <div className="deck-card-top">
                  {renderPills?.(idea)}
                  {idea.id.startsWith('ai-') && <span className="bucket-cost-pill deck-ai-badge"><Sparkles size={10} /> AI</span>}
                </div>
                <div className="deck-card-body">
                  {renderSubline?.(idea)}
                  <b>{idea.title}</b>
                  <p>{idea.blurb}</p>
                </div>
              </div>
              <button type="button" className="deck-nav" onClick={goNext} disabled={index === deck.length - 1} aria-label="Next idea"><ChevronRight size={20} /></button>
            </div>
            <div className="deck-footer">
              <span className="deck-count">{index + 1} of {deck.length}</span>
              <div className="deck-actions">
                <button type="button" className="btn ghost" onClick={goNext} disabled={index === deck.length - 1}>Skip</button>
                <button type="button" className="btn teal" onClick={handleAdd} disabled={justAddedId === idea.id}>
                  {justAddedId === idea.id ? <><Check size={15} /> Added</> : <><Plus size={15} /> {addLabel}</>}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="deck-empty">
            <Sparkles size={26} />
            <p>You’ve added every idea in the deck — nice.</p>
            <button type="button" className="btn teal" onClick={() => void generateMore()} disabled={generating}>
              <Sparkles size={14} /> {generating ? 'Generating…' : 'Generate new ideas'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
