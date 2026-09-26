export type HealthPeriod = 'Day' | 'Week' | 'Month' | 'Year';
export const HEALTH_PERIODS: HealthPeriod[] = ['Day', 'Week', 'Month', 'Year'];

export interface DateRange { start: string; end: string; }

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfWeek(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  s.setDate(s.getDate() - s.getDay());
  return s;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function periodRangeFor(period: HealthPeriod, anchor: Date): DateRange {
  if (period === 'Day') {
    const s = toIsoDate(anchor);
    return { start: s, end: s };
  }
  if (period === 'Week') {
    const start = startOfWeek(anchor);
    return { start: toIsoDate(start), end: toIsoDate(addDays(start, 6)) };
  }
  if (period === 'Month') {
    const ym = `${anchor.getFullYear()}-${pad2(anchor.getMonth() + 1)}`;
    return { start: `${ym}-01`, end: `${ym}-31` };
  }
  const y = anchor.getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

export function isCurrentPeriod(period: HealthPeriod, anchor: Date): boolean {
  const a = periodRangeFor(period, anchor);
  const b = periodRangeFor(period, new Date());
  return a.start === b.start && a.end === b.end;
}

export function formatPeriodLabel(period: HealthPeriod, anchor: Date): string {
  // The year only appears when it isn't this year: "Fri, Sep 25, 2026" wrapped the date control
  // onto two lines on a phone and made every "… {periodLabel}" caption read long.
  const thisYear = new Date().getFullYear();
  if (period === 'Day') {
    return anchor.toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      ...(anchor.getFullYear() === thisYear ? {} : { year: 'numeric' })
    });
  }
  if (period === 'Week') {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = end.toLocaleDateString('en-US', sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return `${startLabel} – ${endLabel}${end.getFullYear() === thisYear ? '' : `, ${end.getFullYear()}`}`;
  }
  if (period === 'Month') return anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return String(anchor.getFullYear());
}

// A sleep entry is dated by the morning you woke up, so "last night" is an entry dated today —
// or yesterday, if today's hasn't been logged yet. Anything older says when it was.
export function sleepRecencyLabel(dateIso: string | undefined): string {
  if (!dateIso) return 'no nights logged yet';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dateIso === toIsoDate(today) || dateIso === toIsoDate(yesterday)) return 'last night';
  const d = new Date(`${dateIso}T12:00:00`);
  return `logged ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) })}`;
}

export function shiftAnchor(period: HealthPeriod, anchor: Date, delta: number): Date {
  const d = new Date(anchor);
  if (period === 'Day') d.setDate(d.getDate() + delta);
  else if (period === 'Week') d.setDate(d.getDate() + delta * 7);
  else if (period === 'Month') d.setMonth(d.getMonth() + delta);
  else d.setFullYear(d.getFullYear() + delta);
  return d;
}

export function inRange(date: string, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}
