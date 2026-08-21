import { ChevronRight, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { SwipeRow } from './SwipeRow';

export interface MobileRecordField<T> {
  /** Short label shown above the value in the card's meta row. */
  label: string;
  value: (item: T) => ReactNode;
}

// The mobile counterpart to a `.grid-table`. Desktop grids carry 8–9 columns because bulk
// scanning is the point there; a phone card shows the three fields that identify a row and
// defers the rest to whatever detail view the page already has.
export function MobileRecordList<T extends { id: string }>({
  items, primary, secondary, trailing, trailingTone, fields, onOpen, onDelete, deleteLabel, empty
}: {
  items: T[];
  /** The line that identifies the record — a name, merchant, or title. */
  primary: (item: T) => ReactNode;
  /** Supporting line under the primary, e.g. a date or category. */
  secondary?: (item: T) => ReactNode;
  /** Right-aligned emphasis value, e.g. an amount or status. */
  trailing?: (item: T) => ReactNode;
  trailingTone?: (item: T) => 'positive' | 'negative' | undefined;
  /** Up to two extra label/value pairs shown beneath. Keep this short — the point is triage. */
  fields?: MobileRecordField<T>[];
  onOpen?: (item: T) => void;
  onDelete?: (item: T) => void;
  deleteLabel?: (item: T) => string;
  empty?: ReactNode;
}) {
  if (!items.length) return <p className="muted mrl-empty">{empty ?? 'Nothing here yet.'}</p>;

  return (
    <div className="mrl">
      {items.map(item => {
        const tone = trailingTone?.(item);
        return (
          <div className="mrl-card" key={item.id}>
            {/* The persistent icon below stays — a swipe is a shortcut on top of it, never the
                only way to delete a row, since a gesture with no visible affordance is easy to
                never discover in the first place. */}
            <SwipeRow
              disabled={!onDelete}
              trailing={onDelete ? { label: 'Delete', icon: <Trash2 size={16} />, onTrigger: () => onDelete(item) } : undefined}
            >
              {/* The whole card is the open target, not just a chevron — a 44px row beats a 24px icon. */}
              <button
                type="button"
                className="mrl-main"
                onClick={onOpen ? () => onOpen(item) : undefined}
                disabled={!onOpen}
              >
                <span className="mrl-text">
                  <b>{primary(item)}</b>
                  {secondary && <small>{secondary(item)}</small>}
                </span>
                {trailing && <span className={`mrl-trailing ${tone ?? ''}`}>{trailing(item)}</span>}
                {onOpen && <ChevronRight size={16} className="mrl-chevron" />}
              </button>
            </SwipeRow>

            {fields && fields.length > 0 && (
              <dl className="mrl-fields">
                {fields.map(f => (
                  <div key={f.label}>
                    <dt>{f.label}</dt>
                    <dd>{f.value(item)}</dd>
                  </div>
                ))}
              </dl>
            )}

            {onDelete && (
              <button
                type="button"
                className="mrl-delete"
                onClick={() => onDelete(item)}
                aria-label={deleteLabel ? deleteLabel(item) : 'Delete'}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
