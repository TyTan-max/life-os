import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bell, GripVertical, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Kpi, formatCurrency, formatDate, MoneyInput } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { NumberCell, NotesCell } from '../components/GridCells';
import { ListManagerModal } from '../components/ListManagerModal';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { SortableTh, SortableThLabel, toggleGridSort } from '../components/SortableTh';
import type { GridSortState } from '../components/SortableTh';
import { billMonthlyEquivalent } from '../lib/budgetMath';
import { isBillPaused, notStartedYet } from '../lib/cashFlowForecast';
import { chargesToRecategorize, missedPaymentDates } from '../lib/billPayments';
import { classifyRecurringKind } from '../lib/classifyRecurring';
import { isLoanAccount } from './FinanceAccounts';
import type { AmountHistoryEntry, Bill, BillFrequency, FinanceAccount, FinanceCategory, RecurringKind } from '../types';

type ManagerTarget = 'account' | 'category' | null;

// `.toISOString()` converts to UTC — late enough in the day, that's already "tomorrow" for
// anyone west of UTC, which is exactly what made the due-soon badge/KPIs read a day ahead of the
// user's actual local date.
function localIso(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const FREQUENCIES: BillFrequency[] = ['Weekly', 'Biweekly', 'Monthly', 'Quarterly', 'Semiannual', 'Yearly', 'Once'];

// Automatic due-soon badge: appears once a bill/subscription is within a week of its due date,
// counting down "1 week" → "6 days" → … → "1 day" → "Due today" → "N days overdue". Color tiers
// by urgency: green 7-5 days out, yellow 4-2 days out, red for 1 day out through overdue. Purely
// a display — no per-item configuration, it just reacts to how close `nextDue` is to today.
function dueSoonInfo(nextDue: string, today: string): { label: string; severity: 'ok' | 'warn' | 'urgent' } | null {
  const days = Math.round((new Date(`${nextDue}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000);
  if (days > 7) return null;
  const severity = days <= 1 ? 'urgent' : days <= 4 ? 'warn' : 'ok';
  let label: string;
  if (days === 7) label = '1 week';
  else if (days >= 2) label = `${days} days`;
  else if (days === 1) label = '1 day';
  else if (days === 0) label = 'Due today';
  else label = `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue`;
  return { label, severity };
}

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

function addMonthsIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Pause options in one small menu, anchored to the ⏸ button or the "Paused" pill.
function PauseMenu({ anchor, paused, pausedUntil, onPause, onResume, onClose }: {
  anchor: DOMRect; paused: boolean; pausedUntil?: string;
  onPause: (until?: string) => void; onResume: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 6, left: anchor.left });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      top: anchor.bottom + height + 8 > window.innerHeight ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6,
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8))
    });
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest?.('.date-picker-popover')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const choose = (until?: string) => { onPause(until); onClose(); };
  return createPortal(
    <div ref={ref} className="pause-menu" role="menu" style={{ top: pos.top, left: pos.left }}>
      <div className="pause-menu-heading">{paused ? 'Paused — change or resume' : 'Pause'}</div>
      <button type="button" role="menuitem" className={paused && !pausedUntil ? 'on' : ''} onClick={() => choose(undefined)}>Until I resume it</button>
      <button type="button" role="menuitem" onClick={() => choose(addMonthsIso(1))}>For 1 month</button>
      <button type="button" role="menuitem" onClick={() => choose(addMonthsIso(3))}>For 3 months</button>
      <div className="pause-menu-date">
        <span>Until</span>
        <DatePicker value={pausedUntil ?? ''} onChange={v => { if (v) choose(v); }} placeholder="pick a date…" />
      </div>
      {paused && (
        <>
          <div className="pause-menu-sep" />
          <button type="button" role="menuitem" className="pause-menu-resume" onClick={() => { onResume(); onClose(); }}><Play size={12} /> Resume now</button>
        </>
      )}
    </div>,
    document.body
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

  const today = localIso();
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadIso = localIso(weekAhead);

  // Paused items stay listed (greyed, with Resume) but don't count toward any total.
  const pausedNow = (b: Bill) => isBillPaused(b, today);
  const activeItems = items.filter(b => !pausedNow(b));
  const pausedCount = items.length - activeItems.length;
  // What you actually pay each month: items that haven't started charging yet wait until they do.
  const laterItems = activeItems.filter(b => notStartedYet(b, today));
  const monthlyTotal = activeItems.filter(b => !laterItems.includes(b)).reduce((s, b) => s + billMonthlyEquivalent(b), 0);
  const totalCaption = [
    `${activeItems.length - laterItems.length} active`,
    pausedCount ? `${pausedCount} paused` : '',
    ...laterItems.map(b => `+ ${b.name} from ${formatDate(b.startDate && b.startDate > today ? b.startDate : b.nextDue)}`)
  ].filter(Boolean).join(' · ');
  const dueThisWeek = activeItems.filter(b => b.nextDue >= today && b.nextDue <= weekAheadIso);
  const pause = (b: Bill, until?: string) => patch(b, { paused: true, pausedUntil: until });
  const [pauseMenu, setPauseMenu] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const openPauseMenu = (b: Bill, el: HTMLElement) => setPauseMenu({ id: b.id, anchor: el.getBoundingClientRect() });
  const pauseMenuBill = pauseMenu ? items.find(i => i.id === pauseMenu.id) : undefined;
  const resume = (b: Bill) => patch(b, { paused: false, pausedUntil: undefined });
  const pausedLabel = (b: Bill) => (b.pausedUntil ? `Paused until ${formatDate(b.pausedUntil)}` : 'Paused');
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
    // Setting a category files this item's past charges under it too (import does the rest).
    if ('categoryId' in p && next.categoryId) {
      for (const t of chargesToRecategorize(next, data.transactions)) void upsert('transactions', { ...t, categoryId: next.categoryId });
    }
  };

  const addItem = () => {
    void upsert('bills', newRecord<Bill>({ name: '', amount: 0, nextDue: today, frequency: 'Monthly', kind, order: items.length }));
  };

  // Advances nextDue to the next cycle instead of leaving it stuck on the date that was just
  // paid — a "Once" item has no next occurrence, so this is a no-op for those.
  // Due dates with no matching imported charge — see lib/billPayments.ts.
  const missedFor = (b: Bill) => missedPaymentDates(b, data.transactions);
  const confirmPaid = (b: Bill, dates: string[]) => patch(b, { paidOverrides: [...(b.paidOverrides ?? []), ...dates] });
  const missedNote = (b: Bill) => {
    const missed = missedFor(b);
    if (!missed.length) return null;
    return (
      <div className="recur-missed">
        <AlertTriangle size={11} />
        <span>No payment found for {missed.slice(0, 2).map(d => formatDate(d)).join(', ')}{missed.length > 2 ? ` +${missed.length - 2}` : ''}</span>
        <button type="button" className="text-btn" onClick={() => confirmPaid(b, missed)} title="Mark these dates as paid (e.g. paid another way)">It was paid</button>
      </div>
    );
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
          <Kpi label={kind === 'Bill' ? 'Monthly Bills' : 'Monthly Subscriptions'} value={formatCurrency(monthlyTotal)} caption={totalCaption} tone="default" />
          <Kpi label="Due This Week" value={dueThisWeek.length} caption={dueThisWeek.map(b => b.name).join(', ') || 'nothing due soon'} tone={dueThisWeek.length ? 'amber' : 'green'} />
          <Kpi label="On Autopay" value={autopayCount} caption={`of ${items.length}`} tone="blue" />
        </div>

        <MobileRecordList
          items={sortedItems}
          primary={b => b.name || (kind === 'Bill' ? 'Untitled bill' : 'Untitled subscription')}
          secondary={b => pausedNow(b) ? pausedLabel(b) : missedFor(b).length ? `⚠ No payment found for ${formatDate(missedFor(b)[0])}` : `${formatDate(b.nextDue)} · ${b.frequency ?? 'Monthly'}`}
          trailing={b => formatCurrency(b.amount)}
          fields={[
            { label: 'Account', value: b => accountName(b.accountId) || '—' },
            { label: 'Category', value: b => categoryName(b.categoryId) || '—' },
            ...(kind === 'Subscription' ? [{ label: 'Autopay', value: (b: Bill) => (b.autopay ? 'On' : 'Off') }] : [])
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
                <MoneyInput value={editing.amount} onChange={n => patch(editing, { amount: n })} />
              </label>
              <label>
                <span>Next due</span>
                <DatePicker value={editing.nextDue} onChange={v => patch(editing, { nextDue: v })} />
              </label>
              {missedNote(editing)}
              <label><span>Started</span><DatePicker value={editing.startDate ?? ''} onChange={v => patch(editing, { startDate: v })} placeholder="When this started…" allowClear /></label>
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
              <label>
                <span>Category</span>
                <select value={editing.categoryId ?? ''} onChange={e => patch(editing, { categoryId: e.target.value || undefined })}>
                  <option value="">—</option>
                  {categoryOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="sheet-checkbox-row">
                <input type="checkbox" checked={Boolean(editing.autopay)} onChange={e => patch(editing, { autopay: e.target.checked })} />
                <span>Autopay</span>
              </label>
              <label className="sheet-checkbox-row">
                <input type="checkbox" checked={pausedNow(editing)} onChange={e => (e.target.checked ? pause(editing) : resume(editing))} />
                <span>Paused — not counted until resumed</span>
              </label>
              {pausedNow(editing) && (
                <label><span>Resume on</span><DatePicker value={editing.pausedUntil ?? ''} onChange={v => patch(editing, { pausedUntil: v || undefined })} placeholder="Until I resume it" allowClear /></label>
              )}
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
        <Kpi label={kind === 'Bill' ? 'Monthly Bills' : 'Monthly Subscriptions'} value={formatCurrency(monthlyTotal)} caption={totalCaption} tone="default" />
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
              <th>
                <SortableThLabel label="Category" sortKey="category" state={sort} onSort={k => setSort(s => toggleGridSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManager('category')} aria-label="Manage categories" title="Add or remove categories">
                  <Pencil size={11} />
                </button>
              </th>
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
                className={`${dragId === b.id ? 'dragging' : ''} ${pausedNow(b) ? 'recur-paused' : ''}`}
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
                    title={b.name || undefined}
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
                  <div className="recur-start-date-picker">
                    <DatePicker
                      value={b.startDate ?? ''}
                      onChange={v => patch(b, { startDate: v })}
                      placeholder="+ start date"
                      displayLabel={b.startDate ? `${b.startDate > today ? 'Starts' : 'Started'} ${formatDate(b.startDate)}` : undefined}
                      allowClear
                    />
                  </div>
                </td>
                <td className="grid-td-compact"><NumberCell value={b.amount} onChange={n => patch(b, { amount: n })} min={0} decimals={2} /></td>
                <td>
                  {pausedNow(b) ? (
                    <button type="button" className="recur-paused-pill" onClick={e => openPauseMenu(b, e.currentTarget)} title="Change the pause or resume">
                      <Pause size={11} /> {b.pausedUntil ? `Until ${formatDate(b.pausedUntil)}` : 'Paused'}
                    </button>
                  ) : <DatePicker value={b.nextDue} onChange={v => patch(b, { nextDue: v })} />}
                  {!pausedNow(b) && missedNote(b)}
                  {!pausedNow(b) && !missedFor(b).length && (() => {
                    const info = dueSoonInfo(b.nextDue, today);
                    if (!info) return null;
                    return (
                      <div className={`recur-due-soon ${info.severity}`}>
                        <Bell size={10} /> {info.label}
                      </div>
                    );
                  })()}
                </td>
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
                <td>
                  <select className="grid-cell-select select-wide" value={b.categoryId ?? ''} onChange={e => patch(b, { categoryId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {categoryOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
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
                <td>
                  <div className="grid-row-actions">
                    <button
                      type="button"
                      className={`icon-btn ${pausedNow(b) ? 'recur-resume-btn' : ''}`}
                      onClick={e => (pausedNow(b) ? resume(b) : openPauseMenu(b, e.currentTarget))}
                      aria-label={`${pausedNow(b) ? 'Resume' : 'Pause'} ${b.name || 'item'}`}
                      title={pausedNow(b) ? 'Resume — counts again from now' : 'Pause…'}
                    >
                      {pausedNow(b) ? <Play size={14} /> : <Pause size={14} />}
                    </button>
                    <button type="button" className="icon-btn danger" onClick={() => void remove('bills', b.id)} aria-label={`Delete ${b.name || 'item'}`}><Trash2 size={14} /></button>
                  </div>
                </td>
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

      {pauseMenu && pauseMenuBill && (
        <PauseMenu
          anchor={pauseMenu.anchor}
          paused={pausedNow(pauseMenuBill)}
          pausedUntil={pauseMenuBill.pausedUntil}
          onPause={until => pause(pauseMenuBill, until)}
          onResume={() => resume(pauseMenuBill)}
          onClose={() => setPauseMenu(null)}
        />
      )}

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
