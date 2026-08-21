import type { Contact, ContactInteraction, ContactTier } from '../types';
import { CONTACT_TIER_DEFAULT_DAYS } from '../types';

export type ContactStatus = 'Never contacted' | 'Overdue' | 'Due soon' | 'Warm';

// A contact's own frequencyDays overrides its tier's default — lets one "Close" friend get a
// tighter cadence than the rest of that tier without inventing a whole new tier for them.
export function frequencyDaysFor(contact: Contact): number {
  return contact.frequencyDays ?? CONTACT_TIER_DEFAULT_DAYS[contact.tier];
}

export function lastContactedDate(contactId: string, interactions: ContactInteraction[]): string | undefined {
  let latest: string | undefined;
  for (const i of interactions) {
    if (i.contactId !== contactId) continue;
    if (!latest || i.date > latest) latest = i.date;
  }
  return latest;
}

// Whole-day difference between two "YYYY-MM-DD" dates, ignoring time-of-day entirely so DST
// transitions and the caller's local time never shift the count by a day.
export function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

// The core cadence formula: Overdue once you've gone past the full cadence window, Due soon
// once you're 75%+ of the way through it (a heads-up before it lapses), otherwise Warm. A
// contact with no interactions logged yet is always "Never contacted" — the highest-priority
// bucket, since it's not just stale, it's never been started.
export function contactStatus(contact: Contact, lastDate: string | undefined, todayIso: string): ContactStatus {
  if (!lastDate) return 'Never contacted';
  const days = daysBetween(lastDate, todayIso);
  const freq = frequencyDaysFor(contact);
  if (days > freq) return 'Overdue';
  if (days >= freq * 0.75) return 'Due soon';
  return 'Warm';
}

export const STATUS_PRIORITY: Record<ContactStatus, number> = {
  'Never contacted': 0,
  'Overdue': 1,
  'Due soon': 2,
  'Warm': 3
};

export const STATUS_BADGE_TONE: Record<ContactStatus, string> = {
  'Never contacted': 'danger',
  'Overdue': 'danger',
  'Due soon': 'warning',
  'Warm': 'success'
};

const TIER_ORDER: Record<ContactTier, number> = { 'Inner Circle': 0, 'Close': 1, 'Extended': 2 };
export function tierRank(tier: ContactTier): number {
  return TIER_ORDER[tier];
}

// Birthdays are stored as "MM-DD" (no year) — this finds how many days until the next
// occurrence, wrapping to next year once this year's date has already passed.
export function daysUntilNextBirthday(birthdayMMDD: string, todayIso: string): number | undefined {
  const match = birthdayMMDD.match(/^(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const [, mm, dd] = match;
  const today = new Date(`${todayIso}T00:00:00`);
  const year = today.getFullYear();
  let next = new Date(`${year}-${mm}-${dd}T00:00:00`);
  if (next.getTime() < today.getTime()) next = new Date(`${year + 1}-${mm}-${dd}T00:00:00`);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

// Age is purely a display nicety — most contacts won't have a birth year on file, so this
// returns undefined rather than guessing, and the UI just omits the age line in that case.
export function ageFromBirthYear(birthYear: number | undefined, birthdayMMDD: string | undefined, todayIso: string): number | undefined {
  if (!birthYear || !birthdayMMDD?.match(/^\d{2}-\d{2}$/)) return undefined;
  const [mm, dd] = birthdayMMDD.split('-').map(Number);
  const today = new Date(`${todayIso}T00:00:00`);
  const hadBirthdayThisYear = today.getMonth() + 1 > mm || (today.getMonth() + 1 === mm && today.getDate() >= dd);
  return today.getFullYear() - birthYear - (hadBirthdayThisYear ? 0 : 1);
}
