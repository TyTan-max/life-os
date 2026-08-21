import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Kpi, formatCurrency } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { NumberCell, NotesCell } from '../components/GridCells';
import { ListManagerModal } from '../components/ListManagerModal';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { SortableTh, SortableThLabel, toggleGridSort } from '../components/SortableTh';
import type { GridSortState } from '../components/SortableTh';
import { isLiabilityAccount } from './FinanceAccounts';
import { CORE_SAVINGS_CATEGORIES } from '../types';
import type { FinanceGoal, FinanceGoalCategory } from '../types';
import { useState } from 'react';

type GoalStatus = 'Ahead' | 'On Track' | 'Behind';

function goalStatus(goal: FinanceGoal): GoalStatus | undefined {
  if (!goal.targetDate) return undefined;
  const start = new Date(goal.createdAt).getTime();
  const target = new Date(`${goal.targetDate}T12:00:00`).getTime();
  const now = Date.now();
  if (target <= start) return undefined;
  const expectedPct = Math.min(100, Math.max(0, ((now - start) / (target - start)) * 100));
  const actualPct = goal.targetAmount > 0 ? (goal.currentAmount / goal.targetAmount) * 100 : 0;
  const diff = actualPct - expectedPct;
  if (diff >= 5) return 'Ahead';
  if (diff <= -5) return 'Behind';
  return 'On Track';
}

