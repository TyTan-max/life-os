import type { FinanceCategory, PaySchedule, Transaction } from '../types';

// Scheduled paychecks: when they're due, and whether the imported transactions show them.
// Income that isn't guaranteed (side hustle, cash deposits) is never scheduled — it only counts
// once it arrives.

const DAY = 86_400_000;
const MATCH_BEFORE_DAYS = 4;   // direct deposit can land a few days early (holidays, weekends)
const MATCH_AFTER_DAYS = 4;
const POST_LAG_DAYS = 3;

export const PAY_FREQUENCIES: PaySchedule['frequency'][] = ['Weekly', 'Biweekly', 'Semimonthly', 'Monthly'];

const toTime = (iso: string) => new Date(`${iso}T12:00:00`).getTime();
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Every payday from the schedule's first payday on, between fromIso and toIso (inclusive). */
export function paydaysBetween(s: PaySchedule, fromIso: string, toIso: string): string[] {
  if (!s.firstPayday || fromIso > toIso) return [];
  const out: string[] = [];
  const start = s.firstPayday > fromIso ? s.firstPayday : fromIso;
  if (s.frequency === 'Weekly' || s.frequency === 'Biweekly') {
    const step = s.frequency === 'Weekly' ? 7 : 14;
    const first = toTime(s.firstPayday);
    // Whole days (rounded) — a daylight-saving change makes the raw gap an hour off.
    const daysIn = Math.round((toTime(start) - first) / DAY);
    const skip = Math.max(0, Math.ceil(daysIn / step));
    for (let t = first + skip * step * DAY; ; t += step * DAY) {
      const d = iso(new Date(t));
      if (d > toIso) break;
      out.push(d);
    }
    return out;
  }
  // Semimonthly: the 15th and the last day of the month. Monthly: the first payday's day of month.
  const firstDay = Number(s.firstPayday.slice(8, 10));
  let y = Number(start.slice(0, 4)); let m = Number(start.slice(5, 7)) - 1;
  for (let guard = 0; guard < 240; guard += 1) {
    const last = lastDayOfMonth(y, m);
    const days = s.frequency === 'Semimonthly' ? [15, last] : [Math.min(firstDay, last)];
    for (const day of days) {
      const d = iso(new Date(y, m, day));
      if (d >= start && d <= toIso) out.push(d);
    }
    if (iso(new Date(y, m, last)) >= toIso) break;
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

export type PaydayState = 'upcoming' | 'received' | 'missed' | 'pending';

export interface Payday {
  schedule: PaySchedule;
  date: string;
  state: PaydayState;
  /** The deposit that matched, once received. */
  transaction?: Transaction;
}

/**
 * A payday is received when an income deposit lands within a few days of it at roughly the
 * expected amount (first checks are often partial, so the range is wide). Deposits filed under
 * `excludeCategoryIds` (side hustle, cash deposits) never count as a paycheck.
 */
export function paydayState(
  s: PaySchedule, date: string, transactions: Transaction[], todayIso: string, excludeCategoryIds: Set<string>
): Payday {
  const at = toTime(date);
  const match = transactions.find(t => {
    if (t.type !== 'Income' || (t.categoryId && excludeCategoryIds.has(t.categoryId))) return false;
    const tt = toTime(t.date);
    if (tt < at - MATCH_BEFORE_DAYS * DAY || tt > at + MATCH_AFTER_DAYS * DAY) return false;
    if (s.amount > 0 && (t.amount < s.amount * 0.4 || t.amount > s.amount * 1.6)) return false;
    return s.matchText ? norm(t.merchant).includes(norm(s.matchText)) : true;
  });
  if (match) return { schedule: s, date, state: 'received', transaction: match };
  if (date >= todayIso) return { schedule: s, date, state: 'upcoming' };
  const newest = transactions.reduce((max, t) => (t.date > max ? t.date : max), '');
  const covered = newest && toTime(newest) >= at + POST_LAG_DAYS * DAY;
  return { schedule: s, date, state: covered ? 'missed' : 'pending' };
}

// Income that's never a paycheck: irregular money and refunds.
export const SIDE_HUSTLE_CATEGORY = 'Side hustle';
export const CASH_DEPOSIT_CATEGORY = 'Cash deposit';
const NOT_PAY = new Set([SIDE_HUSTLE_CATEGORY, CASH_DEPOSIT_CATEGORY, 'Refund', 'Tax Return', 'Investment Income'].map(n => n.toLowerCase()));
export function nonPayCategoryIds(categories: FinanceCategory[]): Set<string> {
  return new Set(categories.filter(c => NOT_PAY.has(c.name.toLowerCase())).map(c => c.id));
}

export function paydaysIn(
  schedules: PaySchedule[], fromIso: string, toIso: string, transactions: Transaction[], todayIso: string, excludeCategoryIds: Set<string>
): Payday[] {
  return schedules
    .flatMap(s => paydaysBetween(s, fromIso, toIso).map(d => paydayState(s, d, transactions, todayIso, excludeCategoryIds)))
    .sort((a, b) => a.date.localeCompare(b.date));
}
