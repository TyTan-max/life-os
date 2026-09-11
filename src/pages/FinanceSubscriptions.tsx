import { useEffect, useMemo, useState } from 'react';
import { EyeOff, Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { formatCurrency, formatDate, Modal } from '../components/UI';
import { FinanceRecurringGrid } from './FinanceBills';
import { detectSubscriptions, type DetectedSubscription } from '../lib/subscriptionDetector';
import type { Bill } from '../types';

const normalizeMerchant = (name: string) => name.trim().toLowerCase();

export function FinanceSubscriptions() {
  const { data, upsert, updateSettings } = useStore();
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissDraft, setDismissDraft] = useState('');

  const rawDismissed = data.settings.dismissedSubscriptionSuggestions;
  const dismissed: Record<string, number> = Array.isArray(rawDismissed) ? {} : rawDismissed ?? {};
  const hiddenFromManagement = useMemo(
    () => new Set(data.settings.hiddenDismissedSuggestions ?? []),
    [data.settings.hiddenDismissedSuggestions]
  );

  const trackedNames = useMemo(
    () => new Set(data.bills.filter(b => (b.kind ?? 'Bill') === 'Subscription').map(b => b.name.trim().toLowerCase())),
    [data.bills]
  );

  const allDetected = useMemo(() => detectSubscriptions(data.transactions), [data.transactions]);

  // One-time migration from the old string[] shape (dismissed merchant names with no occurrence
  // count) to the current shape. Freezes each merchant's baseline at its occurrence count *right
  // now* — the original dismissal-time count is gone, but this is the only value that won't
  // immediately flip the merchant back to visible (an ever-recomputed "current count" baseline
  // would trail the live count by zero forever and could never reappear either).
  useEffect(() => {
    if (!Array.isArray(rawDismissed)) return;
    const migrated = Object.fromEntries(rawDismissed.map(key => {
      const existing = allDetected.find(s => normalizeMerchant(s.merchant) === key);
      return [key, existing?.occurrenceCount ?? 0];
    }));
    void updateSettings({ dismissedSubscriptionSuggestions: migrated });
  }, [rawDismissed, allDetected, updateSettings]);

  // A dismissed merchant stays hidden until it's charged at least 2 more times than it had at the
  // moment it was dismissed — that's fresh evidence it's a real recurring charge, not the same
  // false positive (a repeat restaurant order, a one-off card payment) being re-flagged forever.
  const suggestions = useMemo(
    () => allDetected.filter(s => {
      const key = normalizeMerchant(s.merchant);
      if (trackedNames.has(key)) return false;
      const dismissedAtCount = dismissed[key];
      if (dismissedAtCount !== undefined && s.occurrenceCount < dismissedAtCount + 2) return false;
      return true;
    }),
    [allDetected, trackedNames, dismissed]
  );

  const addSuggestion = (s: DetectedSubscription) => {
    void upsert('bills', newRecord<Bill>({
      name: s.merchant,
      amount: s.lastAmount,
      nextDue: s.nextExpectedDate,
      frequency: s.frequency,
      categoryId: s.categoryId,
      kind: 'Subscription'
    }));
  };

  const dismissSuggestion = (s: DetectedSubscription) => {
    const key = normalizeMerchant(s.merchant);
    void updateSettings({ dismissedSubscriptionSuggestions: { ...dismissed, [key]: s.occurrenceCount } });
  };

  // "Add back to Suggested": un-dismiss entirely, so it reappears in Suggested immediately.
  const restoreDismissed = (key: string) => {
    const { [key]: _omit, ...rest } = dismissed;
    void updateSettings({
      dismissedSubscriptionSuggestions: rest,
      ...(hiddenFromManagement.has(key) ? { hiddenDismissedSuggestions: [...hiddenFromManagement].filter(k => k !== key) } : {})
    });
  };

  // "Erase from dismissed list": the opposite of restore — the dismissal (and its 2-more-charges
  // threshold) stays fully in effect, this just drops the entry from this management view since
  // there's nothing left to do with it here. It reappears in Suggested on its own once the
  // threshold is met, same as any other dismissal, with no separate action needed then.
  const hideFromManagement = (key: string) => {
    void updateSettings({ hiddenDismissedSuggestions: [...hiddenFromManagement, key] });
  };

  const dismissedKeys = Object.keys(dismissed).filter(key => !hiddenFromManagement.has(key));

  return (
    <>
      <FinanceRecurringGrid kind="Subscription" />

      {(suggestions.length > 0 || dismissedKeys.length > 0) && (
        <div className="recur-suggestions">
          <div className="card-title">
            <div><h2>Suggested from your transactions</h2></div>
            {dismissedKeys.length > 0 && (
              <button type="button" className="col-edit-btn" onClick={() => setShowDismissed(true)} title="Manage dismissed suggestions">
                <Pencil size={11} />
              </button>
            )}
          </div>
          <p className="muted recur-suggestions-hint">
            Detected from repeat charges — add the ones that are real subscriptions, or dismiss the ones that aren't
            (a recurring restaurant order, a credit card payment, etc.). A dismissed merchant reappears automatically
            if it's charged 2 more times later.
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
                          title="Not a subscription — hide until it's charged 2 more times"
                          aria-label={`Dismiss ${s.merchant}`}
                          onClick={() => dismissSuggestion(s)}
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
        <Modal
          eyebrow="Life OS"
          title="Dismissed Suggestions"
          onClose={() => setShowDismissed(false)}
        >
          <p className="list-manager-subtitle">
            Hidden until charged 2 more times since dismissal.
          </p>
          <div className="list-manager-items">
            {dismissedKeys.length ? dismissedKeys.map(key => (
              <div className="list-manager-row" key={key}>
                <span className="list-manager-row-label">{key}</span>
                <button
                  type="button"
                  className="icon-btn"
                  title="Add back to the Suggested list now"
                  aria-label={`Add ${key} back to Suggested`}
                  onClick={() => restoreDismissed(key)}
                >
                  <Plus size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="Remove from this list — stays hidden until it's charged 2 more times"
                  aria-label={`Erase ${key} from dismissed list`}
                  onClick={() => hideFromManagement(key)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )) : <p className="muted empty-state">Nothing dismissed.</p>}
          </div>
          <div className="list-manager-add">
            <input
              type="text"
              value={dismissDraft}
              placeholder="Pre-dismiss a merchant name…"
              onChange={e => setDismissDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                const key = normalizeMerchant(dismissDraft);
                if (!key) return;
                const existing = allDetected.find(s => normalizeMerchant(s.merchant) === key);
                void updateSettings({ dismissedSubscriptionSuggestions: { ...dismissed, [key]: existing?.occurrenceCount ?? 0 } });
                setDismissDraft('');
              }}
            />
            <button
              type="button"
              className="btn teal small"
              onClick={() => {
                const key = normalizeMerchant(dismissDraft);
                if (!key) return;
                const existing = allDetected.find(s => normalizeMerchant(s.merchant) === key);
                void updateSettings({ dismissedSubscriptionSuggestions: { ...dismissed, [key]: existing?.occurrenceCount ?? 0 } });
                setDismissDraft('');
              }}
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
