import { useState } from 'react';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { useStore, newRecord } from '../store';
import { Kpi, formatCurrency } from '../components/UI';
import { NumberCell, NotesCell } from '../components/GridCells';
import { ListManagerModal } from '../components/ListManagerModal';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { SortableTh, SortableThLabel, toggleGridSort } from '../components/SortableTh';
import type { GridSortState } from '../components/SortableTh';
import { CORE_ACCOUNT_TYPES, CORE_DEBT_TYPES } from '../types';
import type { FinanceAccount, FinanceAccountType, InvestmentAssetClass } from '../types';

const LOAN_TYPES: FinanceAccountType[] = ['Personal Loan', 'Student Loan', 'Auto Loan', 'Mortgage'];

// Custom debt types (e.g. "Medical Debt") are settings-backed and registered here so
// isLiabilityAccount/isLoanAccount stay accurate everywhere without threading settings
// through every one of their call sites across the Finance pages.
let customLiabilityTypes = new Set<string>();
export function registerCustomDebtTypes(types: string[]): void {
  customLiabilityTypes = new Set(types);
}

export function isLiabilityAccount(type: FinanceAccountType): boolean {
  return (CORE_DEBT_TYPES as readonly string[]).includes(type) || customLiabilityTypes.has(type);
}

// Loans aren't a payment method — you don't pay a bill or receive income "from" a loan account,
// unlike a Credit Card, which is a liability but still spendable. Custom debt types are treated
// like loans (not payment methods) since they're user-defined and not a fixed "Credit Card".
export function isLoanAccount(type: FinanceAccountType): boolean {
  return LOAN_TYPES.includes(type) || customLiabilityTypes.has(type);
}

const ACCOUNT_TYPES: FinanceAccountType[] = [...CORE_ACCOUNT_TYPES];

export const ASSET_CLASSES: InvestmentAssetClass[] = [
  'Stocks', 'ETFs', 'Bonds', 'Cash', 'Real Estate', 'Cryptocurrency', 'Other'
];

const STATUSES: FinanceAccount['status'][] = ['Active', 'Frozen', 'Closed'];

