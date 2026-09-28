import type { Bill, Transaction } from '../types';
import { isBillPaused, previousDue } from './cashFlowForecast';

// "Was this bill actually paid?" — answered only from imported transactions, and only for due
// dates the imported data can speak to. Due dates after the newest imported transaction (minus a
// few days for charges that post late) are never flagged: not imported yet ≠ not paid.

const DAY = 86_400_000;
const POST_LAG_DAYS = 3;       // a charge can post a few days after its due date
const MATCH_BEFORE_DAYS = 5;   // …or a few days early
const MATCH_AFTER_DAYS = 10;
const LOOKBACK_DAYS = 90;      // older gaps are history, not something to act on

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toDate(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00`);
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function paymentMatches(bill: Bill, t: Transaction): boolean {
  if (t.type !== 'Expense') return false;
  const a = norm(bill.name); const b = norm(t.merchant);
  if (!a || !b || !(a.includes(b) || b.includes(a))) return false;
  return Math.abs(t.amount - bill.amount) <= Math.max(3, bill.amount * 0.15);
}

// A bill/subscription's own category, for a charge that is one of its payments. Name has to
// match and the amount has to be close to the current price or one it used to be.
export function billCategoryForCharge(bills: Bill[], merchant: string, amount: number): string | undefined {
  const m = norm(merchant);
  if (!m) return undefined;
  const hit = bills.find(bill => {
    if (!bill.categoryId) return false;
    const n = norm(bill.name);
    if (!n || !(n.includes(m) || m.includes(n))) return false;
    const prices = [bill.amount, ...(bill.priceHistory ?? []).map(h => h.amount), ...(bill.amountHistory ?? []).map(h => h.amount)];
    return prices.some(p => Math.abs(amount - p) <= Math.max(3, p * 0.15));
  });
  return hit?.categoryId;
}

/** Past expense charges that belong to this bill but sit in a different category. */
export function chargesToRecategorize(bill: Bill, transactions: Transaction[]): Transaction[] {
  if (!bill.categoryId) return [];
  return transactions.filter(t => t.type === 'Expense' && t.categoryId !== bill.categoryId
    && billCategoryForCharge([bill], t.merchant, t.amount) === bill.categoryId);
}

function paidAround(bill: Bill, dueIso: string, transactions: Transaction[]): boolean {
  const due = toDate(dueIso).getTime();
  return transactions.some(t => {
    const at = toDate(t.date).getTime();
    return at >= due - MATCH_BEFORE_DAYS * DAY && at <= due + MATCH_AFTER_DAYS * DAY && paymentMatches(bill, t);
  });
}

// Newest imported date the check can trust — per the bill's own account when it has one.
function importedThrough(bill: Bill, transactions: Transaction[]): string | undefined {
  let latest: string | undefined;
  for (const t of transactions) {
    if (bill.accountId && t.accountId !== bill.accountId) continue;
    if (!latest || t.date > latest) latest = t.date;
  }
  return latest;
}

// Past due dates (newest first) between `fromIso` and `toIso`, stepping back from nextDue.
function dueDatesBetween(bill: Bill, fromIso: string, toIso: string): string[] {
  const dates: string[] = [];
  if (bill.nextDue <= toIso && bill.nextDue >= fromIso) dates.push(bill.nextDue);
  if ((bill.frequency ?? 'Monthly') === 'Once') return dates;
  let cursor: Bill = bill;
  for (let guard = 0; guard < 60; guard += 1) {
    const prev = previousDue(cursor);
    if (!prev) break;
    const p = iso(prev);
    if (p < fromIso) break;
    if (p <= toIso) dates.push(p);
    cursor = { ...cursor, nextDue: p };
  }
  return dates;
}

/** Due dates that should have been paid by now but have no matching charge. Newest first. */
export function missedPaymentDates(bill: Bill, transactions: Transaction[], today = new Date()): string[] {
  const through = importedThrough(bill, transactions);
  if (!through) return [];
  const cutoff = iso(new Date(Math.min(toDate(through).getTime() - POST_LAG_DAYS * DAY, today.getTime())));
  const floors = [
    iso(new Date(today.getTime() - LOOKBACK_DAYS * DAY)),
    bill.startDate,
    bill.createdAt?.slice(0, 10),
    bill.isFreeTrial ? bill.trialEndDate : undefined
  ].filter((d): d is string => Boolean(d));
  const sortedFloors = floors.sort();
  const from = sortedFloors[sortedFloors.length - 1];
  return dueDatesBetween(bill, from, cutoff).filter(d =>
    !isBillPaused(bill, d) && !(bill.paidOverrides ?? []).includes(d) && !paidAround(bill, d, transactions));
}

// Once a due date has passed, the next one is what's "due" — for every bill, not just autopay.
// Whether the passed one was actually paid is missedPaymentDates' job.
export function rolledForwardDue(bill: Bill, todayIso: string, advance: (d: string) => string): string {
  if ((bill.frequency ?? 'Monthly') === 'Once' || bill.paused) return bill.nextDue;
  let next = bill.nextDue;
  for (let guard = 0; next < todayIso && guard < 240; guard += 1) next = advance(next);
  return next;
}
