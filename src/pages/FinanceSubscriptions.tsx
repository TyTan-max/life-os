import { useMemo, useState } from 'react';
import { EyeOff, Pencil, Plus } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { formatCurrency, formatDate } from '../components/UI';
import { FinanceRecurringGrid } from './FinanceBills';
import { ListManagerModal } from '../components/ListManagerModal';
import { detectSubscriptions } from '../lib/subscriptionDetector';
import type { Bill } from '../types';

const normalizeMerchant = (name: string) => name.trim().toLowerCase();

export function FinanceSubscriptions() {
  const { data, upsert, updateSettings } = useStore();
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissed = data.settings.dismissedSubscriptionSuggestions ?? [];

  const trackedNames = useMemo(
    () => new Set(data.bills.filter(b => (b.kind ?? 'Bill') === 'Subscription').map(b => b.name.trim().toLowerCase())),
    [data.bills]
  );

  const dismissedSet = useMemo(() => new Set(dismissed), [dismissed]);

  const suggestions = useMemo(
    () => detectSubscriptions(data.transactions).filter(s => {
      const key = normalizeMerchant(s.merchant);
      return !trackedNames.has(key) && !dismissedSet.has(key);
    }),
    [data.transactions, trackedNames, dismissedSet]
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

  const dismissSuggestion = (merchant: string) => {
    const key = normalizeMerchant(merchant);
    if (dismissedSet.has(key)) return;
    void updateSettings({ dismissedSubscriptionSuggestions: [...dismissed, key] });
  };

  const restoreDismissed = (key: string) => {
    void updateSettings({ dismissedSubscriptionSuggestions: dismissed.filter(d => d !== key) });
  };

  return (
    <>
      <FinanceRecurringGrid kind="Subscription" />

      {(suggestions.length > 0 || dismissed.length > 0) && (
        <div className="recur-suggestions">
          <div className="card-title">
            <div><h2>Suggested from your transactions</h2></div>
            {dismissed.length > 0 && (
              <button type="button" className="col-edit-btn" onClick={() => setShowDismissed(true)} title="Manage dismissed suggestions">
                <Pencil size={11} />
              </button>
            )}
          </div>
          <p className="muted recur-suggestions-hint">
            Detected from repeat charges — add the ones that are real subscriptions, or dismiss the ones that aren't
            (a recurring restaurant order, a credit card payment, etc.) so they stop reappearing.
          </p>
          {suggestions.length > 0 && (
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
                      <td className="grid-row-actions">
                        <button type="button" className="btn ghost small" onClick={() => addSuggestion(s)}>
                          <Plus size={13} /> Add
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Not a subscription — stop suggesting this"
                          aria-label={`Dismiss ${s.merchant}`}
                          onClick={() => dismissSuggestion(s.merchant)}
                        >
                          <EyeOff size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {showDismissed && (
        <ListManagerModal
          title="Dismissed Suggestions"
          subtitle="Merchants hidden from the suggestion list above. Remove one to let it be suggested again."
          items={dismissed.map(d => ({ id: d, label: d }))}
          onAdd={name => {
            const key = normalizeMerchant(name);
            if (!dismissed.includes(key)) void updateSettings({ dismissedSubscriptionSuggestions: [...dismissed, key] });
          }}
          onDelete={restoreDismissed}
          onClose={() => setShowDismissed(false)}
          addPlaceholder="Pre-dismiss a merchant name…"
        />
      )}
    </>
  );
}
