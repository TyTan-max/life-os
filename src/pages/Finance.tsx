import { useState } from 'react';
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

const TABS: FinanceTab[] = ['Budgets', 'Accounts', 'Calendar'];

// On a phone the ledger's six sub-tabs (Transactions…Savings) used to sit at the bottom of the
// Budgets page — ~2,500px down, three screens below the top. Here every view is a peer in one
// scrollable tab row, and Transactions, the thing most often opened Finance for on a phone,
// comes first.
type MobileFinanceTab = 'Transactions' | 'Budgets' | 'Bills' | 'Subscriptions' | 'Accounts' | 'Income' | 'Debt' | 'Savings' | 'Calendar';

const MOBILE_TABS: MobileFinanceTab[] = ['Transactions', 'Budgets', 'Bills', 'Subscriptions', 'Accounts', 'Income', 'Debt', 'Savings', 'Calendar'];

export function Finance() {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<FinanceTab>('Budgets');
  const [mobileTab, setMobileTab] = useState<MobileFinanceTab>('Transactions');
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
      <div className="filter-row">
        <div className="segmented">
          {TABS.map(t => (
            <button type="button" key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>

      {tab === 'Budgets' && <FinanceBudgets />}
      {tab === 'Accounts' && <FinanceAccounts />}
      {tab === 'Calendar' && <FinanceCalendar />}
    </>
  );
}
