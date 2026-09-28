import type { Bill, FinanceAccount, Transaction } from '../types';
import { formatCurrency } from '../components/UI';

export interface ForecastWarning {
  type: 'overdraft' | 'low-balance' | 'large-expense';
  message: string;
  date: string;
}

export interface ForecastEvent {
  label: string;
  amount: number;
  date: string;
}

export interface ForecastWeek {
  weekStart: string;
  balance: number;
  events: ForecastEvent[];
}

export interface ForecastResult {
  weeks: ForecastWeek[];
  warnings: ForecastWarning[];
  startingBalance: number;
  avgMonthlyIncome: number;
  lowestPoint: { date: string; balance: number };
}

const LOW_BALANCE_THRESHOLD = 200;
const LARGE_EXPENSE_THRESHOLD = 500;
const LIQUID_TYPES = ['Checking', 'Savings', 'Cash'];

function liquidBalance(accounts: FinanceAccount[]): number {
  return accounts
    .filter(a => a.status === 'Active' && LIQUID_TYPES.includes(a.type))
    .reduce((sum, a) => sum + a.balance, 0);
}

function averageMonthlyIncome(transactions: Transaction[], monthsBack = 3): number {
  const now = new Date();
  const totals: number[] = [];
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const total = transactions.filter(t => t.type === 'Income' && t.date.startsWith(month)).reduce((s, t) => s + t.amount, 0);
    if (total > 0) totals.push(total);
  }
  if (!totals.length) return 0;
  return totals.reduce((s, t) => s + t, 0) / totals.length;
}

export function billOccurrences(bill: Bill, rangeStart: Date, rangeEnd: Date): Date[] {
  const occurrences: Date[] = [];
  let cursor = new Date(`${bill.nextDue}T12:00:00`);
  if (Number.isNaN(cursor.getTime())) return occurrences;

  let guard = 0;
  while (cursor <= rangeEnd && guard < 60) {
    if (cursor >= rangeStart) occurrences.push(new Date(cursor));
    if (bill.frequency === 'Once') break;
    const next = new Date(cursor);
    if (bill.frequency === 'Weekly') next.setDate(next.getDate() + 7);
    else if (bill.frequency === 'Biweekly') next.setDate(next.getDate() + 14);
    else if (bill.frequency === 'Quarterly') next.setMonth(next.getMonth() + 3);
    else if (bill.frequency === 'Semiannual') next.setMonth(next.getMonth() + 6);
    else if (bill.frequency === 'Yearly') next.setFullYear(next.getFullYear() + 1);
    else next.setMonth(next.getMonth() + 1);
    cursor = next;
    guard += 1;
  }
  return occurrences;
}

// A bill's `nextDue` only ever moves forward, so a due date earlier in the range that hasn't
// been paid/imported yet would be missed by billOccurrences alone — step back one period too.
// Hasn't started charging yet: a start date still ahead, or a first charge more than one period
// away (e.g. a monthly plan with its first months prepaid). Not part of "what I pay each month" yet.
export function notStartedYet(bill: Bill, todayIso: string): boolean {
  if (bill.startDate && bill.startDate > todayIso) return true;
  const prev = previousDue(bill);
  if (!prev) return false;
  const p = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
  return p > todayIso;
}

