export interface Holiday {
  date: string;
  title: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

// n = 1..5 for the nth weekday of the month, or -1 for the last one.
// weekday: 0 = Sunday .. 6 = Saturday. month: 1 = January .. 12 = December.
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(year, month - 1, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    return iso(year, month, 1 + offset + (n - 1) * 7);
  }
  const last = new Date(year, month, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return iso(year, month, last.getDate() - offset);
}

// Meeus/Jones/Butcher Gregorian algorithm — exact for any year, no lookup needed.
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

// Lunar/lunisolar observances shift every year and can't be derived from a formula —
// these are published dates for 2025-2027 (verified via web search). Extend this table
// for years beyond that range; dates depending on moon sighting (Ramadan, Eid) can
// shift by a day.
const VARIABLE_HOLIDAYS: { title: string; dates: Partial<Record<number, string>> }[] = [
  { title: 'Lunar New Year', dates: { 2025: '2025-01-29', 2026: '2026-02-17', 2027: '2027-02-06' } },
  { title: 'Ramadan begins', dates: { 2025: '2025-03-01', 2026: '2026-02-18', 2027: '2027-02-08' } },
  { title: 'Eid al-Fitr', dates: { 2025: '2025-03-30', 2026: '2026-03-20', 2027: '2027-03-21' } },
  { title: 'Passover begins', dates: { 2025: '2025-04-12', 2026: '2026-04-02', 2027: '2027-04-21' } },
  { title: 'Rosh Hashanah', dates: { 2025: '2025-09-22', 2026: '2026-09-11', 2027: '2027-10-01' } },
  { title: 'Yom Kippur', dates: { 2025: '2025-10-02', 2026: '2026-09-21', 2027: '2027-10-11' } },
  { title: 'Diwali', dates: { 2025: '2025-10-20', 2026: '2026-11-08', 2027: '2027-10-29' } },
  { title: 'Hanukkah begins', dates: { 2025: '2025-12-14', 2026: '2026-12-04', 2027: '2027-12-24' } }
];

// Verified equinox/solstice dates (UTC). These shift by a day or two year to year —
// extend this table as new years are needed.
const SEASONAL: Partial<Record<number, [string, string, string, string]>> = {
  2025: ['2025-03-20', '2025-06-21', '2025-09-22', '2025-12-21'],
  2026: ['2026-03-20', '2026-06-21', '2026-09-22', '2026-12-21'],
  2027: ['2027-03-20', '2027-06-21', '2027-09-23', '2027-12-21']
};
const SEASONAL_LABELS = ['Spring Equinox', 'Summer Solstice', 'Autumn Equinox', 'Winter Solstice'];

export function getHolidays(year: number): Holiday[] {
  const list: Holiday[] = [
    { date: iso(year, 1, 1), title: "New Year's Day" },
    { date: nthWeekday(year, 1, 1, 3), title: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(year, 2, 1, 3), title: "Presidents' Day" },
    { date: nthWeekday(year, 5, 1, -1), title: 'Memorial Day' },
    { date: iso(year, 6, 19), title: 'Juneteenth National Independence Day' },
    { date: iso(year, 7, 4), title: 'Independence Day' },
    { date: nthWeekday(year, 9, 1, 1), title: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), title: "Columbus Day / Indigenous Peoples' Day" },
    { date: iso(year, 11, 11), title: 'Veterans Day' },
    { date: nthWeekday(year, 11, 4, 4), title: 'Thanksgiving Day' },
    { date: iso(year, 12, 25), title: 'Christmas Day' },
    { date: iso(year, 2, 14), title: "Valentine's Day" },
    { date: iso(year, 3, 17), title: "St. Patrick's Day" },
    { date: easterSunday(year), title: 'Easter Sunday' },
    { date: nthWeekday(year, 5, 0, 2), title: "Mother's Day" },
    { date: nthWeekday(year, 6, 0, 3), title: "Father's Day" },
    { date: iso(year, 10, 31), title: 'Halloween' },
    { date: iso(year, 11, 1), title: 'Día de los Muertos (Nov 1–2)' },
    { date: iso(year, 12, 26), title: 'Kwanzaa (Dec 26 – Jan 1)' }
  ];

  VARIABLE_HOLIDAYS.forEach(h => {
    const date = h.dates[year];
    if (date) list.push({ date, title: h.title });
  });

  const seasonal = SEASONAL[year];
  if (seasonal) seasonal.forEach((date, i) => list.push({ date, title: SEASONAL_LABELS[i] }));

  return list;
}
