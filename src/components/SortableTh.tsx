import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> { key: K; dir: SortDir; }

export function toggleSort<K extends string>(prev: SortState<K>, key: K, defaultDir: SortDir = 'asc'): SortState<K> {
  if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: defaultDir };
}

// Nullable variant for grids that also support manual drag reordering — the third click
// clears the sort and falls back to whatever order the user last dragged the rows into.
export type GridSortState<K extends string> = SortState<K> | null;

export function toggleGridSort<K extends string>(prev: GridSortState<K>, key: K, defaultDir: SortDir = 'asc'): GridSortState<K> {
  if (!prev || prev.key !== key) return { key, dir: defaultDir };
  if (prev.dir === defaultDir) return { key, dir: defaultDir === 'asc' ? 'desc' : 'asc' };
  return null;
}

// The clickable label+icon on its own, for headers that need extra content (like a
// "manage options" pencil button) alongside the sort control inside the same <th>.
export function SortableThLabel<K extends string>({
  label, sortKey, state, onSort
}: { label: string; sortKey: K; state: SortState<K> | null; onSort: (key: K) => void }) {
  const active = state?.key === sortKey;
  return (
    <span className="sortable-th-inner" onClick={() => onSort(sortKey)}>
      {label}
      <span className={`sort-icon ${active ? 'active' : ''}`}>
        {active ? (state!.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />) : <ChevronsUpDown size={11} />}
      </span>
    </span>
  );
}

// Sortable worksheet-table header: click to sort A-Z/low-high, click again for Z-A/high-low.
export function SortableTh<K extends string>({
  label, sortKey, state, onSort
}: { label: string; sortKey: K; state: SortState<K> | null; onSort: (key: K) => void }) {
  return (
    <th className="sortable-th">
      <SortableThLabel label={label} sortKey={sortKey} state={state} onSort={onSort} />
    </th>
  );
}
