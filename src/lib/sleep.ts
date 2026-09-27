import type { SleepEntry } from '../types';

// Bed/wake times are "HH:mm" 24h strings — a wake time earlier than bed time means it
// crossed midnight, so that case wraps forward a full day rather than going negative.
export function computeSleepDuration(bedTime?: string, wakeTime?: string): number | undefined {
  if (!bedTime || !wakeTime) return undefined;
  const [bh, bm] = bedTime.split(':').map(Number);
  const [wh, wm] = wakeTime.split(':').map(Number);
  if ([bh, bm, wh, wm].some(n => Number.isNaN(n))) return undefined;
  let minutes = (wh * 60 + wm) - (bh * 60 + bm);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 10) / 10;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The most recent night up to today. Entries dated in the future (a typo, or logged ahead) never
// count as "last night" — the plain latest-date pick treated a Nov 7 entry as last night in
// September, and "Same as last night" copied it.
export function latestNight<T extends Pick<SleepEntry, 'date'>>(entries: T[], today = localToday()): T | undefined {
  return entries.filter(e => e.date <= today).sort((a, b) => b.date.localeCompare(a.date))[0];
}

function toMinutes(time: string): number | undefined {
  const [h, m] = time.split(':').map(Number);
  return Number.isNaN(h) || Number.isNaN(m) ? undefined : h * 60 + m;
}

function fromMinutes(mins: number): string {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// Bedtimes are measured from noon, so 00:30 counts as later than 22:45 (not 22 hours earlier) —
// otherwise one after-midnight night would drag the "average bedtime" to mid-afternoon.
function bedMinutes(time: string): number | undefined {
  const m = toMinutes(time);
  return m == null ? undefined : (m < 12 * 60 ? m + 1440 : m);
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const spread = (xs: number[]) => {
  const avg = mean(xs);
  return Math.sqrt(mean(xs.map(x => (x - avg) ** 2)));
};

type TimedNight = Pick<SleepEntry, 'date' | 'bedTime' | 'wakeTime'>;
function withBothTimes<T extends TimedNight>(entries: T[]): (T & { bedTime: string; wakeTime: string })[] {
  return entries.filter((e): e is T & { bedTime: string; wakeTime: string } => !!e.bedTime && !!e.wakeTime);
}

// Your usual bed and wake time — the median of the most recent `nights` nights that have both,
// so one late night doesn't move it. New nights start from these times.
export function usualSleepTimes(entries: TimedNight[], nights = 7): { bedTime: string; wakeTime: string } | undefined {
  const today = localToday();
  const recent = withBothTimes(entries).filter(e => e.date <= today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, nights);
  if (!recent.length) return undefined;
  const beds = recent.map(e => bedMinutes(e.bedTime)).filter((m): m is number => m != null);
  const wakes = recent.map(e => toMinutes(e.wakeTime)).filter((m): m is number => m != null);
  if (!beds.length || !wakes.length) return undefined;
  return { bedTime: fromMinutes(median(beds)), wakeTime: fromMinutes(median(wakes)) };
}

// How steady your schedule is: average bed and wake time and how far nights typically stray from
// them (standard deviation, in minutes). Needs 3+ nights with both times to say anything.
export function sleepConsistency(entries: TimedNight[]): { bedTime: string; bedSpreadMin: number; wakeTime: string; wakeSpreadMin: number; nights: number } | undefined {
  const timed = withBothTimes(entries);
  const beds = timed.map(e => bedMinutes(e.bedTime)).filter((m): m is number => m != null);
  const wakes = timed.map(e => toMinutes(e.wakeTime)).filter((m): m is number => m != null);
  if (beds.length < 3 || wakes.length < 3) return undefined;
  return {
    bedTime: fromMinutes(mean(beds)), bedSpreadMin: Math.round(spread(beds)),
    wakeTime: fromMinutes(mean(wakes)), wakeSpreadMin: Math.round(spread(wakes)),
    nights: Math.min(beds.length, wakes.length)
  };
}

// The one duration every sleep stat uses. With both bed and wake time logged, it's computed from
// them — what the table shows; only a night without times falls back to its stored hours. The
// stored field could drift from the times (the sample data's did: every night 10:45 pm → 6:30 am
// but 6.9–8.1h stored), which left the table saying 7.8h while Last Night, the average, sleep
// debt, the Overview and the insights all read the stored number.
export function sleepHours(entry: Pick<SleepEntry, 'bedTime' | 'wakeTime' | 'durationHours'>): number {
  return computeSleepDuration(entry.bedTime, entry.wakeTime) ?? entry.durationHours;
}
