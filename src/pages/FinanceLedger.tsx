import { useState } from 'react';
import { FinanceTransactions } from './FinanceTransactions';
import { FinanceBills } from './FinanceBills';
import { FinanceSubscriptions } from './FinanceSubscriptions';
import { FinanceDebtGrid } from './FinanceAccounts';
import { FinanceSavingsGrid } from './FinanceGoals';

type LedgerTab = 'Transactions' | 'Bills' | 'Subscriptions' | 'Income' | 'Debt' | 'Savings';

const TABS: LedgerTab[] = ['Transactions', 'Bills', 'Subscriptions', 'Income', 'Debt', 'Savings'];

export function FinanceLedger() {
  const [tab, setTab] = useState<LedgerTab>('Transactions');

  return (
    <>
      <div className="filter-row">
        <div className="segmented">
          {TABS.map(t => (
            <button type="button" key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
      </div>

      {tab === 'Transactions' && <FinanceTransactions />}
      {tab === 'Bills' && <FinanceBills />}
      {tab === 'Subscriptions' && <FinanceSubscriptions />}
      {tab === 'Income' && <FinanceTransactions typeFilter="Income" />}
      {tab === 'Debt' && <FinanceDebtGrid />}
      {tab === 'Savings' && <FinanceSavingsGrid />}
    </>
  );
}
