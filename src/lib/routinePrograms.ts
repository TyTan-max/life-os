import type { ProgramAssignment, WorkoutRoutine } from '../types';

// Which workout program is in effect on which date. Pure date logic, kept out of the component so
// it can be tested on its own.

// One colour per program, used for its dots on the workout date picker and its key in the program
// menu. Theme tokens where the app has one that reads well in both themes; pink and lime are
// fixed because there's no token for them (indigo was left out — the app's indigo and blue are
// nearly identical in dark mode, and red reads as a warning).
export const PROGRAM_COLORS = [
  'var(--teal)', 'var(--amber)', 'var(--blue)', 'var(--purple)',
  'var(--green)', 'var(--ember)', '#e0609c', '#84cc16'
];

// A program's colour is fixed by creation order, so it never changes as programs are renamed,
// switched or viewed; the ninth program onward reuses the palette from the start.
export function programColor(routines: WorkoutRoutine[], routineId: string): string {
  const ordered = routines.slice().sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  const i = Math.max(0, ordered.findIndex(r => r.id === routineId));
  return PROGRAM_COLORS[i % PROGRAM_COLORS.length];
}

function shiftDay(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Which program was in effect for a given date — the latest assignment on or before it. Dates
// before the first-ever assignment (or before any switch has ever happened) resolve to
// undefined, meaning "no opinion, leave whatever's currently showing alone" rather than
// guessing at a program to jump to.
export function resolveProgramForDate(assignments: ProgramAssignment[] | undefined, date: string): string | undefined {
  if (!assignments || assignments.length === 0) return undefined;
  let best: ProgramAssignment | undefined;
  for (const a of assignments) {
    if (a.effectiveFrom <= date) best = a;
    else break;
  }
  return best?.routineId;
}

// Records that `routineId` is the program in effect from `date` forward, coalescing into an
// existing same-date assignment rather than branching a duplicate for repeated switches on
// one date.
export function withProgramAssignment(assignments: ProgramAssignment[], date: string, routineId: string): ProgramAssignment[] {
  const idx = assignments.findIndex(a => a.effectiveFrom === date);
  if (idx >= 0) {
    const updated = assignments.slice();
    updated[idx] = { ...updated[idx], routineId };
    return updated;
  }
  return [...assignments, { effectiveFrom: date, routineId }].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

// The dates a program counts as logged — its explicit Logged toggles once the user has ever used
// them, otherwise any date it has set weights for (same rule the Logged badge uses).
export function loggedDatesOf(routine: WorkoutRoutine): string[] {
  return routine.loggedDates ?? [...new Set(routine.exerciseLogs.map(l => l.date))];
}

// Assigns `routineId` from `date` forward — except for later dates already logged under another
// program, which stay pinned to the program they were logged with. Without this, switching
// programs on Sep 25 re-pointed an already-logged Sep 27 at the new program, and that day's
// workout seemed to vanish (it was still stored, just no longer shown). Each such date gets its
// own assignment back to its program, and the day after resumes the new program (unless an
// assignment already starts there).
export function assignProgramFrom(
  assignments: ProgramAssignment[], date: string, routineId: string, routines: WorkoutRoutine[]
): ProgramAssignment[] {
  let next = withProgramAssignment(assignments, date, routineId);
  const laterLogged = [...new Set(routines.flatMap(loggedDatesOf))].filter(d => d > date).sort();
  for (const d of laterLogged) {
    const owners = routines.filter(r => loggedDatesOf(r).includes(d)).map(r => r.id);
    const nowShows = resolveProgramForDate(next, d);
    if (!owners.length || (nowShows && owners.includes(nowShows))) continue;
    const before = resolveProgramForDate(assignments, d);
    const keep = before && owners.includes(before) ? before : owners[0];
    const after = shiftDay(d, 1);
    const resumeWith = resolveProgramForDate(next, after);
    next = withProgramAssignment(next, d, keep);
    if (resumeWith && !next.some(a => a.effectiveFrom === after)) next = withProgramAssignment(next, after, resumeWith);
  }
  return next;
}