export function FinanceDebtGrid() {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const customDebtTypes = data.settings.customDebtTypes ?? [];
  const allDebtTypes: FinanceAccountType[] = [...CORE_DEBT_TYPES, ...customDebtTypes];
  const [manageTypes, setManageTypes] = useState(false);
  const debts = data.financeAccounts.filter(a => isLiabilityAccount(a.type));

  // Drag-to-reorder sets each debt's own `order` field; a header sort temporarily displays
  // by the clicked column instead, and clicking that header a third time falls back to drag order.
  type DebtSortKey = 'name' | 'balance' | 'type' | 'institution' | 'interestRate' | 'minPayment' | 'status';
  const [sort, setSort] = useState<GridSortState<DebtSortKey>>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const orderedDebts = debts.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999));
  const sortedDebts = sort
    ? orderedDebts.slice().sort((a, b) => {
        let cmp = 0;
        switch (sort.key) {
          case 'name': cmp = a.name.localeCompare(b.name); break;
          case 'balance': cmp = a.balance - b.balance; break;
          case 'type': cmp = a.type.localeCompare(b.type); break;
          case 'institution': cmp = (a.institution ?? '').localeCompare(b.institution ?? ''); break;
          case 'interestRate': cmp = (a.interestRate ?? 0) - (b.interestRate ?? 0); break;
          case 'minPayment': cmp = (a.minimumPayment ?? 0) - (b.minimumPayment ?? 0); break;
          case 'status': cmp = a.status.localeCompare(b.status); break;
        }
        return sort.dir === 'asc' ? cmp : -cmp;
      })
    : orderedDebts;

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = orderedDebts.map(d => d.id);
    const fromIndex = ids.indexOf(dragId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) { setDragId(null); return; }
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, dragId);
    next.forEach((id, index) => {
      const account = debts.find(d => d.id === id);
      if (account && account.order !== index) void upsert('financeAccounts', { ...account, order: index });
    });
    setDragId(null);
  };

  const totalBalance = debts.filter(a => a.status !== 'Closed').reduce((s, a) => s + a.balance, 0);
  const totalMinPayment = debts.filter(a => a.status !== 'Closed').reduce((s, a) => s + (a.minimumPayment ?? 0), 0);
  const weightedApr = totalBalance > 0
    ? debts.filter(a => a.status !== 'Closed').reduce((s, a) => s + (a.interestRate ?? 0) * a.balance, 0) / totalBalance
    : 0;

  const patch = (account: FinanceAccount, p: Partial<FinanceAccount>) => {
    const next = { ...account, ...p, lastSyncedAt: new Date().toISOString() };
    // A paid-off debt doesn't accrue interest or owe a minimum payment anymore.
    if ('balance' in p && next.balance <= 0) {
      next.interestRate = 0;
      next.minimumPayment = 0;
    }
    void upsert('financeAccounts', next);
  };

  const addDebt = () => {
    void upsert('financeAccounts', newRecord<FinanceAccount>({ name: '', type: 'Credit Card', balance: 0, status: 'Active', order: debts.length }));
  };

  const addDebtType = (name: string) => {
    if (allDebtTypes.some(t => t.toLowerCase() === name.toLowerCase())) return;
    void updateSettings({ customDebtTypes: [...customDebtTypes, name] });
  };

  const deleteDebtType = (name: string) => {
    void updateSettings({ customDebtTypes: customDebtTypes.filter(t => t !== name) });
  };

  const reorderDebtTypes = (orderedIds: string[]) => {
    const nextCustom = orderedIds.filter(id => !(CORE_DEBT_TYPES as readonly string[]).includes(id));
    void updateSettings({ customDebtTypes: nextCustom });
  };

  const editingDebt = sortedDebts.find(d => d.id === editingId) ?? null;

  if (isMobile) {
    return (
      <>
        <div className="kpi-grid three">
          <Kpi label="Total Debt" value={formatCurrency(totalBalance)} caption={`${debts.filter(a => a.status !== 'Closed').length} accounts`} tone="red" />
          <Kpi label="Min. Payments Total" value={formatCurrency(totalMinPayment)} caption="required monthly" tone="default" />
          <Kpi label="Weighted Avg APR" value={`${weightedApr.toFixed(1)}%`} caption="balance-weighted" tone="amber" />
        </div>

        <MobileRecordList
          items={sortedDebts}
          primary={a => a.name || 'Untitled debt'}
          secondary={a => `${a.type}${a.institution ? ` · ${a.institution}` : ''}`}
          trailing={a => formatCurrency(a.balance)}
          trailingTone={() => 'negative'}
          fields={[
            { label: 'APR', value: a => (a.interestRate ? `${a.interestRate}%` : '—') },
            { label: 'Min. payment', value: a => (a.minimumPayment ? formatCurrency(a.minimumPayment) : '—') }
          ]}
          onOpen={a => setEditingId(a.id)}
          onDelete={a => void remove('financeAccounts', a.id)}
          deleteLabel={a => `Delete ${a.name || 'debt'}`}
          empty="No debt accounts yet — add a credit card, loan, or mortgage below."
        />
        <button type="button" className="btn teal grid-add-row" onClick={addDebt}><Plus size={16} /> Add debt</button>

        {editingDebt && (
          <Sheet title={editingDebt.name || 'Edit debt'} onClose={() => setEditingId(null)}>
            <div className="sheet-form">
              <label><span>Name</span><input type="text" value={editingDebt.name} placeholder="Debt name" onChange={e => patch(editingDebt, { name: e.target.value })} /></label>
              <label>
                <span>Type</span>
                <select value={editingDebt.type} onChange={e => patch(editingDebt, { type: e.target.value as FinanceAccountType })}>
                  {allDebtTypes.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label><span>Institution</span><input type="text" value={editingDebt.institution ?? ''} placeholder="—" onChange={e => patch(editingDebt, { institution: e.target.value })} /></label>
              <label><span>Balance</span><input type="number" inputMode="decimal" step="0.01" min={0} value={editingDebt.balance} onChange={e => patch(editingDebt, { balance: Number(e.target.value) })} /></label>
              <label><span>Interest rate (%)</span><input type="number" inputMode="decimal" value={editingDebt.interestRate ?? 0} onChange={e => patch(editingDebt, { interestRate: Number(e.target.value) })} /></label>
              <label><span>Min. payment</span><input type="number" inputMode="decimal" step="0.01" min={0} value={editingDebt.minimumPayment ?? 0} onChange={e => patch(editingDebt, { minimumPayment: Number(e.target.value) })} /></label>
              <label>
                <span>Status</span>
                <select value={editingDebt.status} onChange={e => patch(editingDebt, { status: e.target.value as FinanceAccount['status'] })}>
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label><span>Notes</span><textarea rows={3} value={editingDebt.notes ?? ''} onChange={e => patch(editingDebt, { notes: e.target.value })} /></label>
            </div>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <>
      <div className="kpi-grid three">
        <Kpi label="Total Debt" value={formatCurrency(totalBalance)} caption={`${debts.filter(a => a.status !== 'Closed').length} accounts`} tone="red" />
        <Kpi label="Min. Payments Total" value={formatCurrency(totalMinPayment)} caption="required monthly" tone="default" />
        <Kpi label="Weighted Avg APR" value={`${weightedApr.toFixed(1)}%`} caption="balance-weighted" tone="amber" />
      </div>

      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th className="grid-drag-col" />
              <SortableTh label="Name" sortKey="name" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <th>
                <SortableThLabel label="Type" sortKey="type" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManageTypes(true)} aria-label="Manage debt types" title="Add or remove debt types">
                  <Pencil size={11} />
                </button>
              </th>
              <SortableTh label="Institution" sortKey="institution" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <SortableTh label="Balance" sortKey="balance" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              <SortableTh label="Interest Rate" sortKey="interestRate" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              <SortableTh label="Min. Payment" sortKey="minPayment" state={sort} onSort={k => setSort(s => toggleGridSort(s, k, 'desc'))} />
              <SortableTh label="Status" sortKey="status" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedDebts.map(a => (
              <tr
                key={a.id}
                className={dragId === a.id ? 'dragging' : ''}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(a.id)}
              >
                <td className="grid-drag-col">
                  <span
                    className="drag-handle"
                    draggable={!sort}
                    aria-disabled={Boolean(sort)}
                    title={sort ? 'Clear the sort to drag-reorder' : 'Drag to reorder'}
                    aria-label={`Drag to reorder ${a.name || 'debt'}`}
                    onDragStart={e => { if (sort) { e.preventDefault(); return; } setDragId(a.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <GripVertical size={13} />
                  </span>
                </td>
                <td><input type="text" className="grid-cell-input" value={a.name} placeholder="Debt name" onChange={e => patch(a, { name: e.target.value })} /></td>
                <td>
                  <select className="grid-cell-select" value={a.type} onChange={e => patch(a, { type: e.target.value as FinanceAccountType })}>
                    {allDebtTypes.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td><input type="text" className="grid-cell-input" value={a.institution ?? ''} placeholder="—" onChange={e => patch(a, { institution: e.target.value })} /></td>
                <td className="grid-td-compact"><NumberCell value={a.balance} onChange={n => patch(a, { balance: n })} min={0} decimals={2} /></td>
                <td className="grid-td-compact"><NumberCell value={a.interestRate ?? 0} onChange={n => patch(a, { interestRate: n })} /></td>
                <td className="grid-td-compact"><NumberCell value={a.minimumPayment ?? 0} onChange={n => patch(a, { minimumPayment: n })} min={0} decimals={2} /></td>
                <td>
                  <select className="grid-cell-select" value={a.status} onChange={e => patch(a, { status: e.target.value as FinanceAccount['status'] })}>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
                <td><NotesCell value={a.notes ?? ''} onChange={v => patch(a, { notes: v })} /></td>
                <td><button type="button" className="icon-btn danger" onClick={() => void remove('financeAccounts', a.id)} aria-label={`Delete ${a.name || 'debt'}`}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sortedDebts.length && <p className="muted grid-table-empty">No debt accounts yet — add a credit card, loan, or mortgage below.</p>}
      </div>
      <button type="button" className="btn teal grid-add-row" onClick={addDebt}><Plus size={16} /> Add debt</button>

      {manageTypes && (
        <ListManagerModal
          title="Manage Debt Types"
          subtitle="Credit Card, Personal Loan, Student Loan, Auto Loan, and Mortgage feed into net worth and cash flow calculations, so they can't be removed. Add your own on top of those."
          items={allDebtTypes.map(t => ({ id: t, label: t, locked: (CORE_DEBT_TYPES as readonly string[]).includes(t) }))}
          onAdd={addDebtType}
          onDelete={deleteDebtType}
          onReorder={reorderDebtTypes}
          onClose={() => setManageTypes(false)}
          addPlaceholder="e.g. Medical Debt"
        />
      )}
    </>
  );
}

export function FinanceAccounts() {
  const { data } = useStore();
  const accounts = data.financeAccounts;
  const activeAccounts = accounts.filter(a => a.status !== 'Closed');
  const typeOptions = [...ACCOUNT_TYPES, ...(data.settings.customDebtTypes ?? [])];
  const totalAssets = activeAccounts.filter(a => !isLiabilityAccount(a.type)).reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = activeAccounts.filter(a => isLiabilityAccount(a.type)).reduce((s, a) => s + a.balance, 0);

  return (
    <>
      <div className="kpi-grid three">
        <Kpi label="Total Assets" value={formatCurrency(totalAssets)} caption={`${activeAccounts.filter(a => !isLiabilityAccount(a.type)).length} accounts`} tone="green" />
        <Kpi label="Total Liabilities" value={formatCurrency(totalLiabilities)} caption={`${activeAccounts.filter(a => isLiabilityAccount(a.type)).length} accounts`} tone="red" />
        <Kpi label="Net" value={formatCurrency(totalAssets - totalLiabilities)} caption="assets minus liabilities" tone="blue" />
      </div>
      <CollectionPage<FinanceAccount>
        collection="financeAccounts"
        itemLabel="Account"
        title="Accounts"
        subtitle="Bank, credit, loan, and investment accounts"
        fields={[
          { key: 'name', label: 'Account Name', type: 'text' },
          { key: 'type', label: 'Type', type: 'select', options: typeOptions },
          { key: 'institution', label: 'Institution', type: 'text' },
          { key: 'balance', label: 'Current Balance', type: 'number' },
          { key: 'availableBalance', label: 'Available Balance', type: 'number' },
          { key: 'interestRate', label: 'Interest Rate / APY (%)', type: 'number' },
          { key: 'minimumPayment', label: 'Minimum Payment (debt accounts)', type: 'number' },
          { key: 'costBasis', label: 'Cost Basis (investment accounts)', type: 'number' },
          { key: 'assetClass', label: 'Asset Class (investment accounts)', type: 'select', options: ASSET_CLASSES },
          { key: 'status', label: 'Status', type: 'select', options: ['Active', 'Closed', 'Frozen'] },
          { key: 'notes', label: 'Notes', type: 'textarea' }
        ]}
        defaults={{ name: '', type: 'Checking', balance: 0, status: 'Active' }}
        renderTitle={a => a.name}
        renderSubtitle={a => `${a.type}${a.institution ? ` · ${a.institution}` : ''} · ${formatCurrency(a.balance)}${a.status !== 'Active' ? ` · ${a.status}` : ''}`}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        onFieldChange={(key) => {
          if (key === 'balance' || key === 'availableBalance' || key === 'type' || key === 'status') {
            return { lastSyncedAt: new Date().toISOString() };
          }
        }}
      />
    </>
  );
}