export function previousDue(bill: Bill): Date | null {
  if (bill.frequency === 'Once') return null;
  const d = new Date(`${bill.nextDue}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  if (bill.frequency === 'Weekly') d.setDate(d.getDate() - 7);
  else if (bill.frequency === 'Biweekly') d.setDate(d.getDate() - 14);
  else if (bill.frequency === 'Quarterly') d.setMonth(d.getMonth() - 3);
  else if (bill.frequency === 'Semiannual') d.setMonth(d.getMonth() - 6);
  else if (bill.frequency === 'Yearly') d.setFullYear(d.getFullYear() - 1);
  else d.setMonth(d.getMonth() - 1);
  return d;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Paused on this date? A pause with a resume date ends on that date by itself.
export function isBillPaused(bill: Bill, onIso: string): boolean {
  return Boolean(bill.paused) && (!bill.pausedUntil || onIso < bill.pausedUntil);
}

// Due dates in the range that actually count — skips any that fall while the bill is paused.
export function billActiveDueDates(bill: Bill, rangeStart: Date, rangeEnd: Date): Date[] {
  return billDueDates(bill, rangeStart, rangeEnd).filter(d => !isBillPaused(bill, isoOf(d)));
}

// Every date this bill is due within the range — the forward schedule plus the one before nextDue.
export function billDueDates(bill: Bill, rangeStart: Date, rangeEnd: Date): Date[] {
  const dates = billOccurrences(bill, rangeStart, rangeEnd);
  const prev = previousDue(bill);
  if (prev && prev >= rangeStart && prev <= rangeEnd) dates.unshift(prev);
  return dates;
}

export function buildForecast(
  accounts: FinanceAccount[], bills: Bill[], transactions: Transaction[], weeksAhead = 8
): ForecastResult {
  const startingBalance = liquidBalance(accounts);
  const avgMonthlyIncome = averageMonthlyIncome(transactions);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(rangeEnd.getDate() + weeksAhead * 7);

  const events: { date: Date; label: string; amount: number }[] = [];

  for (const bill of bills) {
    for (const occ of billOccurrences(bill, today, rangeEnd).filter(d => !isBillPaused(bill, isoOf(d)))) {
      events.push({ date: occ, label: bill.name, amount: -bill.amount });
    }
  }

  if (avgMonthlyIncome > 0) {
    let cursor = new Date(today.getFullYear(), today.getMonth(), 1);
    while (cursor <= rangeEnd) {
      const payDate = cursor < today ? today : cursor;
      if (payDate <= rangeEnd) events.push({ date: payDate, label: 'Expected income', amount: avgMonthlyIncome });
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }

  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  const warnings: ForecastWarning[] = [];
  let running = startingBalance;
  let lowestPoint = { date: today.toISOString().slice(0, 10), balance: startingBalance };

  for (const e of events) {
    running += e.amount;
    const dateStr = e.date.toISOString().slice(0, 10);
    if (running < lowestPoint.balance) lowestPoint = { date: dateStr, balance: running };
    if (running < 0) {
      warnings.push({ type: 'overdraft', date: dateStr, message: `Projected to go negative around ${dateStr}, after "${e.label}"` });
    } else if (running < LOW_BALANCE_THRESHOLD) {
      warnings.push({ type: 'low-balance', date: dateStr, message: `Balance projected to dip to ${formatCurrency(running)} around ${dateStr}` });
    }
    if (e.amount < 0 && Math.abs(e.amount) >= LARGE_EXPENSE_THRESHOLD) {
      warnings.push({ type: 'large-expense', date: dateStr, message: `Large upcoming expense: ${e.label} (${formatCurrency(Math.abs(e.amount))}) on ${dateStr}` });
    }
  }

  const weeks: ForecastWeek[] = [];
  let weekCursor = new Date(today);
  let runningForWeeks = startingBalance;
  for (let w = 0; w < weeksAhead; w++) {
    const weekEnd = new Date(weekCursor);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const weekEvents = events.filter(e => e.date >= weekCursor && e.date < weekEnd);
    for (const e of weekEvents) runningForWeeks += e.amount;
    weeks.push({
      weekStart: weekCursor.toISOString().slice(0, 10),
      balance: Math.round(runningForWeeks * 100) / 100,
      events: weekEvents.map(e => ({ label: e.label, amount: e.amount, date: e.date.toISOString().slice(0, 10) }))
    });
    weekCursor = weekEnd;
  }

  return { weeks, warnings: warnings.slice(0, 12), startingBalance, avgMonthlyIncome, lowestPoint };
}
