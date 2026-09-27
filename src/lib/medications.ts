import type { Medication, MedicationDose, MedicationRepeat } from '../types';

// When each medication is due, what counts as taken / skipped / missed, and how long a supply
// lasts. One place for the rules, so the Medication tab, the Health Overview, the streak and the
// insights all agree.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function localIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localIso(d);
}

function nowHHmm(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// A medication counts from the day it was added — days before that are never "missed".
export function medStartDate(med: Medication): string {
  return med.createdAt ? localIso(new Date(med.createdAt)) : '0000-01-01';
}

export function isAsNeeded(med: Medication): boolean {
  return med.frequency === 'As Needed';
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86400000);
}

// Which days a medication repeats on. Older 'Weekly' records read as Specific days on their weekday.
export function repeatMode(med: Medication): MedicationRepeat {
  if (med.frequency === 'Weekly') return 'Specific days';
  return med.repeat ?? 'Every day';
}

export function scheduleWeekdays(med: Medication): string[] {
  if (med.frequency === 'Weekly') return [med.weeklyDay ?? 'Monday'];
  return med.weekdays?.length ? WEEKDAYS.filter(d => med.weekdays!.includes(d)) : WEEKDAYS;
}

// Short description of the repeat pattern, e.g. "Mon, Wed, Fri" or "every other day".
export function repeatLabel(med: Medication): string {
  const mode = repeatMode(med);
  if (mode === 'Every other day') return 'every other day';
  if (mode === 'Specific days') {
    const days = scheduleWeekdays(med);
    if (days.length === 7) return 'every day';
    if (days.length === 5 && !days.includes('Saturday') && !days.includes('Sunday')) return 'weekdays';
    return days.map(d => d.slice(0, 3)).join(', ');
  }
  return 'every day';
}

// Whether the repeat pattern includes this date (ignoring days marked "no meds needed").
export function isScheduledDay(med: Medication, date: string): boolean {
  const mode = repeatMode(med);
  if (mode === 'Specific days') return scheduleWeekdays(med).includes(WEEKDAYS[new Date(`${date}T12:00:00`).getDay()]);
  if (mode === 'Every other day') return Math.abs(daysBetween(med.repeatFrom || medStartDate(med), date)) % 2 === 0;
  return true;
}

// A day marked "no meds needed" — nothing is due, so nothing counts as missed.
export function isDayOff(med: Medication, date: string): boolean {
  return Boolean(med.daysOff?.includes(date));
}

export function withDayOff(med: Medication, date: string, off: boolean): Medication {
  const rest = (med.daysOff ?? []).filter(d => d !== date);
  return { ...med, daysOff: off ? [...rest, date].sort() : rest };
}

// The scheduled dose times on a date: only on days the repeat pattern includes, never on a day
// marked "no meds needed", and never for as-needed medications (they have no schedule).
export function scheduledTimes(med: Medication, date: string): string[] {
  if (!med.active || isAsNeeded(med) || date < medStartDate(med)) return [];
  if (!isScheduledDay(med, date) || isDayOff(med, date)) return [];
  return med.times.slice().sort();
}

export function doseEntry(med: Medication, date: string, time: string): MedicationDose | undefined {
  return med.doseLog.find(d => d.date === date && d.time === time);
}

export type DoseStatus = 'taken' | 'skipped' | 'pending';

export function doseStatus(med: Medication, date: string, time: string): DoseStatus {
  const entry = doseEntry(med, date, time);
  if (entry?.skipped) return 'skipped';
  if (entry?.takenAt) return 'taken';
  return 'pending';
}

// A scheduled dose is "due" once its time has passed — any time on an earlier day, or earlier
// today. Due + never marked = missed.
export function isDue(date: string, time: string, now = new Date()): boolean {
  const today = localIso(now);
  return date < today || (date === today && time <= nowHHmm(now));
}

// Minutes a pending dose is overdue by (today only), for "due 3h ago".
export function minutesOverdue(date: string, time: string, now = new Date()): number {
  if (date !== localIso(now)) return 0;
  const [h, m] = time.split(':').map(Number);
  return Math.max(0, now.getHours() * 60 + now.getMinutes() - (h * 60 + m));
}

export interface AdherenceStats { due: number; taken: number; skipped: number; missed: number; pct: number | undefined }

// Adherence over a date range: taken ÷ every scheduled dose that has come due. Unmarked due doses
// count as missed — the old figure only counted doses you'd marked, so forgetting to log kept it
// at 100%. As-needed medications have no schedule, so they're left out.
export function adherenceStats(meds: Medication[], start: string, end: string, now = new Date()): AdherenceStats {
  const stats = { due: 0, taken: 0, skipped: 0, missed: 0 };
  const last = end < localIso(now) ? end : localIso(now);
  for (let date = start; date <= last; date = shiftIsoDate(date, 1)) {
    for (const med of meds) {
      for (const time of scheduledTimes(med, date)) {
        if (!isDue(date, time, now)) continue;
        stats.due += 1;
        const status = doseStatus(med, date, time);
        if (status === 'taken') stats.taken += 1;
        else if (status === 'skipped') stats.skipped += 1;
        else stats.missed += 1;
      }
    }
  }
  return { ...stats, pct: stats.due ? Math.round((stats.taken / stats.due) * 100) : undefined };
}

