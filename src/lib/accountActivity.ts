import type { AppData, FinanceAccount, Transaction } from '../types';
import { CORE_DEBT_TYPES } from '../types';
import { TRADING_LINK } from './trading';

// "Balance as of a date": the balance you typed in is right as of `balanceAsOf`; transactions
// dated after that move it (imports included), so it stays about right until you check it again.
// Transfers made in the app already moved the stored balance (see transferBalance), so they're
// skipped here. The linked trading account always uses the Trading Journal instead.

/** Fields added to each live account for display — never saved (the store strips them). */
export interface AccountActivity {
  /** The balance as typed, before newer transactions. */
  baseBalance?: number;
  /** base + activity; equals `balance` on the live account. */
  effectiveBalance?: number;
  /** How many transactions after `balanceAsOf` are included. */
  activityCount?: number;
}

// Local check (not FinanceAccounts' isLiabilityAccount) so the store can use this without an import cycle.
function isDebt(account: FinanceAccount, customDebtTypes: string[]): boolean {
  return (CORE_DEBT_TYPES as readonly string[]).includes(account.type) || customDebtTypes.includes(account.type);
}

function effectOn(account: FinanceAccount, t: Transaction, liability: boolean): number {
  const out = (amt: number) => (liability ? amt : -amt);   // money leaving / charged
  const inc = (amt: number) => (liability ? -amt : amt);   // money arriving / paid down
  if (t.type === 'Transfer' && t.transferAccountId) {
    if (t.balanceApplied) return 0;
    if (t.accountId === account.id && t.transferAccountId !== account.id) return out(t.amount);
    if (t.transferAccountId === account.id && t.accountId !== account.id) return inc(t.amount);
    return 0;
  }
  if (t.accountId !== account.id) return 0;
  if (t.type === 'Expense') return out(t.amount);
  if (t.type === 'Income') return inc(t.amount);
  return 0;
}

export function activitySince(account: FinanceAccount, transactions: Transaction[], customDebtTypes: string[] = []): { delta: number; count: number } {
  if (!account.balanceAsOf || account.linkedTo === TRADING_LINK) return { delta: 0, count: 0 };
  const liability = isDebt(account, customDebtTypes);
  let delta = 0; let count = 0;
  for (const t of transactions) {
    if (t.date <= account.balanceAsOf) continue;
    const e = effectOn(account, t, liability);
    if (e !== 0) { delta += e; count += 1; }
  }
  return { delta: Math.round(delta * 100) / 100, count };
}

export function applyAccountActivity(data: AppData): AppData {
  if (!data.financeAccounts.some(a => a.balanceAsOf)) return data;
  return {
    ...data,
    financeAccounts: data.financeAccounts.map(a => {
      if (!a.balanceAsOf || a.linkedTo === TRADING_LINK) return a;
      const { delta, count } = activitySince(a, data.transactions, data.settings.customDebtTypes ?? []);
      const effective = Math.round((a.balance + delta) * 100) / 100;
      return { ...a, balance: effective, baseBalance: a.balance, effectiveBalance: effective, activityCount: count };
    })
  };
}

/** Drops the display-only fields, e.g. when a new balance was typed in (it is the new base). */
export function stripActivity<T extends FinanceAccount & AccountActivity>(record: T): FinanceAccount {
  const { baseBalance, effectiveBalance, activityCount, ...rest } = record;
  void baseBalance; void effectiveBalance; void activityCount;
  return rest;
}

/**
 * Turns a live account back into what's stored. Left as shown, the balance goes back to the
 * typed base (the newer transactions are re-applied on read). Changed some other way, it's a new
 * reading, dated today.
 */
export function toStoredAccount(record: FinanceAccount & AccountActivity, todayIso: string): FinanceAccount {
  const rest = stripActivity(record);
  if (record.effectiveBalance === undefined || record.baseBalance === undefined) return rest;
  if (Math.abs(rest.balance - record.effectiveBalance) < 0.005) return { ...rest, balance: record.baseBalance };
  return { ...rest, balanceAsOf: todayIso };
}
