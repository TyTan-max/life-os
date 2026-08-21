import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { formatCurrency, formatDate } from '../components/UI';
import { FinanceRecurringGrid } from './FinanceBills';
import { detectSubscriptions } from '../lib/subscriptionDetector';
import type { Bill } from '../types';

export function FinanceSubscriptions() {
  const { data, upsert } = useStore();

  const trackedNames = useMemo(
    () => new Set(data.bills.filter(b => (b.kind ?? 'Bill') === 'Subscription').map(b => b.name.trim().toLowerCase())),
    [data.bills]
  );

  const suggestions = useMemo(
    () => detectSubscriptions(data.transactions).filter(s => !trackedNames.has(s.merchant.trim().toLowerCase())),
    [data.transactions, trackedNames]
  );

  const addSuggestion = (s: (typeof suggestions)[number]) => {
    void upsert('bills', newRecord<Bill>({
      name: s.merchant,
      amount: s.lastAmount,
      nextDue: s.nextExpectedDate,
      frequency: s.frequency,
      categoryId: s.categoryId,
      kind: 'Subscription'
    }));
  };

  return (
    <>
      <FinanceRecurringGrid kind="Subscription" />

      {suggestions.length > 0 && (
        <div className="recur-suggestions">
          <div className="card-title"><div><h2>Suggested from your transactions</h2></div></div>
          <p className="muted recur-suggestions-hint">
            Detected from repeat charges — add the ones that are real subscriptions.
          </p>
          <div className="grid-table-wrap">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Frequency</th>
                  <th>Last Charged</th>
                  <th>Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {suggestions.map(s => (
                  <tr key={s.merchant}>
                    <td className="grid-static-cell">{s.merchant}</td>
                    <td className="grid-static-cell">{s.frequency}</td>
                    <td className="grid-static-cell">{formatDate(s.lastDate)}</td>
                    <td className="grid-static-cell">{formatCurrency(s.lastAmount)}</td>
                    <td>
                      <button type="button" className="btn ghost small" onClick={() => addSuggestion(s)}>
                        <Plus size={13} /> Add
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
