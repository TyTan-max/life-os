import { useState } from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { Modal } from './UI';

export interface ListManagerItem {
  id: string;
  label: string;
  meta?: string;
  locked?: boolean;
}

export function ListManagerModal({
  title, subtitle, items, onAdd, onDelete, onRename, onReorder, onClose, addPlaceholder
}: {
  title: string;
  subtitle?: string;
  items: ListManagerItem[];
  onAdd: (name: string) => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, nextLabel: string) => void;
  onReorder?: (orderedIds: string[]) => void;
  onClose: () => void;
  addPlaceholder?: string;
}) {
  const [name, setName] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  // Free-typing drafts per row, committed on blur/Enter — same pattern as Habits routine
  // rename: lets the field go blank mid-edit without a controlled value snapping back, and an
  // empty/unchanged commit is a no-op instead of persisting a blank label.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const commitRename = (item: ListManagerItem) => {
    const draft = drafts[item.id];
    setDrafts(({ [item.id]: _omit, ...rest }) => rest);
    if (draft === undefined) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === item.label) return;
    onRename?.(item.id, trimmed);
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setName('');
  };

  const handleDrop = (targetId: string) => {
    if (!onReorder || !dragId || dragId === targetId) { setDragId(null); return; }
    const ids = items.map(i => i.id);
    const fromIndex = ids.indexOf(dragId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) { setDragId(null); return; }
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, dragId);
    onReorder(next);
    setDragId(null);
  };

  return (
    <Modal title={title} eyebrow="Life OS" onClose={onClose}>
      {subtitle && <p className="list-manager-subtitle">{subtitle}</p>}
      <div className="list-manager-items">
        {items.length ? items.map(item => (
          <div
            className={`list-manager-row ${dragId === item.id ? 'dragging' : ''}`}
            key={item.id}
            onDragOver={onReorder ? e => e.preventDefault() : undefined}
            onDrop={onReorder ? () => handleDrop(item.id) : undefined}
          >
            {onReorder && !item.locked && (
              <span
                className="drag-handle"
                draggable
                title="Drag to reorder"
                aria-label={`Drag to reorder ${item.label}`}
                onDragStart={e => { setDragId(item.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => setDragId(null)}
              >
                <GripVertical size={13} />
              </span>
            )}
            {onRename && !item.locked ? (
              <input
                type="text"
                className="list-manager-row-input"
                value={drafts[item.id] ?? item.label}
                onChange={e => setDrafts(prev => ({ ...prev, [item.id]: e.target.value }))}
                onBlur={() => commitRename(item)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
            ) : (
              <span className="list-manager-row-label">{item.label}{item.meta && <small>{item.meta}</small>}</span>
            )}
            {item.locked ? (
              <small className="list-manager-locked" title="Built-in — can't be removed">Built-in</small>
            ) : (
              <button type="button" className="icon-btn danger" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.label}`}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        )) : <p className="muted empty-state">Nothing here yet — add your first one below.</p>}
      </div>
      <div className="list-manager-add">
        <input
          type="text"
          value={name}
          placeholder={addPlaceholder ?? 'Name…'}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        />
        <button type="button" className="btn teal small" onClick={submit}><Plus size={14} /> Add</button>
      </div>
    </Modal>
  );
}
