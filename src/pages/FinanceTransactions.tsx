import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { DatePicker } from '../components/DatePicker';
import { NumberCell, NotesCell } from '../components/GridCells';
import { ListManagerModal } from '../components/ListManagerModal';
import { SortableTh, SortableThLabel, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';
import { formatCurrency, formatDate } from '../components/UI';
import { suggestCategory } from '../lib/autoCategorize';
import { reconcileTransferBalances } from '../lib/transferBalance';
import { isLiabilityAccount } from './FinanceAccounts';
import { CORE_TRANSACTION_TYPES } from '../types';
import type { FinanceAccount, FinanceCategory, Transaction, TransactionType } from '../types';

type ManagerTarget = 'account' | 'category' | 'type' | null;
type TxSortKey = 'date' | 'merchant' | 'amount' | 'type' | 'account' | 'category';

export function FinanceTransactions({ typeFilter }: { typeFilter?: TransactionType } = {}) {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? 9999) - (b.order ?? 9999);
  const accounts = data.financeAccounts.slice().sort(byOrder);
  const categories = data.financeCategories.slice().sort(byOrder);
  const customTypes = data.settings.customTransactionTypes ?? [];
  const allTypes: TransactionType[] = [...CORE_TRANSACTION_TYPES, ...customTypes];
  const isIncomeView = typeFilter === 'Income';
  // The plain Transactions tab now excludes Income entirely — that's what the Income tab is for.
  const transactions = typeFilter
    ? data.transactions.filter(t => t.type === typeFilter)
    : data.transactions.filter(t => t.type !== 'Income');

  const accountName = (id?: string) => accounts.find(a => a.id === id)?.name ?? '';
  const categoryName = (id?: string) => categories.find(c => c.id === id)?.name ?? '';
  const [sort, setSort] = useState<SortState<TxSortKey>>({ key: 'date', dir: 'desc' });
  const sortedTransactions = transactions.slice().sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'date': cmp = a.date.localeCompare(b.date); break;
      case 'merchant': cmp = a.merchant.localeCompare(b.merchant); break;
      case 'amount': cmp = a.amount - b.amount; break;
      case 'type': cmp = a.type.localeCompare(b.type); break;
      case 'account': cmp = accountName(a.accountId).localeCompare(accountName(b.accountId)); break;
      case 'category': cmp = categoryName(a.categoryId).localeCompare(categoryName(b.categoryId)); break;
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  // Income can't land in a liability account (a loan or credit card isn't a deposit destination).
  const accountOptions = isIncomeView ? accounts.filter(a => !isLiabilityAccount(a.type)) : accounts;
  const incomeCategories = categories.filter(c => c.kind === 'income');
  const expenseCategories = categories.filter(c => c.kind === 'expense');
  const relevantCategories = isIncomeView ? incomeCategories : expenseCategories;
  const today = new Date().toISOString().slice(0, 10);
  const noun = isIncomeView ? 'income' : 'transaction';
  // The Income tab is locked to Income — reclassifying away would just make the row vanish from
  // this view, so it isn't offered here. Use the Transactions tab for Expense/Transfer entries.
  const typeOptions = allTypes.filter(ty => ty !== 'Income');
  const [manager, setManager] = useState<ManagerTarget>(null);

  const patch = (t: Transaction, p: Partial<Transaction>) => {
    const next = { ...t, ...p };
    if ('merchant' in p && !t.categoryId) {
      const suggestion = suggestCategory(String(p.merchant));
      if (suggestion) {
        const match = categories.find(c => c.name.toLowerCase() === suggestion.toLowerCase());
        if (match) next.categoryId = match.id;
      }
    }
    for (const account of reconcileTransferBalances(t, next, accounts)) void upsert('financeAccounts', account);
    void upsert('transactions', next);
  };

  const deleteTransaction = (t: Transaction) => {
    for (const account of reconcileTransferBalances(t, null, accounts)) void upsert('financeAccounts', account);
    void remove('transactions', t.id);
  };

  const addTransaction = () => {
    const record = newRecord<Transaction>({ date: today, merchant: '', amount: 0, type: typeFilter ?? 'Expense' });
    void upsert('transactions', record);
    // Desktop edits inline in the grid, so there's nothing to open there — this only matters
    // on mobile, where "add" would otherwise create a blank row and strand it in the list with
    // no indication which one is new.
    if (isMobile) setEditingId(record.id);
  };
  // Only meaningful while this is actually the transactions (not "Income") sub-view — the FAB
  // falls back to Capture when it isn't, since neither ledger sub-tab nor Finance's own tab is
  // reachable from here to redirect into.
  useFabAction('Finance', typeFilter === 'Income' ? 'Add income' : 'Add transaction', addTransaction);

  const addAccount = (name: string) => {
    void upsert('financeAccounts', newRecord<FinanceAccount>({ name, type: 'Checking', balance: 0, status: 'Active' }));
  };

  const addCategory = (name: string) => {
    void upsert('financeCategories', newRecord<FinanceCategory>({ name, kind: isIncomeView ? 'income' : 'expense', color: '#4f5bd5' }));
  };

  const addType = (name: string) => {
    if (allTypes.some(ty => ty.toLowerCase() === name.toLowerCase())) return;
    void updateSettings({ customTransactionTypes: [...customTypes, name] });
  };

  const deleteType = (name: string) => {
    void updateSettings({ customTransactionTypes: customTypes.filter(ty => ty !== name) });
  };

  const reorderAccounts = (orderedIds: string[]) => {
    orderedIds.forEach((id, index) => {
      const account = accounts.find(a => a.id === id);
      if (account && account.order !== index) void upsert('financeAccounts', { ...account, order: index });
    });
  };

  const reorderCategories = (orderedIds: string[]) => {
    orderedIds.forEach((id, index) => {
      const category = categories.find(c => c.id === id);
      if (category && category.order !== index) void upsert('financeCategories', { ...category, order: index });
    });
  };

  const reorderTypes = (orderedIds: string[]) => {
    const nextCustom = orderedIds.filter(id => !(CORE_TRANSACTION_TYPES as readonly string[]).includes(id));
    void updateSettings({ customTransactionTypes: nextCustom });
  };

  const editing = sortedTransactions.find(t => t.id === editingId) ?? null;

  if (isMobile) {
    return (
      <>
        <MobileRecordList
          items={sortedTransactions}
          primary={t => t.merchant || `(no ${noun === 'income' ? 'source' : 'merchant'})`}
          secondary={t => formatDate(t.date)}
          trailing={t => formatCurrency(t.amount)}
          trailingTone={() => (isIncomeView ? 'positive' : 'negative')}
          fields={[
            { label: 'Category', value: t => categoryName(t.categoryId) || '—' },
            { label: 'Account', value: t => accountName(t.accountId) || '—' }
          ]}
          onOpen={t => setEditingId(t.id)}
          onDelete={deleteTransaction}
          deleteLabel={t => `Delete ${t.merchant || noun}`}
          empty={`No ${noun === 'income' ? 'income logged' : 'transactions'} yet — add your first one below.`}
        />
        <button type="button" className="btn teal grid-add-row" onClick={addTransaction}>
          <Plus size={16} /> Add {noun}
        </button>

        {editing && (
          <Sheet title={editing.merchant || `Edit ${noun}`} onClose={() => setEditingId(null)}>
            <div className="sheet-form">
              <label><span>Date</span><DatePicker value={editing.date} onChange={v => patch(editing, { date: v })} /></label>
              <label>
                <span>Merchant / Payee</span>
                <input type="text" value={editing.merchant} placeholder="e.g. Walmart, Paycheck…" onChange={e => patch(editing, { merchant: e.target.value })} />
              </label>
              <label>
                <span>Amount</span>
                {/* inputmode opens the numeric keypad instead of the full QWERTY layout. */}
                <input
                  type="number" inputMode="decimal" step="0.01" min={0}
                  value={editing.amount}
                  onChange={e => patch(editing, { amount: Number(e.target.value) })}
                />
              </label>
              {!isIncomeView && (
                <label>
                  <span>Type</span>
                  <select value={editing.type} onChange={e => patch(editing, { type: e.target.value as TransactionType })}>
                    {typeOptions.map(ty => <option key={ty} value={ty}>{ty}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span>Account</span>
                <select value={editing.accountId ?? ''} onChange={e => patch(editing, { accountId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {accountOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              {!isIncomeView && editing.type === 'Transfer' && (
                <label>
                  <span>Transfer to</span>
                  <select value={editing.transferAccountId ?? ''} onChange={e => patch(editing, { transferAccountId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {accounts.filter(a => a.id !== editing.accountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              )}
              <label>
                <span>Category</span>
                <select value={editing.categoryId ?? ''} onChange={e => patch(editing, { categoryId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {relevantCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label>
                <span>Notes</span>
                <textarea rows={3} value={editing.notes ?? ''} onChange={e => patch(editing, { notes: e.target.value })} />
              </label>
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <>
      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <SortableTh label="Date" sortKey="date" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
              <SortableTh label="Merchant / Payee" sortKey="merchant" state={sort} onSort={k => setSort(s => toggleSort(s, k))} />
              <SortableTh label="Amount" sortKey="amount" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
              <th>
                {isIncomeView ? 'Type' : (
                  <SortableThLabel label="Type" sortKey="type" state={sort} onSort={k => setSort(s => toggleSort(s, k))} />
                )}
                {!isIncomeView && (
                  <button type="button" className="col-edit-btn" onClick={() => setManager('type')} aria-label="Manage types" title="Add or remove transaction types">
                    <Pencil size={11} />
                  </button>
                )}
              </th>
              <th>
                <SortableThLabel label="Account" sortKey="account" state={sort} onSort={k => setSort(s => toggleSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManager('account')} aria-label="Manage accounts" title="Add or remove accounts">
                  <Pencil size={11} />
                </button>
              </th>
              {!isIncomeView && <th title="Destination account for Transfer-type transactions">To Account</th>}
              <th>
                <SortableThLabel label="Category" sortKey="category" state={sort} onSort={k => setSort(s => toggleSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManager('category')} aria-label="Manage categories" title="Add or remove categories">
                  <Pencil size={11} />
                </button>
              </th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedTransactions.map(t => (
              <tr key={t.id}>
                <td><DatePicker value={t.date} onChange={v => patch(t, { date: v })} /></td>
                <td><input type="text" className="grid-cell-input" value={t.merchant} placeholder="e.g. Walmart, Paycheck…" onChange={e => patch(t, { merchant: e.target.value })} /></td>
                <td className="grid-td-compact"><NumberCell value={t.amount} onChange={n => patch(t, { amount: n })} min={0} decimals={2} /></td>
                <td>
                  {isIncomeView ? (
                    <span className="grid-static-cell">Income</span>
                  ) : (
                    <select className="grid-cell-select" value={t.type} onChange={e => patch(t, { type: e.target.value as TransactionType })}>
                      {typeOptions.map(ty => <option key={ty} value={ty}>{ty}</option>)}
                    </select>
                  )}
                </td>
                <td>
                  <select className="grid-cell-select" value={t.accountId ?? ''} onChange={e => patch(t, { accountId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {accountOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </td>
                {!isIncomeView && (
                  <td>
                    {t.type === 'Transfer' ? (
                      <select
                        className="grid-cell-select"
                        value={t.transferAccountId ?? ''}
                        onChange={e => patch(t, { transferAccountId: e.target.value || undefined })}
                      >
                        <option value="">—</option>
                        {accounts.filter(a => a.id !== t.accountId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    ) : <span className="grid-static-cell">—</span>}
                  </td>
                )}
                <td>
                  <select className="grid-cell-select" value={t.categoryId ?? ''} onChange={e => patch(t, { categoryId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {relevantCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
                <td><NotesCell value={t.notes ?? ''} onChange={v => patch(t, { notes: v })} /></td>
                <td><button type="button" className="icon-btn danger" onClick={() => deleteTransaction(t)} aria-label={`Delete ${t.merchant || noun}`}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sortedTransactions.length && <p className="muted grid-table-empty">No {noun === 'income' ? 'income logged' : 'transactions'} yet — add your first one below.</p>}
      </div>
      <button type="button" className="btn teal grid-add-row" onClick={addTransaction}><Plus size={16} /> Add {noun}</button>

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
          title={`Manage ${isIncomeView ? 'Income' : 'Expense'} Categories`}
          subtitle="Add a new category, or remove one you no longer use."
          items={relevantCategories.map(c => ({ id: c.id, label: c.name }))}
          onAdd={addCategory}
          onDelete={id => void remove('financeCategories', id)}
          onReorder={reorderCategories}
          onClose={() => setManager(null)}
          addPlaceholder="e.g. Pet Care"
        />
      )}

      {manager === 'type' && (
        <ListManagerModal
          title="Manage Transaction Types"
          subtitle="Income, Expense, and Transfer are built into how budgets and cash flow are calculated, so they can't be removed. Add your own on top of those."
          items={allTypes.map(ty => ({ id: ty, label: ty, locked: (CORE_TRANSACTION_TYPES as readonly string[]).includes(ty) }))}
          onAdd={addType}
          onDelete={deleteType}
          onReorder={reorderTypes}
          onClose={() => setManager(null)}
          addPlaceholder="e.g. Reimbursement"
        />
      )}
    </>
  );
}
