import { useState } from 'react';
import { FinanceTransactions } from './FinanceTransactions';
import { FinanceBills } from './FinanceBills';
import { FinanceSubscriptions } from './FinanceSubscriptions';
import { FinanceDebtGrid } from './FinanceAccounts';
import { FinanceSavingsGrid } from './FinanceGoals';

export type LedgerTab = 'Transactions' | 'Bills' | 'Subscriptions' | 'Income' | 'Debt' | 'Savings';

const TABS: LedgerTab[] = ['Transactions', 'Bills', 'Subscriptions', 'Income', 'Debt', 'Savings'];

export function FinanceLedger({ tab: controlledTab, onTabChange }: { tab?: LedgerTab; onTabChange?: (tab: LedgerTab) => void } = {}) {
  const [ownTab, setOwnTab] = useState<LedgerTab>('Transactions');
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;

  return (
    <>
      <div className="filter-row" id="finance-ledger">
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
