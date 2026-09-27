import type { AppData, Medication } from '../types';
import { doseStatus, scheduledTimes } from './medications';

// Local date, not `.toISOString()` — that converts to UTC, which reads as "tomorrow" late
// enough in the day for anyone west of UTC.
function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const STREAK_MILESTONES = [7, 30, 90, 180, 365];

export function nextMilestone(length: number): number | undefined {
  return STREAK_MILESTONES.find(m => m > length);
}

export function isMilestone(length: number): boolean {
  return length > 0 && STREAK_MILESTONES.includes(length);
}

/**
 * Consecutive days, walking back from today, where every scheduled dose across currently-active
 * medications was confirmed taken (not skipped, not missed). A day before a medication existed
 * (createdAt) has no requirement and doesn't break the chain. An unresolved dose today (not yet
 * marked either way) doesn't break the streak — only a day with an actual skip does; days with
 * nothing marked yet just aren't counted until they're resolved one way or the other.
 */
export function medicationAdherenceStreak(medications: Medication[], asOf: string = iso(0)): number {
  const tracked = medications.filter(m => m.active);
  if (!tracked.length) return 0;
  const earliest = tracked.reduce((min, m) => {
    const d = m.createdAt.slice(0, 10);
    return d < min ? d : min;
  }, asOf);

  // Only doses actually scheduled that day count (weekly medications on their weekday; as-needed
  // never) — see lib/medications.ts. Before, a weekly or as-needed medication made every day
  // "incomplete" and the streak could never grow.
  const dayStatus = (date: string): 'complete' | 'broken' | 'none' => {
    let scheduled = 0;
    let anySkipped = false;
    let allTaken = true;
    for (const m of tracked) {
      for (const t of scheduledTimes(m, date)) {
        scheduled += 1;
        const status = doseStatus(m, date, t);
        if (status === 'skipped') anySkipped = true;
        if (status !== 'taken') allTaken = false;
      }
    }
    if (!scheduled) return 'none';
    if (anySkipped) return 'broken';
    return allTaken ? 'complete' : 'none';
  };

  if (dayStatus(asOf) === 'broken') return 0;

  let streak = 0;
  let cursor = dayStatus(asOf) === 'complete' ? 0 : -1;
  while (iso(cursor) >= earliest) {
    const status = dayStatus(iso(cursor));
    if (status === 'complete') { streak += 1; cursor -= 1; continue; }
    if (status === 'none') { cursor -= 1; continue; }
    break;
  }
  return streak;
}

export interface LoggingStreakResult {
  length: number;
  freezeUsed: boolean;
}

/**
 * Consecutive days with any engagement across the four pillars — a workout, a weigh-in, a
 * sleep entry, or a confirmed medication dose. One missed day is forgiven (a "streak freeze")
 * so a single off day doesn't zero out weeks of consistency; a second consecutive gap ends it.
 */
export function loggingStreak(data: AppData, asOf: string = iso(0)): LoggingStreakResult {
  const isLogged = (date: string) =>
    data.workouts.some(w => w.date === date) ||
    data.weightEntries.some(e => e.date === date) ||
    data.sleepEntries.some(e => e.date === date) ||
    data.medications.some(m => m.doseLog.some(d => d.date === date && d.takenAt && !d.skipped));

  let cursor = isLogged(asOf) ? 0 : -1;
  if (!isLogged(iso(cursor))) return { length: 0, freezeUsed: false };

  let length = 0;
  let freezeUsed = false;
  while (true) {
    const date = iso(cursor);
    if (isLogged(date)) { length += 1; cursor -= 1; continue; }
    if (!freezeUsed) { freezeUsed = true; cursor -= 1; continue; }
    break;
  }
  return { length, freezeUsed };
}
