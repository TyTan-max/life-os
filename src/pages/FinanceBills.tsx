import { useState } from 'react';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Kpi, formatCurrency, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { NumberCell, NotesCell } from '../components/GridCells';
import { ListManagerModal } from '../components/ListManagerModal';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { SortableTh, SortableThLabel, toggleGridSort } from '../components/SortableTh';
import type { GridSortState } from '../components/SortableTh';
import { billMonthlyEquivalent } from '../lib/budgetMath';
import { classifyRecurringKind } from '../lib/classifyRecurring';
import { isLoanAccount } from './FinanceAccounts';
import type { AmountHistoryEntry, Bill, BillFrequency, FinanceAccount, FinanceCategory, RecurringKind } from '../types';

type ManagerTarget = 'account' | 'category' | null;

const FREQUENCIES: BillFrequency[] = ['Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Semiannual', 'Yearly', 'Once'];

function UsageDots({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="recur-usage-dots">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          className={`recur-usage-dot ${n <= value ? 'filled' : ''}`}
          onClick={() => onChange(n === value ? 0 : n)}
          aria-label={`Set usage rating to ${n}`}
        />
      ))}
    </div>
  );
}

export function FinanceRecurringGrid({ kind }: { kind: RecurringKind }) {
  const { data, upsert, remove } = useStore();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [manager, setManager] = useState<ManagerTarget>(null);
  const { financeAccounts: allAccounts, financeCategories: categories } = data;
  // A loan isn't a payment method — bills get autopaid from Checking/Savings/Cash/Credit Card, not a loan account.
  const accounts = allAccounts.filter(a => !isLoanAccount(a.type)).sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const items = data.bills.filter(b => (b.kind ?? 'Bill') === kind);

  const today = new Date().toISOString().slice(0, 10);
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadIso = weekAhead.toISOString().slice(0, 10);

  const monthlyTotal = items.reduce((s, b) => s + billMonthlyEquivalent(b), 0);
  const dueThisWeek = items.filter(b => b.nextDue >= today && b.nextDue <= weekAheadIso);
  const autopayCount = items.filter(b => b.autopay).length;

  const categoryOptions = categories.filter(c => c.kind === 'expense').sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const [suggestFor, setSuggestFor] = useState<string | null>(null);

  const accountName = (id?: string) => accounts.find(a => a.id === id)?.name ?? '';
  const categoryName = (id?: string) => categoryOptions.find(c => c.id === id)?.name ?? '';

  // Drag-to-reorder sets each item's own `order` field; a header sort temporarily displays
  // by the clicked column instead, and clicking that header a third time falls back to drag order.
  type BillSortKey = 'name' | 'amount' | 'nextDue' | 'frequency' | 'account' | 'category' | 'autopay' | 'usage' | 'trial';
  const [sort, setSort] = useState<GridSortState<BillSortKey>>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const orderedItems = items.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const sortedItems = sort
    ? orderedItems.slice().sort((a, b) => {
        let cmp = 0;
        switch (sort.key) {
          case 'name': cmp = a.name.localeCompare(b.name); break;
          case 'amount': cmp = a.amount - b.amount; break;
          case 'nextDue': cmp = a.nextDue.localeCompare(b.nextDue); break;
          case 'frequency': cmp = (a.frequency ?? 'Monthly').localeCompare(b.frequency ?? 'Monthly'); break;
          case 'account': cmp = accountName(a.accountId).localeCompare(accountName(b.accountId)); break;
          case 'category': cmp = categoryName(a.categoryId).localeCompare(categoryName(b.categoryId)); break;
          case 'autopay': cmp = Number(a.autopay) - Number(b.autopay); break;
          case 'usage': cmp = (a.usageRating ?? 0) - (b.usageRating ?? 0); break;
          case 'trial': cmp = Number(a.isFreeTrial) - Number(b.isFreeTrial); break;
        }
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : orderedItems;

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = orderedItems.map(i => i.id);
    const fromIndex = ids.indexOf(dragId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) { setDragId(null); return; }
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, dragId);
    next.forEach((id, index) => {
      const item = items.find(i => i.id === id);
      if (item && item.order !== index) void upsert('bills', { ...item, order: index });
    });
    setDragId(null);
  };

  const patch = (bill: Bill, p: Partial<Bill>) => {
    const next = { ...bill, ...p };
    if ('nextDue' in p || 'reminderDaysBefore' in p) {
      if (next.nextDue && next.reminderDaysBefore != null && !Number.isNaN(next.reminderDaysBefore)) {
        const d = new Date(`${next.nextDue}T09:00:00`);
        d.setDate(d.getDate() - next.reminderDaysBefore);
        next.reminderAt = d.toISOString();
      } else {
        next.reminderAt = undefined;
      }
    }
    if ('amount' in p && p.amount !== bill.amount) {
      const entry: AmountHistoryEntry = { date: today, amount: bill.amount };
      if ((bill.kind ?? 'Bill') === 'Subscription') {
        next.priceHistory = [...(bill.priceHistory ?? []), entry].slice(-12);
      } else {
        next.amountHistory = [...(bill.amountHistory ?? []), entry].slice(-12);
      }
    }
    void upsert('bills', next);
  };

  const addItem = () => {
    void upsert('bills', newRecord<Bill>({ name: '', amount: 0, nextDue: today, frequency: 'Monthly', kind, order: items.length }));
  };

  const checkClassification = (b: Bill) => {
    const suggestion = classifyRecurringKind(b.name, b.amount, b.frequency);
    setSuggestFor(suggestion.kind !== kind && b.name.trim() ? b.id : null);
  };

  const addAccount = (name: string) => {
    void upsert('financeAccounts', newRecord<FinanceAccount>({ name, type: 'Checking', balance: 0, status: 'Active' }));
  };

  const addCategory = (name: string) => {
    void upsert('financeCategories', newRecord<FinanceCategory>({ name, kind: 'expense', color: '#4f5bd5' }));
  };

  const reorderAccounts = (orderedIds: string[]) => {
    orderedIds.forEach((id, index) => {
      const account = accounts.find(a => a.id === id);
      if (account && account.order !== index) void upsert('financeAccounts', { ...account, order: index });
    });
  };

  const reorderCategories = (orderedIds: string[]) => {
    orderedIds.forEach((id, index) => {
      const category = categoryOptions.find(c => c.id === id);
      if (category && category.order !== index) void upsert('financeCategories', { ...category, order: index });
    });
  };

  const editing = sortedItems.find(b => b.id === editingId) ?? null;

  if (isMobile) {
    return (
      <>
        <div className="kpi-grid three">
          <Kpi label={kind === 'Bill' ? 'Monthly Bills' : 'Monthly Subscriptions'} value={formatCurrency(monthlyTotal)} caption={`${items.length} tracked`} tone="default" />
          <Kpi label="Due This Week" value={dueThisWeek.length} caption={dueThisWeek.map(b => b.name).join(', ') || 'nothing due soon'} tone={dueThisWeek.length ? 'amber' : 'green'} />
          <Kpi label="On Autopay" value={autopayCount} caption={`of ${items.length}`} tone="blue" />
        </div>

        <MobileRecordList
          items={sortedItems}
          primary={b => b.name || (kind === 'Bill' ? 'Untitled bill' : 'Untitled subscription')}
          secondary={b => `${formatDate(b.nextDue)} · ${b.frequency ?? 'Monthly'}`}
          trailing={b => formatCurrency(b.amount)}
          fields={[
            { label: 'Account', value: b => accountName(b.accountId) || '—' },
            kind === 'Bill'
              ? { label: 'Category', value: b => categoryName(b.categoryId) || '—' }
              : { label: 'Autopay', value: b => (b.autopay ? 'On' : 'Off') }
          ]}
          onOpen={b => setEditingId(b.id)}
          onDelete={b => void remove('bills', b.id)}
          deleteLabel={b => `Delete ${b.name || (kind === 'Bill' ? 'bill' : 'subscription')}`}
          empty={kind === 'Bill' ? 'No bills yet — add your first one below.' : 'No subscriptions yet — add one below.'}
        />
        <button type="button" className="btn teal grid-add-row" onClick={addItem}><Plus size={16} /> Add {kind === 'Bill' ? 'bill' : 'subscription'}</button>

        {editing && (
          <Sheet title={editing.name || (kind === 'Bill' ? 'Edit bill' : 'Edit subscription')} onClose={() => setEditingId(null)}>
            <div className="sheet-form">
              <label>
                <span>Name</span>
                <input type="text" value={editing.name} placeholder={kind === 'Bill' ? 'Bill name' : 'Subscription name'} onChange={e => patch(editing, { name: e.target.value })} />
              </label>
              <label>
                <span>Amount</span>
                <input type="number" inputMode="decimal" step="0.01" min={0} value={editing.amount} onChange={e => patch(editing, { amount: Number(e.target.value) })} />
              </label>
              <label><span>Next due</span><DatePicker value={editing.nextDue} onChange={v => patch(editing, { nextDue: v })} /></label>
              <label>
                <span>Frequency</span>
                <select value={editing.frequency ?? 'Monthly'} onChange={e => patch(editing, { frequency: e.target.value as BillFrequency })}>
                  {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
              <label>
                <span>Account</span>
                <select value={editing.accountId ?? ''} onChange={e => patch(editing, { accountId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              {kind === 'Bill' && (
                <label>
                  <span>Category</span>
                  <select value={editing.categoryId ?? ''} onChange={e => patch(editing, { categoryId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {categoryOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              )}
              <label className="sheet-checkbox-row">
                <input type="checkbox" checked={Boolean(editing.autopay)} onChange={e => patch(editing, { autopay: e.target.checked })} />
                <span>Autopay</span>
              </label>
              {kind === 'Subscription' && (
                <>
                  <label>
                    <span>Usage</span>
                    <UsageDots value={editing.usageRating ?? 0} onChange={n => patch(editing, { usageRating: n || undefined })} />
                  </label>
                  <label className="sheet-checkbox-row">
                    <input type="checkbox" checked={Boolean(editing.isFreeTrial)} onChange={e => patch(editing, { isFreeTrial: e.target.checked })} />
                    <span>Free trial</span>
                  </label>
                  {editing.isFreeTrial && (
                    <label><span>Trial ends</span><DatePicker value={editing.trialEndDate ?? ''} onChange={v => patch(editing, { trialEndDate: v })} placeholder="Ends…" /></label>
                  )}
                </>
              )}
              <label><span>Notes</span><textarea rows={3} value={editing.notes ?? ''} onChange={e => patch(editing, { notes: e.target.value })} /></label>
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <>
      <div className="kpi-grid three">
        <Kpi label={kind === 'Bill' ? 'Monthly Bills' : 'Monthly Subscriptions'} value={formatCurrency(monthlyTotal)} caption={`${items.length} tracked`} tone="default" />
        <Kpi label="Due This Week" value={dueThisWeek.length} caption={dueThisWeek.map(b => b.name).join(', ') || 'nothing due soon'} tone={dueThisWeek.length ? 'amber' : 'green'} />
        <Kpi label="On Autopay" value={autopayCount} caption={`of ${items.length}`} tone="blue" />
      </div>

      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th className="grid-drag-col" />
              <SortableTh label="Name" sortKey="name" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <SortableTh label="Amount" sortKey="amount" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              <SortableTh label="Next Due" sortKey="nextDue" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <SortableTh label="Frequency" sortKey="frequency" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <th>
                <SortableThLabel label="Account" sortKey="account" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManager('account')} aria-label="Manage accounts" title="Add or remove accounts">
                  <Pencil size={11} />
                </button>
              </th>
              {kind === 'Bill' && (
                <th>
                  <SortableThLabel label="Category" sortKey="category" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
                  <button type="button" className="col-edit-btn" onClick={() => setManager('category')} aria-label="Manage categories" title="Add or remove categories">
                    <Pencil size={11} />
                  </button>
                </th>
              )}
              <SortableTh label="Autopay" sortKey="autopay" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              {kind === 'Subscription' && (
                <>
                  <SortableTh label="Usage" sortKey="usage" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
                  <SortableTh label="Trial" sortKey="trial" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
                </>
              )}
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedItems.map(b => (
              <tr
                key={b.id}
                className={dragId === b.id ? 'dragging' : ''}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(b.id)}
              >
                <td className="grid-drag-col">
                  <span
                    className="drag-handle"
                    draggable={!sort}
                    aria-disabled={Boolean(sort)}
                    title={sort ? 'Clear the sort to drag-reorder' : 'Drag to reorder'}
                    aria-label={`Drag to reorder ${b.name || 'item'}`}
                    onDragStart={e => { if (sort) { e.preventDefault(); return; } setDragId(b.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <GripVertical size={13} />
                  </span>
                </td>
                <td>
                  <input
                    type="text"
                    className="grid-cell-input input-wide"
                    value={b.name}
                    placeholder={kind === 'Bill' ? 'Bill name' : 'Subscription name'}
                    onChange={e => patch(b, { name: e.target.value })}
                    onBlur={() => checkClassification(b)}
                  />
                  {suggestFor === b.id && (
                    <button
                      type="button"
                      className="recur-suggest-pill"
                      onClick={() => { patch(b, { kind: kind === 'Bill' ? 'Subscription' : 'Bill' }); setSuggestFor(null); }}
                    >
                      Move to {kind === 'Bill' ? 'Subscriptions' : 'Bills'} →
                    </button>
                  )}
                </td>
                <td className="grid-td-compact"><NumberCell value={b.amount} onChange={n => patch(b, { amount: n })} min={0} decimals={2} /></td>
                <td><DatePicker value={b.nextDue} onChange={v => patch(b, { nextDue: v })} /></td>
                <td>
                  <select className="grid-cell-select" value={b.frequency ?? 'Monthly'} onChange={e => patch(b, { frequency: e.target.value as BillFrequency })}>
                    {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </td>
                <td>
                  <select className="grid-cell-select select-wide" value={b.accountId ?? ''} onChange={e => patch(b, { accountId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </td>
                {kind === 'Bill' && (
                  <td>
                    <select className="grid-cell-select select-wide" value={b.categoryId ?? ''} onChange={e => patch(b, { categoryId: e.target.value || undefined })}>
                      <option value="">—</option>
                      {categoryOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                )}
                <td className="grid-td-center">
                  <input type="checkbox" checked={Boolean(b.autopay)} onChange={e => patch(b, { autopay: e.target.checked })} />
                </td>
                {kind === 'Subscription' && (
                  <>
                    <td><UsageDots value={b.usageRating ?? 0} onChange={n => patch(b, { usageRating: n || undefined })} /></td>
                    <td>
                      <div className="recur-trial-cell">
                        <label className="recur-toggle-inline" title="Free trial">
                          <input type="checkbox" checked={Boolean(b.isFreeTrial)} onChange={e => patch(b, { isFreeTrial: e.target.checked })} />
                          {!b.isFreeTrial && 'Trial'}
                        </label>
                        {b.isFreeTrial && <DatePicker value={b.trialEndDate ?? ''} onChange={v => patch(b, { trialEndDate: v })} placeholder="Ends…" />}
                      </div>
                    </td>
                  </>
                )}
                <td><NotesCell value={b.notes ?? ''} onChange={v => patch(b, { notes: v })} /></td>
                <td><button type="button" className="icon-btn danger" onClick={() => void remove('bills', b.id)} aria-label={`Delete ${b.name || 'item'}`}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sortedItems.length && (
          <p className="muted grid-table-empty">
            {kind === 'Bill' ? 'No bills yet — add your first one below.' : 'No subscriptions yet — add one below, or check the suggestions further down.'}
          </p>
        )}
      </div>
      <button type="button" className="btn teal grid-add-row" onClick={addItem}><Plus size={16} /> Add {kind === 'Bill' ? 'bill' : 'subscription'}</button>

      {manager === 'account' && (
        <ListManagerModal
          title="Manage Accounts"
          subtitle="Add a new account, or remove one you no longer use."
          items={accounts.map(a => ({ id: a.id, label: a.name, meta: a.type }))}
          onAdd={addAccount}
          onDelete={id => void remove('financeAccounts', id)}
          onReorder={reorderAccounts}
          onClose={() => setManager(null)}
          addPlaceholder="e.g. Chase Checking"
        />
      )}

      {manager === 'category' && (
        <ListManagerModal
          title="Manage Expense Categories"
          subtitle="Add a new category, or remove one you no longer use."
          items={categoryOptions.map(c => ({ id: c.id, label: c.name }))}
          onAdd={addCategory}
          onDelete={id => void remove('financeCategories', id)}
          onReorder={reorderCategories}
          onClose={() => setManager(null)}
          addPlaceholder="e.g. Pet Care"
        />
      )}
    </>
  );
}

export function FinanceBills() {
  return <FinanceRecurringGrid kind="Bill" />;
}
