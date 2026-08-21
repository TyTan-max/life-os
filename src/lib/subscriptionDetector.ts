import type { Transaction, TransactionType } from '../types';

export type SubscriptionFlag = 'recently-increased' | 'expensive' | 'lapsed';
export type SubscriptionFrequency = 'Weekly' | 'Monthly' | 'Yearly';

export interface DetectedSubscription {
  merchant: string;
  categoryId?: string;
  frequency: SubscriptionFrequency;
  lastAmount: number;
  previousAmount?: number;
  occurrenceCount: number;
  lastDate: string;
  nextExpectedDate: string;
  monthlyEquivalent: number;
  annualCost: number;
  flags: SubscriptionFlag[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classifyFrequency(avgDays: number): SubscriptionFrequency | null {
  if (avgDays >= 5 && avgDays <= 10) return 'Weekly';
  if (avgDays >= 24 && avgDays <= 40) return 'Monthly';
  if (avgDays >= 330 && avgDays <= 400) return 'Yearly';
  return null;
}

export function detectSubscriptions(transactions: Transaction[], type: TransactionType = 'Expense'): DetectedSubscription[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.type !== type) continue;
    const key = t.merchant.trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const detected: DetectedSubscription[] = [];

  for (const txs of groups.values()) {
    if (txs.length < 2) continue;
    const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date));

    const amounts = sorted.map(t => t.amount);
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length;
    const maxAmount = Math.max(...amounts);
    const minAmount = Math.min(...amounts);
    if (avgAmount > 0 && (maxAmount - minAmount) / avgAmount > 0.35) continue; // too inconsistent to be a subscription

    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const days = (new Date(`${sorted[i].date}T12:00:00`).getTime() - new Date(`${sorted[i - 1].date}T12:00:00`).getTime()) / DAY_MS;
      intervals.push(days);
    }
    const avgInterval = intervals.reduce((s, d) => s + d, 0) / intervals.length;
    const frequency = classifyFrequency(avgInterval);
    if (!frequency) continue;

    const last = sorted[sorted.length - 1];
    const previous = sorted.length > 1 ? sorted[sorted.length - 2] : undefined;
    const monthlyEquivalent = frequency === 'Weekly' ? last.amount * (365 / 7 / 12)
      : frequency === 'Yearly' ? last.amount / 12
      : last.amount;

    const nextExpected = new Date(`${last.date}T12:00:00`);
    nextExpected.setDate(nextExpected.getDate() + Math.round(avgInterval));

    const flags: SubscriptionFlag[] = [];
    if (previous && last.amount > previous.amount * 1.1) flags.push('recently-increased');

    const daysSinceExpected = (Date.now() - nextExpected.getTime()) / DAY_MS;
    if (daysSinceExpected > avgInterval * 0.5) flags.push('lapsed');

    detected.push({
      merchant: last.merchant,
      categoryId: last.categoryId,
      frequency,
      lastAmount: last.amount,
      previousAmount: previous?.amount,
      occurrenceCount: sorted.length,
      lastDate: last.date,
      nextExpectedDate: nextExpected.toISOString().slice(0, 10),
      monthlyEquivalent: Math.round(monthlyEquivalent * 100) / 100,
      annualCost: Math.round(monthlyEquivalent * 12 * 100) / 100,
      flags
    });
  }

  if (detected.length) {
    const med = median(detected.map(d => d.monthlyEquivalent));
    const expensiveThreshold = Math.max(med * 1.5, 20);
    for (const d of detected) {
      if (d.monthlyEquivalent >= expensiveThreshold) d.flags.push('expensive');
    }
  }

  return detected.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
}

export function totalMonthlySubscriptionCost(subs: DetectedSubscription[]): number {
  return Math.round(subs.reduce((s, d) => s + d.monthlyEquivalent, 0) * 100) / 100;
}

export function totalAnnualSubscriptionCost(subs: DetectedSubscription[]): number {
  return Math.round(subs.reduce((s, d) => s + d.annualCost, 0) * 100) / 100;
}
