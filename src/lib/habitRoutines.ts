import type { Habit, HabitRoutine } from '../types';

// Shared between the Habits page (where the routine is picked) and the Dashboard (which needs to
// know the same choice to show only that routine's habits) — one key, one fallback rule, so the
// two views can never disagree about which routine is "current."
const ROUTINE_FILTER_KEY = 'habits-routine-filter';

export function loadSavedRoutineFilter(): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(ROUTINE_FILTER_KEY) ?? '';
}

export function saveRoutineFilter(id: string): void {
  window.localStorage.setItem(ROUTINE_FILTER_KEY, id);
}

// There's no untagged fallback bucket: once routines exist, a habit needs a tag to appear in a
// routine-scoped view.
export function matchesRoutineFilter(habit: Pick<Habit, 'routineIds'>, routineFilter: string): boolean {
  return (habit.routineIds ?? []).includes(routineFilter);
}

export function sortRoutines(routines: HabitRoutine[]): HabitRoutine[] {
  return routines.slice().sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name));
}

// Falls back to the first routine if nothing (valid) is selected yet — e.g. first load, or the
// previously-selected routine was just deleted.
export function getEffectiveRoutineFilter(routines: HabitRoutine[], saved: string): string {
  return routines.some(r => r.id === saved) ? saved : (routines[0]?.id ?? '');
}
