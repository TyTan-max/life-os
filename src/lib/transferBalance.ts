import { isLiabilityAccount } from '../pages/FinanceAccounts';
import type { FinanceAccount, Transaction } from '../types';

// For an asset account, money arriving increases the balance and money leaving decreases it.
// For a liability account (credit card, loan), it's inverted: money arriving pays down the debt
// (balance decreases) and money leaving is a charge/advance (balance increases).
function directionalDelta(account: FinanceAccount, amount: number, incoming: boolean): number {
  const sign = incoming ? 1 : -1;
  return isLiabilityAccount(account.type) ? -sign * amount : sign * amount;
}

function transferEffect(t: Transaction | null): { fromId: string; toId: string; amount: number } | null {
  if (!t || t.type !== 'Transfer' || !t.accountId || !t.transferAccountId) return null;
  if (t.accountId === t.transferAccountId) return null;
  if (!(t.amount > 0)) return null;
  return { fromId: t.accountId, toId: t.transferAccountId, amount: t.amount };
}

// Diffs the transfer effect of a transaction before/after a change (old -> new, either may be
// null for create/delete) and returns only the accounts whose balance actually needs to change.
export function reconcileTransferBalances(
  oldTransaction: Transaction | null,
  newTransaction: Transaction | null,
  accounts: FinanceAccount[]
): FinanceAccount[] {
  const deltas = new Map<string, number>();
  const add = (id: string, amount: number) => deltas.set(id, (deltas.get(id) ?? 0) + amount);

  const oldEffect = transferEffect(oldTransaction);
  if (oldEffect) {
    const fromAcc = accounts.find(a => a.id === oldEffect.fromId);
    const toAcc = accounts.find(a => a.id === oldEffect.toId);
    if (fromAcc) add(fromAcc.id, -directionalDelta(fromAcc, oldEffect.amount, false));
    if (toAcc) add(toAcc.id, -directionalDelta(toAcc, oldEffect.amount, true));
  }

  const newEffect = transferEffect(newTransaction);
  if (newEffect) {
    const fromAcc = accounts.find(a => a.id === newEffect.fromId);
    const toAcc = accounts.find(a => a.id === newEffect.toId);
    if (fromAcc) add(fromAcc.id, directionalDelta(fromAcc, newEffect.amount, false));
    if (toAcc) add(toAcc.id, directionalDelta(toAcc, newEffect.amount, true));
  }

  const updated: FinanceAccount[] = [];
  for (const [id, delta] of deltas) {
    if (Math.abs(delta) < 0.005) continue;
    const account = accounts.find(a => a.id === id);
    if (!account) continue;
    updated.push({ ...account, balance: Math.round((account.balance + delta) * 100) / 100, lastSyncedAt: new Date().toISOString() });
  }
  return updated;
}
