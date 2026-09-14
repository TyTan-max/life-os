import type { Bill, BillFrequency, Budget, FinanceCategory, Transaction } from '../types';

export const BILL_MONTHLY_MULTIPLIER: Record<BillFrequency, number> = {
  Weekly: 4.33, Biweekly: 2.17, Monthly: 1, Quarterly: 1 / 3, Semiannual: 1 / 6, Yearly: 1 / 12, Once: 0
};

export function billMonthlyEquivalent(bill: Bill): number {
  return bill.amount * BILL_MONTHLY_MULTIPLIER[bill.frequency ?? 'Monthly'];
}

// One cycle forward from `dueDate` per the bill/subscription's frequency — used by "Mark Paid"
// to auto-advance nextDue instead of leaving it stuck on the date that was just paid. A "Once"
// item has no next occurrence, so it's returned unchanged.
export function advanceDueDate(dueDate: string, frequency: BillFrequency = 'Monthly'): string {
  if (frequency === 'Once') return dueDate;
  const d = new Date(`${dueDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dueDate;
  if (frequency === 'Weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'Biweekly') d.setDate(d.getDate() + 14);
  else if (frequency === 'Quarterly') d.setMonth(d.getMonth() + 3);
  else if (frequency === 'Semiannual') d.setMonth(d.getMonth() + 6);
  else if (frequency === 'Yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// Local month, not `.toISOString()` — that converts to UTC, which reads as next month late
// enough on the last day of the month for anyone west of UTC (Finance Budgets defaulting to the
// wrong month).
export function monthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function formatMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function actualSpendByCategory(transactions: Transaction[], month: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of transactions) {
    if (t.type !== 'Expense' || !t.categoryId || !t.date.startsWith(month)) continue;
    map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + t.amount);
  }
  return map;
}

export function monthlyIncome(transactions: Transaction[], month: string): number {
  return transactions
    .filter(t => t.type === 'Income' && t.date.startsWith(month))
    .reduce((sum, t) => sum + t.amount, 0);
}

export function rolloverAmount(categoryId: string, month: string, budgets: Budget[], transactions: Transaction[]): number {
  const prevMonth = shiftMonth(month, -1);
  const prevBudget = budgets.find(b => b.categoryId === categoryId && b.month === prevMonth);
  if (!prevBudget?.rolloverEnabled) return 0;
  const prevActual = actualSpendByCategory(transactions, prevMonth).get(categoryId) ?? 0;
  return Math.max(0, prevBudget.limit - prevActual);
}

export function suggest502030(income: number, categories: FinanceCategory[]): Map<string, number> {
  const needs = categories.filter(c => c.kind === 'expense' && c.budgetGroup === 'Needs');
  const wants = categories.filter(c => c.kind === 'expense' && c.budgetGroup === 'Wants');
  const suggestions = new Map<string, number>();
  if (needs.length) {
    const perNeed = Math.round(((income * 0.5) / needs.length) * 100) / 100;
    for (const c of needs) suggestions.set(c.id, perNeed);
  }
  if (wants.length) {
    const perWant = Math.round(((income * 0.3) / wants.length) * 100) / 100;
    for (const c of wants) suggestions.set(c.id, perWant);
  }
  return suggestions;
}
