import type { Contact, ContactInteraction, ContactTier } from '../types';
import { CONTACT_TIER_DEFAULT_DAYS } from '../types';

// 'New': added recently, no interaction yet, and its first reach-out isn't due yet.
// 'Off': reach-out reminders are off for this contact — just in the address book.
export type ContactStatus = 'Never contacted' | 'Overdue' | 'Due soon' | 'Warm' | 'New' | 'Off';

// Relationships worth a regular nudge. Everyone else (colleagues, acquaintances, service
// providers…) defaults to reminders off; either can be flipped per contact.
export const REACH_OUT_DEFAULT_CATEGORIES = new Set<string>([
  'Family', 'Friends', 'Relatives', 'Clients', 'Mentors & Mentees', 'VIP / High-Value Contacts'
]);

export function remindersOn(contact: Contact): boolean {
  return contact.reachOut ?? REACH_OUT_DEFAULT_CATEGORIES.has(contact.category ?? '');
}

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

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// When the next reach-out is due: one cadence after the last interaction — or, for someone
// never contacted, one cadence after they were added (so a freshly added contact isn't overdue
// on day one). A snooze pushes it out to the snooze date.
export function nextReachOutDate(contact: Contact, lastDate: string | undefined): string {
  const anchor = lastDate ?? (contact.createdAt ? contact.createdAt.slice(0, 10) : undefined) ?? addDaysIso(new Date().toISOString().slice(0, 10), 0);
  const due = addDaysIso(anchor, frequencyDaysFor(contact));
  return contact.snoozedUntil && contact.snoozedUntil > due ? contact.snoozedUntil : due;
}

// Overdue once the due date has passed ("Never contacted" if nothing was ever logged), Due soon
// in the last quarter of the cadence window, otherwise Warm — or New for someone not yet reached.
export function contactStatus(contact: Contact, lastDate: string | undefined, todayIso: string): ContactStatus {
  if (!remindersOn(contact)) return 'Off';
  const daysLeft = daysBetween(todayIso, nextReachOutDate(contact, lastDate));
  if (daysLeft < 0) return lastDate ? 'Overdue' : 'Never contacted';
  if (daysLeft <= frequencyDaysFor(contact) * 0.25) return 'Due soon';
  return lastDate ? 'Warm' : 'New';
}

export const STATUS_PRIORITY: Record<ContactStatus, number> = {
  'Never contacted': 0,
  'Overdue': 1,
  'Due soon': 2,
  'Warm': 3,
  'New': 4,
  'Off': 5
};

export const STATUS_BADGE_TONE: Record<ContactStatus, string> = {
  'Never contacted': 'danger',
  'Overdue': 'danger',
  'Due soon': 'warning',
  'Warm': 'success',
  'New': 'default',
  'Off': 'default'
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