export function FinanceSavingsGrid() {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const goals = data.financeGoals;
  const accounts = data.financeAccounts.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const linkableAccounts = accounts.filter(a => !isLiabilityAccount(a.type));
  const customCategories = data.settings.customSavingsCategories ?? [];
  const allCategories: FinanceGoalCategory[] = [...CORE_SAVINGS_CATEGORIES, ...customCategories];
  const [manageCategories, setManageCategories] = useState(false);

  const linkedAccountName = (id?: string) => accounts.find(a => a.id === id)?.name ?? '';

  // Drag-to-reorder sets each goal's own `order` field; a header sort temporarily displays
  // by the clicked column instead, and clicking that header a third time falls back to drag order.
  type GoalSortKey = 'name' | 'target' | 'category' | 'saved' | 'targetDate' | 'linkedAccount';
  const [sort, setSort] = useState<GridSortState<GoalSortKey>>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const orderedGoals = goals.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const sortedGoals = sort
    ? orderedGoals.slice().sort((a, b) => {
        let cmp = 0;
        switch (sort.key) {
          case 'name': cmp = a.name.localeCompare(b.name); break;
          case 'target': cmp = a.targetAmount - b.targetAmount; break;
          case 'category': cmp = a.category.localeCompare(b.category); break;
          case 'saved': cmp = a.currentAmount - b.currentAmount; break;
          case 'targetDate': cmp = (a.targetDate ?? '').localeCompare(b.targetDate ?? ''); break;
          case 'linkedAccount': cmp = linkedAccountName(a.linkedAccountId).localeCompare(linkedAccountName(b.linkedAccountId)); break;
        }
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : orderedGoals;

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = orderedGoals.map(g => g.id);
    const fromIndex = ids.indexOf(dragId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) { setDragId(null); return; }
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, dragId);
    next.forEach((id, index) => {
      const goal = goals.find(g => g.id === id);
      if (goal && goal.order !== index) void upsert('financeGoals', { ...goal, order: index });
    });
    setDragId(null);
  };

  const totalTarget = goals.reduce((s, g) => s + g.targetAmount, 0);
  const totalSaved = goals.reduce((s, g) => s + g.currentAmount, 0);
  const onTrackCount = goals.filter(g => { const s = goalStatus(g); return s === 'Ahead' || s === 'On Track'; }).length;

  const patch = (goal: FinanceGoal, p: Partial<FinanceGoal>) => {
    void upsert('financeGoals', { ...goal, ...p });
  };

  const addGoal = () => {
    void upsert('financeGoals', newRecord<FinanceGoal>({ name: '', category: 'Custom', targetAmount: 0, currentAmount: 0, order: goals.length }));
  };

  const addCategory = (name: string) => {
    if (allCategories.some(c => c.toLowerCase() === name.toLowerCase())) return;
    void updateSettings({ customSavingsCategories: [...customCategories, name] });
  };

  const deleteCategory = (name: string) => {
    void updateSettings({ customSavingsCategories: customCategories.filter(c => c !== name) });
  };

  const reorderCategories = (orderedIds: string[]) => {
    const nextCustom = orderedIds.filter(id => !(CORE_SAVINGS_CATEGORIES as readonly string[]).includes(id));
    void updateSettings({ customSavingsCategories: nextCustom });
  };

  const editingGoal = sortedGoals.find(g => g.id === editingId) ?? null;

  if (isMobile) {
    return (
      <>
        <div className="kpi-grid four">
          <Kpi label="Goals" value={goals.length} caption="being tracked" tone="default" />
          <Kpi label="Total Target" value={formatCurrency(totalTarget)} caption="combined target amount" tone="blue" />
          <Kpi label="Total Saved" value={formatCurrency(totalSaved)} caption={totalTarget > 0 ? `${Math.round((totalSaved / totalTarget) * 100)}% of target` : undefined} tone="green" />
          <Kpi label="On Track" value={`${onTrackCount}/${goals.length}`} caption="ahead or on pace" tone={onTrackCount === goals.length && goals.length > 0 ? 'green' : 'amber'} />
        </div>

        <MobileRecordList
          items={sortedGoals}
          primary={g => g.name || 'Untitled goal'}
          secondary={g => `${g.category}${g.targetDate ? ` · due ${g.targetDate}` : ''}`}
          trailing={g => `${formatCurrency(g.currentAmount)} / ${formatCurrency(g.targetAmount)}`}
          trailingTone={g => (goalStatus(g) === 'Behind' ? 'negative' : goalStatus(g) === 'Ahead' ? 'positive' : undefined)}
          fields={[
            { label: 'Status', value: g => goalStatus(g) ?? '—' },
            { label: 'Linked account', value: g => linkedAccountName(g.linkedAccountId) || '—' }
          ]}
          onOpen={g => setEditingId(g.id)}
          onDelete={g => void remove('financeGoals', g.id)}
          deleteLabel={g => `Delete ${g.name || 'goal'}`}
          empty="No savings goals yet — add an emergency fund, a down payment, anything with a target."
        />
        <button type="button" className="btn teal grid-add-row" onClick={addGoal}><Plus size={16} /> Add goal</button>

        {editingGoal && (
          <Sheet title={editingGoal.name || 'Edit goal'} onClose={() => setEditingId(null)}>
            <div className="sheet-form">
              <label><span>Name</span><input type="text" value={editingGoal.name} placeholder="Goal name" onChange={e => patch(editingGoal, { name: e.target.value })} /></label>
              <label>
                <span>Category</span>
                <select value={editingGoal.category} onChange={e => patch(editingGoal, { category: e.target.value as FinanceGoalCategory })}>
                  {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label><span>Target amount</span><input type="number" inputMode="decimal" step="0.01" min={0} value={editingGoal.targetAmount} onChange={e => patch(editingGoal, { targetAmount: Number(e.target.value) })} /></label>
              <label><span>Saved so far</span><input type="number" inputMode="decimal" step="0.01" min={0} value={editingGoal.currentAmount} onChange={e => patch(editingGoal, { currentAmount: Number(e.target.value) })} /></label>
              <label><span>Target date</span><DatePicker value={editingGoal.targetDate ?? ''} onChange={v => patch(editingGoal, { targetDate: v })} /></label>
              <label>
                <span>Linked account</span>
                <select
                  value={editingGoal.linkedAccountId ?? ''}
                  onChange={e => {
                    const account = linkableAccounts.find(a => a.id === e.target.value);
                    patch(editingGoal, { linkedAccountId: e.target.value || undefined, ...(account ? { currentAmount: account.balance } : {}) });
                  }}
                >
                  <option value="">—</option>
                  {linkableAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <label><span>Notes</span><textarea rows={3} value={editingGoal.notes ?? ''} onChange={e => patch(editingGoal, { notes: e.target.value })} /></label>
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <>
      <div className="kpi-grid four">
        <Kpi label="Goals" value={goals.length} caption="being tracked" tone="default" />
        <Kpi label="Total Target" value={formatCurrency(totalTarget)} caption="combined target amount" tone="blue" />
        <Kpi label="Total Saved" value={formatCurrency(totalSaved)} caption={totalTarget > 0 ? `${Math.round((totalSaved / totalTarget) * 100)}% of target` : undefined} tone="green" />
        <Kpi label="On Track" value={`${onTrackCount}/${goals.length}`} caption="ahead or on pace" tone={onTrackCount === goals.length && goals.length > 0 ? 'green' : 'amber'} />
      </div>

      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th className="grid-drag-col" />
              <SortableTh label="Name" sortKey="name" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <th>
                <SortableThLabel label="Category" sortKey="category" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManageCategories(true)} aria-label="Manage categories" title="Add or remove savings categories">
                  <Pencil size={11} />
                </button>
              </th>
              <SortableTh label="Target" sortKey="target" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              <SortableTh label="Saved" sortKey="saved" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              <SortableTh label="Target Date" sortKey="targetDate" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <SortableTh label="Linked Account" sortKey="linkedAccount" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedGoals.map(g => (
              <tr
                key={g.id}
                className={dragId === g.id ? 'dragging' : ''}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(g.id)}
              >
                <td className="grid-drag-col">
                  <span
                    className="drag-handle"
                    draggable={!sort}
                    aria-disabled={Boolean(sort)}
                    title={sort ? 'Clear the sort to drag-reorder' : 'Drag to reorder'}
                    aria-label={`Drag to reorder ${g.name || 'goal'}`}
                    onDragStart={e => { if (sort) { e.preventDefault(); return; } setDragId(g.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <GripVertical size={13} />
                  </span>
                </td>
                <td><input type="text" className="grid-cell-input" value={g.name} placeholder="Goal name" onChange={e => patch(g, { name: e.target.value })} /></td>
                <td>
                  <select className="grid-cell-select" value={g.category} onChange={e => patch(g, { category: e.target.value as FinanceGoalCategory })}>
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="grid-td-compact"><NumberCell value={g.targetAmount} onChange={n => patch(g, { targetAmount: n })} min={0} decimals={2} /></td>
                <td className="grid-td-compact"><NumberCell value={g.currentAmount} onChange={n => patch(g, { currentAmount: n })} min={0} decimals={2} /></td>
                <td><DatePicker value={g.targetDate ?? ''} onChange={v => patch(g, { targetDate: v })} /></td>
                <td>
                  <select
                    className="grid-cell-select"
                    value={g.linkedAccountId ?? ''}
                    onChange={e => {
                      const account = linkableAccounts.find(a => a.id === e.target.value);
                      patch(g, { linkedAccountId: e.target.value || undefined, ...(account ? { currentAmount: account.balance } : {}) });
                    }}
                  >
                    <option value="">—</option>
                    {linkableAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </td>
                <td><NotesCell value={g.notes ?? ''} onChange={v => patch(g, { notes: v })} /></td>
                <td><button type="button" className="icon-btn danger" onClick={() => void remove('financeGoals', g.id)} aria-label={`Delete ${g.name || 'goal'}`}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sortedGoals.length && <p className="muted grid-table-empty">No savings goals yet — add an emergency fund, a down payment, anything with a target.</p>}
      </div>
      <button type="button" className="btn teal grid-add-row" onClick={addGoal}><Plus size={16} /> Add goal</button>

      {manageCategories && (
        <ListManagerModal
          title="Manage Savings Categories"
          subtitle="The built-in categories keep goal reporting consistent, so they can't be removed. Add your own on top of those."
          items={allCategories.map(c => ({ id: c, label: c, locked: (CORE_SAVINGS_CATEGORIES as readonly string[]).includes(c) }))}
          onAdd={addCategory}
          onDelete={deleteCategory}
          onReorder={reorderCategories}
          onClose={() => setManageCategories(false)}
          addPlaceholder="e.g. Wedding Fund"
        />
      )}
    </>
  );
}