export type DayStatus = 'complete' | 'partial' | 'missed' | 'upcoming' | 'off' | 'none' | 'future';

// One day's summary for the history calendar: every due dose taken (complete), some (partial),
// none (missed), nothing due yet today (upcoming), marked "no meds needed" (off), nothing
// scheduled (none), or in the future.
export function dayStatus(meds: Medication[], date: string, now = new Date()): DayStatus {
  const off = meds.some(m => m.active && isDayOff(m, date));
  if (date > localIso(now)) return off ? 'off' : 'future';
  let scheduled = 0;
  let due = 0;
  let taken = 0;
  for (const med of meds) {
    for (const time of scheduledTimes(med, date)) {
      scheduled += 1;
      if (doseStatus(med, date, time) === 'taken') taken += 1;
      if (isDue(date, time, now)) due += 1;
    }
  }
  if (!scheduled) return off ? 'off' : 'none';
  if (taken >= scheduled) return 'complete';
  // Today, with nothing overdue yet: still on track.
  if (date === localIso(now) && taken >= due) return 'upcoming';
  return taken > 0 ? 'partial' : 'missed';
}

// Average doses per day — from the schedule, or for as-needed from actual use over 30 days.
export function dosesPerDay(med: Medication, now = new Date()): number {
  if (isAsNeeded(med)) {
    const since = shiftIsoDate(localIso(now), -30);
    return med.doseLog.filter(d => d.takenAt && !d.skipped && d.date > since).length / 30;
  }
  const mode = repeatMode(med);
  if (mode === 'Specific days') return (med.times.length * scheduleWeekdays(med).length) / 7;
  if (mode === 'Every other day') return med.times.length / 2;
  return med.times.length;
}

// How long the supply lasts at the current rate, and the day it runs out.
export function supplyEstimate(med: Medication, now = new Date()): { daysLeft: number; runsOut: string } | undefined {
  if (med.pillsRemaining == null) return undefined;
  const perDay = dosesPerDay(med, now) * (med.pillsPerDose ?? 1);
  if (perDay <= 0) return undefined;
  const daysLeft = Math.floor(med.pillsRemaining / perDay);
  return { daysLeft, runsOut: shiftIsoDate(localIso(now), daysLeft) };
}

// Marks a scheduled dose taken / skipped / pending, keeping pillsRemaining in step (by pillsPerDose).
// A dose back-filled on an earlier day is stamped at its scheduled time rather than "now".
export function withDoseStatus(med: Medication, date: string, time: string, next: DoseStatus, now = new Date()): Medication {
  const existing = doseEntry(med, date, time);
  const wasTaken = Boolean(existing?.takenAt) && !existing?.skipped;
  const doseLog = med.doseLog.filter(d => !(d.date === date && d.time === time));
  const takenAt = date === localIso(now) ? now.toISOString() : new Date(`${date}T${time}:00`).toISOString();
  if (next === 'taken') doseLog.push({ date, time, takenAt });
  else if (next === 'skipped') doseLog.push({ date, time, skipped: true });
  return { ...med, doseLog, pillsRemaining: adjustPills(med, wasTaken, next === 'taken') };
}

function adjustPills(med: Medication, wasTaken: boolean, nowTaken: boolean): number | undefined {
  if (med.pillsRemaining == null) return undefined;
  const per = med.pillsPerDose ?? 1;
  if (nowTaken && !wasTaken) return Math.max(0, med.pillsRemaining - per);
  if (!nowTaken && wasTaken) return med.pillsRemaining + per;
  return med.pillsRemaining;
}

// As-needed: log one dose at a time (now, or midday for an earlier day), or remove a logged one.
export function withAsNeededDose(med: Medication, date: string, now = new Date()): Medication {
  let time = date === localIso(now) ? nowHHmm(now) : '12:00';
  while (doseEntry(med, date, time)) {
    const [h, m] = time.split(':').map(Number);
    const mins = h * 60 + m + 1;
    time = `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }
  const takenAt = date === localIso(now) ? now.toISOString() : new Date(`${date}T${time}:00`).toISOString();
  return { ...med, doseLog: [...med.doseLog, { date, time, takenAt }], pillsRemaining: adjustPills(med, false, true) };
}

export function withoutAsNeededDose(med: Medication, date: string, time: string): Medication {
  const existed = doseEntry(med, date, time);
  return {
    ...med,
    doseLog: med.doseLog.filter(d => !(d.date === date && d.time === time)),
    pillsRemaining: existed?.takenAt && !existed.skipped ? adjustPills(med, true, false) : med.pillsRemaining
  };
}

export function takenAsNeeded(med: Medication, date: string): MedicationDose[] {
  return med.doseLog.filter(d => d.date === date && d.takenAt && !d.skipped).sort((a, b) => a.time.localeCompare(b.time));
}

// Default dose times for a frequency, used when the frequency changes in the form.
export function defaultTimesFor(frequency: string, current: string[]): string[] {
  const n = frequency === 'Twice Daily' ? 2 : frequency === 'Three Times Daily' ? 3 : frequency === 'As Needed' ? 0 : 1;
  if (n === 0) return [];
  if (current.length === n) return current;
  return n === 1 ? [current[0] ?? '08:00'] : n === 2 ? ['08:00', '20:00'] : ['08:00', '14:00', '20:00'];
}
