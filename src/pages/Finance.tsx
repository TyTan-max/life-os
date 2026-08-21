import { useState } from 'react';
import { FinanceAccounts } from './FinanceAccounts';
import { FinanceBudgets } from './FinanceBudgets';
import { FinanceCalendar } from './FinanceCalendar';

type FinanceTab = 'Budgets' | 'Accounts' | 'Calendar';

const TABS: FinanceTab[] = ['Budgets', 'Accounts', 'Calendar'];

export function Finance() {
  const [tab, setTab] = useState<FinanceTab>('Budgets');

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
