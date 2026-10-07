import { useMemo, useState } from 'react';
import { takeJump } from '../lib/jumpTo';
import { Upload, X } from 'lucide-react';
import { useStore } from '../store';
import { formatDate } from '../components/UI';
import { requestImport } from '../lib/importRequest';
import { FinanceAccounts, FinanceDebtGrid } from './FinanceAccounts';
import { FinanceBudgets } from './FinanceBudgets';
import { FinanceCalendar } from './FinanceCalendar';
import { FinanceTransactions } from './FinanceTransactions';
import { FinanceBills } from './FinanceBills';
import { FinanceSubscriptions } from './FinanceSubscriptions';
import { FinanceSavingsGrid } from './FinanceGoals';
import { useIsMobile } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';

type FinanceTab = 'Budgets' | 'Accounts' | 'Calendar';

// Everything this month (spending, left over, paid/missed bills) is only as fresh as the last
// import. Once the newest transaction is a week old, say so — until the next import, or dismissed.
const STALE_DAYS = 7;
const STALE_DISMISS_KEY = 'finance-stale-dismissed';

function StaleImportBanner({ onImport }: { onImport: () => void }) {
  const { data } = useStore();
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const latest = useMemo(
    () => data.transactions.reduce((max, t) => (t.date <= todayIso && t.date > max ? t.date : max), ''),
    [data.transactions, todayIso]
  );
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => {
    try { return localStorage.getItem(STALE_DISMISS_KEY); } catch { return null; }
  });
  if (!latest || dismissedFor === latest) return null;
  const days = Math.round((new Date(`${todayIso}T12:00:00`).getTime() - new Date(`${latest}T12:00:00`).getTime()) / 86_400_000);
  if (days < STALE_DAYS) return null;
  const dismiss = () => {
    setDismissedFor(latest);
    try { localStorage.setItem(STALE_DISMISS_KEY, latest); } catch { /* ignore */ }
  };
  return (
    <div className="finance-stale" role="status">
      <Upload size={15} className="finance-stale-icon" />
      <span><b>Newest transaction is from {formatDate(latest)}</b> — {days} days ago.<span className="finance-stale-more"> This month's spending and bill checks don't include anything since.</span></span>
      <button type="button" className="btn primary small" onClick={onImport}>Import CSV</button>
      <button type="button" className="icon-btn" onClick={dismiss} aria-label="Hide until the next import" title="Hide until the next import"><X size={14} /></button>
    </div>
  );
}

const TABS: FinanceTab[] = ['Budgets', 'Accounts', 'Calendar'];

// On a phone the ledger's six sub-tabs (Transactions…Savings) used to sit at the bottom of the
// Budgets page — ~2,500px down, three screens below the top. Here every view is a peer in one
// scrollable tab row, and Transactions, the thing most often opened Finance for on a phone,
// comes first.
type MobileFinanceTab = 'Transactions' | 'Budgets' | 'Bills' | 'Subscriptions' | 'Accounts' | 'Income' | 'Debt' | 'Savings' | 'Calendar';

const MOBILE_TABS: MobileFinanceTab[] = ['Transactions', 'Budgets', 'Bills', 'Subscriptions', 'Accounts', 'Income', 'Debt', 'Savings', 'Calendar'];

export function Finance() {
  const isMobile = useIsMobile();
  // Arriving from All Notes: open the tab the note's record lives on. (The desktop layout keeps
  // transactions, bills and subscriptions under Budgets, and savings goals under Accounts.)
  const [jump] = useState(() => takeJump('Finance'));
  const [tab, setTab] = useState<FinanceTab>(jump?.tab === 'Accounts' || jump?.tab === 'Savings' ? 'Accounts' : 'Budgets');
  const [mobileTab, setMobileTab] = useState<MobileFinanceTab>(
    jump?.tab && (MOBILE_TABS as string[]).includes(jump.tab) ? jump.tab as MobileFinanceTab : 'Transactions');
  // FinanceTransactions owns the FAB while it's mounted (Transactions/Income). On every other
  // tab the FAB would otherwise fall back to Quick capture, so it claims it here instead: jump
  // to Transactions and open a new one there.
  const [pendingAdd, setPendingAdd] = useState(false);
  const ledgerTabShown = mobileTab === 'Transactions' || mobileTab === 'Income';
  useFabAction(isMobile && !ledgerTabShown ? 'Finance' : null, 'Add transaction', () => {
    setPendingAdd(true);
    setMobileTab('Transactions');
  });

  if (isMobile) {
    return (
      <>
        <div className="page-header"><div><h1>Finance</h1></div></div>
        <div className="filter-row finance-m-tabs">
          <div className="segmented" role="tablist" aria-label="Finance views">
            {MOBILE_TABS.map(t => (
              <button
                type="button"
                key={t}
                role="tab"
                aria-selected={mobileTab === t}
                className={mobileTab === t ? 'on' : ''}
                onClick={e => { setMobileTab(t); e.currentTarget.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); }}
              >{t}</button>
            ))}
          </div>
        </div>
        <StaleImportBanner onImport={() => { setMobileTab('Transactions'); requestImport(); }} />

        {mobileTab === 'Transactions' && <FinanceTransactions autoAdd={pendingAdd} onAutoAdded={() => setPendingAdd(false)} />}
        {mobileTab === 'Budgets' && <FinanceBudgets hideLedger />}
        {mobileTab === 'Bills' && <FinanceBills />}
        {mobileTab === 'Subscriptions' && <FinanceSubscriptions />}
        {mobileTab === 'Accounts' && <FinanceAccounts />}
        {mobileTab === 'Income' && <FinanceTransactions typeFilter="Income" />}
        {mobileTab === 'Debt' && <FinanceDebtGrid />}
        {mobileTab === 'Savings' && <FinanceSavingsGrid />}
        {mobileTab === 'Calendar' && <FinanceCalendar />}
      </>
    );
  }

  return (
    <>
      <div className="page-header finance-header">
        <div><h1>Finance</h1><p>Budgets, accounts and what's coming due.</p></div>
        <div className="segmented">
          {TABS.map(t => (
            <button type="button" key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>
      <StaleImportBanner onImport={() => { setTab('Budgets'); requestImport(); }} />

      {tab === 'Budgets' && <FinanceBudgets />}
      {tab === 'Accounts' && <FinanceAccounts />}
      {tab === 'Calendar' && <FinanceCalendar />}
    </>
  );
}
