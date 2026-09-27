import type { AppData, FinanceAccount, Settings, Transaction } from '../types';

// The Trading Journal is the source of truth for the brokerage (day-trading) account:
// balance = total deposited + all-time P/L. Finance shows that account "linked" — its balance is
// always this number, never typed in twice — and money moved into it is a transfer, not spending.

export const TRADING_LINK = 'tradingJournal' as const;

// Bank-statement description of a deposit into the trading account. Imports mark matching
// withdrawals as transfers to the linked account instead of expenses.
export const TRADING_DEPOSIT_PATTERN = /schwab\s+brokerage\s+moneylink/i;

// Undefined means $50,000 — the Trading Journal's original default "start balance".
export function tradingDeposited(settings: Settings): number {
  return settings.tradingStartBalance ?? 50000;
}

export function tradingPnl(data: Pick<AppData, 'dailyLogs'>): number {
  return data.dailyLogs.reduce((sum, log) => sum + log.dailyPL, 0);
}

export function tradingBalance(data: Pick<AppData, 'dailyLogs' | 'settings'>): number {
  return Math.round((tradingDeposited(data.settings) + tradingPnl(data)) * 100) / 100;
}

export function linkedTradingAccount(accounts: FinanceAccount[]): FinanceAccount | undefined {
  return accounts.find(a => a.linkedTo === TRADING_LINK && a.status !== 'Closed');
}

// Deposits Finance knows about: transfers into the linked account. Lags the journal between
// month-end CSV imports, which is what the Accounts tab's catch-up hint reports.
export function financeTradingDeposits(transactions: Transaction[], accountId: string): number {
  return transactions
    .filter(t => t.type === 'Transfer' && t.transferAccountId === accountId)
    .reduce((sum, t) => sum + t.amount, 0);
}

// Every reader of `data.financeAccounts` sees the linked account at its live journal balance.
export function applyLinkedBalances(data: AppData): AppData {
  if (!data.financeAccounts.some(a => a.linkedTo === TRADING_LINK)) return data;
  const balance = tradingBalance(data);
  return {
    ...data,
    financeAccounts: data.financeAccounts.map(a => (a.linkedTo === TRADING_LINK ? { ...a, balance } : a))
  };
}
