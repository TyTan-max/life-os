import type { SleepEntry } from '../types';

// Bed/wake times are "HH:mm" 24h strings — a wake time earlier than bed time means it
// crossed midnight, so that case wraps forward a full day rather than going negative.
export function computeSleepMinutes(bedTime?: string, wakeTime?: string): number | undefined {
  if (!bedTime || !wakeTime) return undefined;
  const [bh, bm] = bedTime.split(':').map(Number);
  const [wh, wm] = wakeTime.split(':').map(Number);
  if ([bh, bm, wh, wm].some(n => Number.isNaN(n))) return undefined;
  let minutes = (wh * 60 + wm) - (bh * 60 + bm);
  if (minutes <= 0) minutes += 24 * 60;
  return minutes;
}

// Hours to one decimal — fine for a night ("5.5h"), too coarse for a nap or an awake gap
// (15 min = 0.25h rounds to 0.3h = 18 min), which use the exact minutes instead.
export function computeSleepDuration(bedTime?: string, wakeTime?: string): number | undefined {
  const minutes = computeSleepMinutes(bedTime, wakeTime);
  return minutes == null ? undefined : Math.round((minutes / 60) * 10) / 10;
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

/** The same duration to the exact minute. */
export function sleepMinutes(entry: Pick<SleepEntry, 'bedTime' | 'wakeTime' | 'durationHours'>): number {
  return computeSleepMinutes(entry.bedTime, entry.wakeTime) ?? Math.round(entry.durationHours * 60);
}

// ---- Nights and naps ----------------------------------------------------------------------
// A night can be logged in pieces (asleep, awake a while, back asleep): every non-nap entry on
// the same date is one night. Its sleep is the pieces added up; it runs from the first bedtime to
// the last wake-up, and the gap between pieces is time awake. Naps are logged separately: they
// never count toward a night's hours, but they do pay back part of the sleep debt.

export function isNap(e: Pick<SleepEntry, 'nap'>): boolean {
  return e.nap === true;
}

// Daytime starts (10 am – 7 pm) are suggested as naps until you say otherwise.
export function looksLikeNap(bedTime?: string): boolean {
  const m = bedTime ? toMinutes(bedTime) : undefined;
  return m != null && m >= 10 * 60 && m < 19 * 60;
}

export interface SleepNight {
  date: string;
  /** Night sleep only: every piece added together. */
  hours: number;
  /** First time to bed and last wake-up (the night's span). */
  bedTime?: string;
  wakeTime?: string;
  /** Time awake between pieces. */
  awakeHours: number;
  pieces: SleepEntry[];
  quality?: number;
  napHours: number;
  naps: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function nightsOf(entries: SleepEntry[]): SleepNight[] {
  const byDate = new Map<string, SleepEntry[]>();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date)!.push(e);
  }
  const nights: SleepNight[] = [];
  for (const [date, list] of byDate) {
    const pieces = list.filter(e => !isNap(e))
      .sort((a, b) => (a.bedTime ? bedMinutes(a.bedTime) ?? 0 : 1e9) - (b.bedTime ? bedMinutes(b.bedTime) ?? 0 : 1e9));
    if (!pieces.length) continue;
    const naps = list.filter(isNap);
    const minutes = pieces.reduce((s, p) => s + sleepMinutes(p), 0);
    const hours = round1(minutes / 60);
    const bedTime = pieces[0].bedTime;
    const wakeTime = pieces[pieces.length - 1].wakeTime;
    const span = pieces.length > 1 && pieces.every(p => p.bedTime && p.wakeTime) ? computeSleepMinutes(bedTime, wakeTime) : undefined;
    const rated = pieces.filter(p => p.quality != null);
    nights.push({
      date, hours, bedTime, wakeTime, pieces,
      awakeHours: span != null ? Math.max(0, span - minutes) / 60 : 0,
      quality: rated.length ? Math.round(mean(rated.map(p => p.quality!))) : undefined,
      napHours: naps.reduce((s, n) => s + sleepMinutes(n), 0) / 60,
      naps: naps.length
    });
  }
  return nights.sort((a, b) => a.date.localeCompare(b.date));
}

/** The most recent night up to today (not a nap). */
export function lastNightOf(entries: SleepEntry[], today = localToday()): SleepNight | undefined {
  const nights = nightsOf(entries.filter(e => e.date <= today));
  return nights[nights.length - 1];
}

/** Hours short of target over these nights, less any naps in the same days. */
export function sleepDebtOf(entries: SleepEntry[], target: number): number | undefined {
  const nights = nightsOf(entries);
  if (!nights.length) return undefined;
  const slept = nights.reduce((s, n) => s + n.hours, 0);
  const napped = entries.filter(isNap).reduce((s, n) => s + sleepMinutes(n), 0) / 60;
  return Math.max(0, round1(target * nights.length - slept - napped));
}

/** "2h 15m" / "45m" */
export function formatHours(h: number): string {
  const mins = Math.round(h * 60);
  const hh = Math.floor(mins / 60); const mm = mins % 60;
  return hh ? `${hh}h${mm ? ` ${mm}m` : ''}` : `${mm}m`;
}
