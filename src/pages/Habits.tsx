import { useMemo, useRef, useState } from 'react';
import {
  Calendar, Check, ChevronLeft, ChevronRight, CircleSlash, Clock, GripVertical, Pencil, Plus, Quote as QuoteIcon, RotateCcw, Settings2, Trash2, X
} from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { Habit, HabitFrequency, HabitRoutine, RoutineDateAssignment } from '../types';
import { Card, Modal } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { TimeWheelPicker } from '../components/TimeWheelPicker';
import { getSessionQuote } from '../lib/quotes';

const FREQUENCIES: HabitFrequency[] = ['Daily', 'Weekdays', 'Weekly', 'Custom'];
const DAY_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ROUTINE_FILTER_KEY = 'habits-routine-filter';
// Cycled through by routine list position so the calendar pill colors stay consistent
// without needing a color picker in the UI.
const ROUTINE_COLORS = ['#4f5bd5', '#0f9488', '#c47a05', '#e5484d', '#7c4fd6', '#2563eb', '#1a8a53', '#d6409f'];

function presetForFrequency(freq: HabitFrequency, current: number[]): number[] {
  if (freq === 'Weekdays') return [1, 2, 3, 4, 5];
  if (freq === 'Weekly') return [0];
  if (freq === 'Daily') return [0, 1, 2, 3, 4, 5, 6];
  return current;
}
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

interface CalendarCell {
  date: Date;
  dateStr: string;
  inMonth: boolean;
  isToday: boolean;
  scheduledCount: number;
  doneCount: number;
  voided: boolean;
  routineId?: string;
  routineName?: string;
  routineColor?: string;
}

function localIso(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function scheduledDays(habit: Habit): number[] {
  if (Array.isArray(habit.scheduledDays) && habit.scheduledDays.length) return habit.scheduledDays;
  if (habit.frequency === 'Weekdays') return [1, 2, 3, 4, 5];
  if (habit.frequency === 'Weekly') return [0];
  return [0, 1, 2, 3, 4, 5, 6];
}

function isExcused(habit: Habit, dateStr: string): boolean {
  return Boolean(habit.excusedDates?.includes(dateStr));
}

// A date belongs to at most one routine at a time — once it's been claimed by checking off
// habits under a different routine, it's nulled out here: treated as fully off (not just
// unchecked), so the two routines' calendars never double-count the same day.
function isForeignDay(dateStr: string, currentRoutineId: string, routineByDate: Map<string, string>): boolean {
  const assigned = routineByDate.get(dateStr);
  return Boolean(assigned) && assigned !== currentRoutineId;
}

// Every routine is a genuinely separate set — a habit only shows up under a routine it's
// explicitly tagged with (unless deliberately tagged with more than one), so switching never
// overlaps. There's no untagged fallback bucket: once routines exist, a habit needs a tag to
// appear anywhere.
function matchesRoutineFilter(habit: Habit, routineFilter: string): boolean {
  return (habit.routineIds ?? []).includes(routineFilter);
}

// Whether any habit in the given list has this date checked — habits with a pending mutation
// use their about-to-be-saved checkins (via overrides) instead of their currently-stored ones,
// so the label can be computed from the same update that's about to be written.
function computeAnyChecked(habits: Habit[], dateStr: string, overrides: Map<string, string[]>): boolean {
  return habits.some(h => (overrides.get(h.id) ?? h.checkins).includes(dateStr));
}

function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatTime(time?: string): string {
  if (!time) return 'Any time';
  const [hStr, mStr] = time.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (Number.isNaN(h) || Number.isNaN(m)) return time;
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function formatMonthDay(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatWeekRange(start: Date): string {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endLabel = sameMonth
    ? end.toLocaleDateString('en-US', { day: 'numeric' })
    : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${startLabel} – ${endLabel}`;
}

function computeBestStreak(habits: Habit[], today: string, currentRoutineId: string, routineByDate: Map<string, string>): number {
  let streak = 0;
  const cursor = new Date(`${today}T12:00:00`);
  for (let i = 0; i < 730; i++) {
    const dateStr = localIso(cursor);
    const dayIndex = cursor.getDay();
    const foreign = isForeignDay(dateStr, currentRoutineId, routineByDate);
    const scheduled = foreign ? [] : habits.filter(h => scheduledDays(h).includes(dayIndex) && !isExcused(h, dateStr));
    if (scheduled.length > 0) {
      const perfect = scheduled.every(h => h.checkins.includes(dateStr));
      if (perfect) {
        streak++;
      } else if (dateStr !== today) {
        break;
      }
    }
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function blankHabit(routineId?: string): Partial<Habit> {
  return {
    name: '', description: '', frequency: 'Daily', checkins: [], active: true,
    scheduledDays: [0, 1, 2, 3, 4, 5, 6], routineIds: routineId ? [routineId] : undefined
  };
}

// Which routine is currently shown persists across tab switches — plain component state would
// otherwise silently reset on remount. Empty string means "no routine selected yet"; the
// effective filter falls back to the first routine once routines load.
function loadSavedRoutineFilter(): string {
  return window.localStorage.getItem(ROUTINE_FILTER_KEY) ?? '';
}

export function Habits() {
  const { data, upsert, remove } = useStore();
  const today = localIso();

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Habit>>(blankHabit());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth());
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [dragId, setDragId] = useState<string | null>(null);
  const [quote] = useState(getSessionQuote);
  const weeklyHistoryRef = useRef<HTMLHeadingElement>(null);
  const [manageRoutinesOpen, setManageRoutinesOpen] = useState(false);
  const [newRoutineName, setNewRoutineName] = useState('');
  const [routineNameDrafts, setRoutineNameDrafts] = useState<Record<string, string>>({});
  const [routineFilter, setRoutineFilterState] = useState<string>(loadSavedRoutineFilter);

  const setRoutineFilter = (id: string) => {
    setRoutineFilterState(id);
    window.localStorage.setItem(ROUTINE_FILTER_KEY, id);
  };

  const routines = data.habitRoutines.slice().sort((a, b) =>
    (a.order ?? 9999) - (b.order ?? 9999) || a.name.localeCompare(b.name)
  );
  // Falls back to the first routine if nothing (valid) is selected yet — e.g. first load,
  // or the previously-selected routine was just deleted.
  const effectiveRoutineFilter = routines.some(r => r.id === routineFilter) ? routineFilter : (routines[0]?.id ?? '');
  const routineColorId = (id: string) => ROUTINE_COLORS[Math.max(0, routines.findIndex(r => r.id === id)) % ROUTINE_COLORS.length];
  const routineByDate = useMemo(
    () => new Map(data.routineAssignments.map(r => [r.date, r.routineId])),
    [data.routineAssignments]
  );

  // Only a date with at least one actually-checked habit under the current routine gets
  // labeled (and so nulls out the other routines for that date) — an empty day stays
  // unlabeled, and unchecking the last checked habit clears the label again.
  //
  // The record's id is the date string itself (not a random id). Toggling several checkboxes
  // in quick succession fires several of these concurrently, each reading the same
  // not-yet-committed React state — with a random id, each one that thinks "no record exists
  // yet" would create its own, leaving duplicate/orphaned rows for the same date. Keying by
  // date makes every concurrent write for that date land on the exact same record, so the
  // worst a race can do is a last-write-wins on one row — never a duplicate.
  const applyRoutineLabel = async (dateStr: string, anyChecked: boolean) => {
    if (!effectiveRoutineFilter) return;
    const existing = data.routineAssignments.find(r => r.date === dateStr);
    if (anyChecked) {
      if (existing && existing.id === dateStr) {
        if (existing.routineId !== effectiveRoutineFilter) {
          await upsert('routineAssignments', { ...existing, routineId: effectiveRoutineFilter, updatedAt: new Date().toISOString() });
        }
        return;
      }
      // Either no record yet, or a pre-migration record with a random id — replace it with
      // the canonical date-keyed one.
      if (existing) await remove('routineAssignments', existing.id);
      const now = new Date().toISOString();
      await upsert('routineAssignments', { id: dateStr, date: dateStr, routineId: effectiveRoutineFilter, createdAt: now, updatedAt: now } as RoutineDateAssignment);
    } else if (existing && existing.routineId === effectiveRoutineFilter) {
      await remove('routineAssignments', existing.id);
    }
  };

  const habitsSorted = data.habits.slice().sort((a, b) =>
    (a.order ?? 9999) - (b.order ?? 9999)
    || (a.reminderAt || '99:99').localeCompare(b.reminderAt || '99:99')
    || a.name.localeCompare(b.name)
  );
  // Switching the routine dropdown swaps in a whole different habit list — every KPI, the
  // weekly table, and the history calendar all scope to whichever routine is selected. With no
  // routines defined yet, there's nothing to filter by, so everything shows (pre-routines baseline).
  const habitsInView = useMemo(
    () => routines.length === 0 ? habitsSorted : habitsSorted.filter(h => matchesRoutineFilter(h, effectiveRoutineFilter)),
    [habitsSorted, routines.length, effectiveRoutineFilter]
  );
  const activeHabits = habitsInView.filter(h => h.active !== false);

  const todayDayIndex = new Date().getDay();
  const todayIsForeign = isForeignDay(today, effectiveRoutineFilter, routineByDate);
  const dueToday = todayIsForeign ? [] : activeHabits.filter(h => scheduledDays(h).includes(todayDayIndex) && !isExcused(h, today));
  const doneToday = dueToday.filter(h => h.checkins.includes(today)).length;
  const todayPct = dueToday.length ? Math.round((doneToday / dueToday.length) * 100) : 0;

  const weekDates = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const { weekScheduled, weekDone } = useMemo(() => {
    let scheduled = 0;
    let done = 0;
    weekDates.forEach(d => {
      const dayIndex = d.getDay();
      const dateStr = localIso(d);
      if (isForeignDay(dateStr, effectiveRoutineFilter, routineByDate)) return;
      activeHabits.forEach(h => {
        if (scheduledDays(h).includes(dayIndex) && !isExcused(h, dateStr)) {
          scheduled++;
          if (h.checkins.includes(dateStr)) done++;
        }
      });
    });
    return { weekScheduled: scheduled, weekDone: done };
  }, [weekDates, activeHabits, effectiveRoutineFilter, routineByDate]);
  const weekPct = weekScheduled ? Math.round((weekDone / weekScheduled) * 100) : 0;

  const bestStreak = useMemo(
    () => computeBestStreak(activeHabits, today, effectiveRoutineFilter, routineByDate),
    [activeHabits, today, effectiveRoutineFilter, routineByDate]
  );

  const calendarWeeks = useMemo(() => {
    const first = new Date(calYear, calMonth, 1);
    const gridStart = addDays(first, -first.getDay());
    const cells: CalendarCell[] = Array.from({ length: 42 }, (_, i) => {
      const date = addDays(gridStart, i);
      const dateStr = localIso(date);
      const dayIndex = date.getDay();
      const foreign = isForeignDay(dateStr, effectiveRoutineFilter, routineByDate);
      const dueThatDay = foreign ? [] : activeHabits.filter(h => scheduledDays(h).includes(dayIndex));
      const scheduled = dueThatDay.filter(h => !isExcused(h, dateStr));
      const done = scheduled.filter(h => h.checkins.includes(dateStr)).length;
      // Mirrors the Weekly History table's void-day icon: a day only reads as "voided" on the
      // calendar once every habit that was due that day has actually been excused, not just
      // when nothing happened to be scheduled.
      const voided = dueThatDay.length > 0 && scheduled.length === 0;
      const assignedRoutineId = routineByDate.get(dateStr);
      const assignedRoutine = assignedRoutineId ? routines.find(r => r.id === assignedRoutineId) : undefined;
      return {
        date,
        dateStr,
        inMonth: date.getMonth() === calMonth,
        isToday: dateStr === today,
        scheduledCount: scheduled.length,
        doneCount: done,
        voided,
        routineId: assignedRoutine?.id,
        routineName: assignedRoutine?.name,
        routineColor: assignedRoutine ? routineColorId(assignedRoutine.id) : undefined
      };
    });
    const weeks: CalendarCell[][] = [];
    for (let i = 0; i < 42; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [calMonth, calYear, activeHabits, today, routineByDate, routines, effectiveRoutineFilter]);

  const yearOptions = useMemo(() => Array.from({ length: 75 }, (_, i) => 2026 + i), []);

  const startAdd = () => { setForm(blankHabit(effectiveRoutineFilter || undefined)); setEditingId(null); setShowForm(true); };
  const startEdit = (habit: Habit) => { setForm({ ...habit, scheduledDays: scheduledDays(habit) }); setEditingId(habit.id); setShowForm(true); };
  const cancel = () => { setShowForm(false); setEditingId(null); setForm(blankHabit()); };

  const addRoutine = async () => {
    const name = newRoutineName.trim();
    if (!name) return;
    await upsert('habitRoutines', newRecord<HabitRoutine>({ name, order: data.habitRoutines.length }));
    setNewRoutineName('');
  };

  // The input is free-typing (so the user can clear it mid-edit without fighting a controlled
  // value snapping back), and only commits to storage on blur/Enter — with the same
  // trim+empty-check addRoutine already uses, so a routine can no longer be renamed to a blank
  // string and become an invisible dropdown option. An empty commit reverts to the prior name.
  const commitRoutineName = (id: string) => {
    const draft = routineNameDrafts[id];
    setRoutineNameDrafts(({ [id]: _omit, ...rest }) => rest);
    if (draft === undefined) return;
    const routine = data.habitRoutines.find(r => r.id === id);
    if (!routine) return;
    const name = draft.trim();
    if (!name || name === routine.name) return;
    void upsert('habitRoutines', { ...routine, name });
  };

  const deleteRoutine = async (id: string) => {
    const affectedHabits = data.habits.filter(h => (h.routineIds ?? []).includes(id));
    const affectedDates = data.routineAssignments.filter(r => r.routineId === id);
    if ((affectedHabits.length || affectedDates.length) && !window.confirm(
      `Delete this routine? ${affectedHabits.length} habit${affectedHabits.length === 1 ? '' : 's'} will be untagged and won't appear in any routine view until reassigned, and ${affectedDates.length} calendar day${affectedDates.length === 1 ? '' : 's'} will lose their label.`
    )) return;
    await Promise.all([
      ...affectedHabits.map(h => upsert('habits', { ...h, routineIds: (h.routineIds ?? []).filter(x => x !== id) })),
      ...affectedDates.map(r => remove('routineAssignments', r.id))
    ]);
    await remove('habitRoutines', id);
    if (routineFilter === id) setRoutineFilter('');
  };

  const handleFrequencyChange = (freq: HabitFrequency) => {
    setForm(prev => ({ ...prev, frequency: freq, scheduledDays: presetForFrequency(freq, prev.scheduledDays ?? []) }));
  };

  const save = async () => {
    if (editingId) {
      const base = data.habits.find(h => h.id === editingId);
      if (!base) return cancel();
      await upsert('habits', { ...base, ...form } as Habit);
    } else {
      await upsert('habits', newRecord<Habit>({ ...form, order: data.habits.length }));
    }
    cancel();
  };

  const setField = <K extends keyof Habit>(key: K, value: Habit[K]) => setForm(prev => ({ ...prev, [key]: value }));

  // A habit belongs to at most one routine — picking a routine replaces whatever was selected
  // before, and re-picking the already-selected one clears it back to "no routine".
  const toggleHabitRoutine = (id: string) => {
    const current = form.routineIds ?? [];
    setField('routineIds', current.includes(id) ? [] : [id]);
  };

  const toggleDay = async (habit: Habit, date: string) => {
    const has = habit.checkins.includes(date);
    const nextCheckins = has ? habit.checkins.filter(d => d !== date) : [...habit.checkins, date];
    const anyChecked = computeAnyChecked(habitsInView, date, new Map([[habit.id, nextCheckins]]));
    await Promise.all([
      upsert('habits', { ...habit, checkins: nextCheckins }),
      applyRoutineLabel(date, anyChecked)
    ]);
  };

  const checkAllForDay = async (dateStr: string, dayIndex: number) => {
    if (isForeignDay(dateStr, effectiveRoutineFilter, routineByDate)) return;
    const targets = activeHabits.filter(h => scheduledDays(h).includes(dayIndex));
    if (!targets.length) return;
    const alreadyAllDone = targets.every(h => h.checkins.includes(dateStr) && !isExcused(h, dateStr));
    const overrides = new Map<string, string[]>();
    const updates = targets.map(h => {
      if (alreadyAllDone) {
        const nextCheckins = h.checkins.filter(d => d !== dateStr);
        overrides.set(h.id, nextCheckins);
        if (!h.checkins.includes(dateStr)) return Promise.resolve();
        return upsert('habits', { ...h, checkins: nextCheckins });
      }
      const alreadyDone = h.checkins.includes(dateStr);
      const wasExcused = isExcused(h, dateStr);
      const nextCheckins = alreadyDone ? h.checkins : [...h.checkins, dateStr];
      overrides.set(h.id, nextCheckins);
      if (alreadyDone && !wasExcused) return Promise.resolve();
      return upsert('habits', {
        ...h,
        checkins: nextCheckins,
        excusedDates: (h.excusedDates ?? []).filter(d => d !== dateStr)
      });
    });
    const anyChecked = computeAnyChecked(habitsInView, dateStr, overrides);
    await Promise.all([...updates, applyRoutineLabel(dateStr, anyChecked)]);
  };

  const voidDay = async (dateStr: string, dayIndex: number) => {
    if (isForeignDay(dateStr, effectiveRoutineFilter, routineByDate)) return;
    const targets = activeHabits.filter(h => scheduledDays(h).includes(dayIndex));
    if (!targets.length) return;
    const alreadyAllExcused = targets.every(h => isExcused(h, dateStr));
    const overrides = new Map<string, string[]>();
    const updates = targets.map(h => {
      if (alreadyAllExcused) {
        overrides.set(h.id, h.checkins);
        if (!isExcused(h, dateStr)) return Promise.resolve();
        return upsert('habits', { ...h, excusedDates: (h.excusedDates ?? []).filter(d => d !== dateStr) });
      }
      const wasDone = h.checkins.includes(dateStr);
      const wasExcused = isExcused(h, dateStr);
      const nextCheckins = wasDone ? h.checkins.filter(d => d !== dateStr) : h.checkins;
      overrides.set(h.id, nextCheckins);
      if (!wasDone && wasExcused) return Promise.resolve();
      return upsert('habits', {
        ...h,
        checkins: nextCheckins,
        excusedDates: wasExcused ? h.excusedDates : [...(h.excusedDates ?? []), dateStr]
      });
    });
    // Voiding never adds a checkin, so this only ever clears the label (if nothing else that
    // date is still checked) — it never creates one on its own.
    const anyChecked = computeAnyChecked(habitsInView, dateStr, overrides);
    await Promise.all([...updates, applyRoutineLabel(dateStr, anyChecked)]);
  };

  const toggleScheduledDay = (day: number) => {
    const current = form.scheduledDays ?? [];
    setField('scheduledDays', current.includes(day) ? current.filter(d => d !== day) : [...current, day].sort((a, b) => a - b));
  };

  const deleteHabit = (id: string) => remove('habits', id);

  const handleDrop = async (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ordered = habitsInView.map(h => h.id);
    const fromIndex = ordered.indexOf(dragId);
    const toIndex = ordered.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) { setDragId(null); return; }
    const next = [...ordered];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, dragId);
    // `order` is a single global field shared by every habit, but habitsInView is only the
    // current routine's subset — renumbering it from 0 would stomp on unrelated habits from
    // other routines that happen to share those same low order values. Reusing the exact slots
    // this subset already occupies keeps the reorder scoped to just these habits.
    const slots = habitsInView.map(h => h.order ?? 9999).sort((a, b) => a - b);
    await Promise.all(next.map((id, index) => {
      const habit = data.habits.find(h => h.id === id);
      const slot = slots[index];
      if (!habit || habit.order === slot) return Promise.resolve();
      return upsert('habits', { ...habit, order: slot });
    }));
    setDragId(null);
  };

  const shiftMonth = (delta: number) => {
    let m = calMonth + delta;
    let y = calYear;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    setCalMonth(m);
    setCalYear(y);
  };

  const jumpToday = () => {
    const now = new Date();
    setCalMonth(now.getMonth());
    setCalYear(now.getFullYear());
  };

  const returnToCurrentWeek = () => setWeekStart(startOfWeek(new Date()));

  const jumpToWeekOf = (date: Date) => {
    setWeekStart(startOfWeek(date));
    weeklyHistoryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const pickWeekDate = (value: string) => {
    if (!value) return;
    setWeekStart(startOfWeek(new Date(`${value}T12:00:00`)));
  };

  const isCurrentWeek = localIso(weekStart) === localIso(startOfWeek(new Date()));

  return (
    <>
      <div className="habits-header">
        <div>
          <h1>Habits</h1>
          <p>Show up today — your future self is counting on you.</p>
          <p className="habits-quote"><QuoteIcon size={14} /> "{quote.text}" <span>— {quote.author}</span></p>
        </div>
        <div className="habits-header-actions">
          <button type="button" className="btn ghost" onClick={() => setManageRoutinesOpen(true)}>
            <Settings2 size={16} /> Routines
          </button>
          {!showForm && <button type="button" className="btn teal" onClick={startAdd}><Plus size={16} /> New habit</button>}
        </div>
      </div>

      <div className="habits-kpi-grid">
        <div className="habits-kpi accent-teal">
          <span className="habits-kpi-label">Today's completion</span>
          <strong>{todayPct}%</strong>
          <small>{doneToday}/{dueToday.length} scheduled habits checked</small>
          <div className="progress-bar"><div className="progress-bar-fill" style={{ width: `${todayPct}%` }} /></div>
        </div>
        <div className="habits-kpi accent-blue">
          <span className="habits-kpi-label">Selected week</span>
          <strong>{weekPct}%</strong>
          <small>{weekDone}/{weekScheduled} checks for {formatWeekRange(weekStart)}</small>
          <div className="progress-bar"><div className="progress-bar-fill" style={{ width: `${weekPct}%` }} /></div>
        </div>
        <div className="habits-kpi accent-amber">
          <span className="habits-kpi-label">Active habits</span>
          <strong>{activeHabits.length}</strong>
          <small>{activeHabits.length} total habits</small>
        </div>
        <div className="habits-kpi accent-purple">
          <span className="habits-kpi-label">Best streak</span>
          <strong>{bestStreak}</strong>
          <small>consecutive days kept</small>
        </div>
      </div>

      {showForm && (
        <Modal
          eyebrow="Life OS"
          title={editingId ? 'Edit habit' : 'New habit'}
          onClose={cancel}
          footer={<>
            <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void save()}>Save</button>
          </>}
        >
          <div className="form-grid">
            <label className="field-full"><span>Habit</span><input value={form.name ?? ''} onChange={e => setField('name', e.target.value)} /></label>
            <label>
              <span>Frequency</span>
              <select value={form.frequency ?? 'Daily'} onChange={e => handleFrequencyChange(e.target.value as HabitFrequency)}>
                {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label><span>Habit time</span><TimeWheelPicker value={form.reminderAt} onChange={v => setField('reminderAt', v || undefined)} /></label>
            <div className="field-full">
              <span className="field-label">Days this habit is needed</span>
              <div className="day-check-grid">
                {DAY_FULL.map((label, day) => (
                  <label key={day} className="day-check">
                    <input
                      type="checkbox"
                      checked={(form.scheduledDays ?? []).includes(day)}
                      onChange={() => toggleScheduledDay(day)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            {routines.length > 0 && (
              <div className="field-full">
                <span className="field-label">Routines (leave unchecked and this habit won't appear in any routine view)</span>
                <div className="day-check-grid">
                  {routines.map(r => (
                    <label key={r.id} className="day-check">
                      <input
                        type="checkbox"
                        checked={(form.routineIds ?? []).includes(r.id)}
                        onChange={() => toggleHabitRoutine(r.id)}
                      />
                      <span>{r.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <label className="field-full">
              <span>Description</span>
              <textarea rows={4} value={form.description ?? ''} onChange={e => setField('description', e.target.value)} placeholder="Why this habit matters…" />
            </label>
          </div>
        </Modal>
      )}

      {manageRoutinesOpen && (
        <Modal
          eyebrow="Habits"
          title="Manage routines"
          onClose={() => setManageRoutinesOpen(false)}
          footer={<button type="button" className="btn ghost" onClick={() => setManageRoutinesOpen(false)}>Done</button>}
        >
          <div className="routine-manage-list">
            {routines.length === 0 && (
              <p className="muted">No routines yet — add one below (e.g. Routine A, Routine B), then tag habits with it from the habit's edit form. Switching the dropdown on the Habit column will swap in just that routine's habits.</p>
            )}
            {routines.map(r => (
              <div className="routine-manage-row" key={r.id}>
                <input
                  type="text"
                  value={routineNameDrafts[r.id] ?? r.name}
                  onChange={e => setRoutineNameDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                  onBlur={() => commitRoutineName(r.id)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                />
                <button type="button" className="icon-btn danger" onClick={() => void deleteRoutine(r.id)} aria-label={`Delete ${r.name}`}><Trash2 size={13} /></button>
              </div>
            ))}
            <div className="routine-manage-add">
              <input
                type="text"
                value={newRoutineName}
                onChange={e => setNewRoutineName(e.target.value)}
                placeholder="New routine name — e.g. Routine A"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addRoutine(); } }}
              />
              <button type="button" className="btn ghost small" onClick={() => void addRoutine()} disabled={!newRoutineName.trim()}><Plus size={13} /> Add</button>
            </div>
          </div>
        </Modal>
      )}

      <Card className="week-card">
        <div className="week-card-header">
          <div className="week-card-title"><Calendar size={17} /><h2 ref={weeklyHistoryRef}>Weekly History</h2></div>
          <div className="week-nav">
            {!isCurrentWeek && (
              <button type="button" className="icon-btn" onClick={returnToCurrentWeek} aria-label="Return to current week" title="Return to current week">
                <RotateCcw size={15} />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week"><ChevronLeft size={16} /></button>
            <DatePicker
              value={localIso(weekStart)}
              onChange={pickWeekDate}
              displayLabel={formatWeekRange(weekStart)}
            />
            <button type="button" className="icon-btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week"><ChevronRight size={16} /></button>
          </div>
        </div>
        <div className="week-table">
          <div className="week-table-row week-table-header">
            <span className="week-col-time">Time</span>
            <span className="week-col-habit">
              <span>Habit</span>
              {routines.length > 0 && (
                <select
                  className="week-habit-routine-select"
                  value={effectiveRoutineFilter}
                  onChange={e => setRoutineFilter(e.target.value)}
                  aria-label="Routine"
                >
                  {routines.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
            </span>
            {weekDates.map(d => {
              const dateStr = localIso(d);
              const dayLabel = DAY_LABELS[d.getDay()];
              return (
                <span key={dateStr} className={`week-col-day ${dateStr === today ? 'is-today' : ''}`}>
                  <button
                    type="button"
                    className="week-day-bulk void"
                    onClick={() => void voidDay(dateStr, d.getDay())}
                    aria-label={`Void ${dayLabel} for everyone`}
                    title="Excuse everyone for this day"
                  >
                    <X size={13} />
                  </button>
                  <span className="week-day-label">{dayLabel}<small>{formatMonthDay(d)}</small></span>
                  <button
                    type="button"
                    className="week-day-bulk check"
                    onClick={() => void checkAllForDay(dateStr, d.getDay())}
                    aria-label={`Check off everyone for ${dayLabel}`}
                    title="Check off everyone for this day"
                  >
                    <Check size={13} />
                  </button>
                </span>
              );
            })}
          </div>
          {habitsInView.length ? habitsInView.map(habit => {
            const days = scheduledDays(habit);
            return (
              <div
                key={habit.id}
                className={`week-table-row ${dragId === habit.id ? 'dragging' : ''} ${habit.active === false ? 'is-paused' : ''}`}
                onDragOver={e => e.preventDefault()}
                onDrop={() => void handleDrop(habit.id)}
              >
                <span className="week-col-time">
                  <span
                    className="drag-handle"
                    draggable
                    title="Drag to reorder"
                    aria-label={`Drag to reorder ${habit.name}`}
                    onDragStart={e => {
                      setDragId(habit.id);
                      e.dataTransfer.effectAllowed = 'move';
                      const row = e.currentTarget.closest('.week-table-row');
                      if (row instanceof HTMLElement) e.dataTransfer.setDragImage(row, 20, 20);
                    }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <GripVertical size={14} />
                  </span>
                  <Clock size={13} />
                  {formatTime(habit.reminderAt)}
                </span>
                <span className="week-col-habit">
                  <span className="week-habit-info">
                    <b>{habit.name}</b>
                    {(habit.description || habit.active === false) && (
                      <small>{habit.description}{habit.active === false ? ' · Paused' : ''}</small>
                    )}
                  </span>
                  <span className="week-row-actions">
                    <button type="button" className="icon-btn" onClick={() => startEdit(habit)} aria-label="Edit habit"><Pencil size={13} /></button>
                    <button type="button" className="icon-btn danger" onClick={() => void deleteHabit(habit.id)} aria-label="Delete habit"><Trash2 size={13} /></button>
                  </span>
                </span>
                {weekDates.map(d => {
                  const dateStr = localIso(d);
                  const scheduled = days.includes(d.getDay()) && !isForeignDay(dateStr, effectiveRoutineFilter, routineByDate);
                  const excused = isExcused(habit, dateStr);
                  const done = habit.checkins.includes(dateStr);
                  return (
                    <span key={dateStr} className={`week-col-day ${dateStr === today ? 'is-today' : ''}`}>
                      {scheduled && !excused ? (
                        <button
                          type="button"
                          className={`week-check ${done ? 'done' : ''}`}
                          onClick={() => void toggleDay(habit, dateStr)}
                          aria-label={`${done ? 'Uncheck' : 'Check'} ${habit.name} for ${dateStr}`}
                        >{done && <Check size={13} />}</button>
                      ) : scheduled && excused ? (
                        <span className="week-excused" title={`${habit.name} excused for this day`} aria-label={`${habit.name} excused for ${dateStr}`}>
                          <CircleSlash size={13} />
                        </span>
                      ) : <span className="week-off">—</span>}
                    </span>
                  );
                })}
              </div>
            );
          }) : (
            <div className="week-empty muted">
              {routines.length === 0 ? 'No habits yet. Add one to start tracking.' : 'No habits tagged with this routine yet.'}
            </div>
          )}
        </div>
      </Card>

      <Card className="habit-calendar-card">
        <div className="week-card-header">
          <div className="week-card-title"><Calendar size={17} /><h2>Habit History Calendar</h2></div>
          <div className="calendar-nav">
            <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={16} /></button>
            <select value={calMonth} onChange={e => setCalMonth(Number(e.target.value))}>
              {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
            <select value={calYear} onChange={e => setCalYear(Number(e.target.value))}>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month"><ChevronRight size={16} /></button>
            <button type="button" className="btn ghost small" onClick={jumpToday}>Today</button>
          </div>
        </div>
        {routines.length > 0 && (
          <div className="routine-legend">
            {routines.map(r => (
              <span className="routine-legend-item" key={r.id}>
                <span className="routine-legend-dot" style={{ background: routineColorId(r.id) }} />
                {r.name}
              </span>
            ))}
          </div>
        )}
        <div className="calendar-grid">
          <div className="calendar-grid-row calendar-grid-header">
            {DAY_LABELS.map(d => <span key={d}>{d}</span>)}
          </div>
          {calendarWeeks.map((week, wi) => (
            <div className="calendar-grid-row" key={wi}>
              {week.map(cell => (
                <button
                  type="button"
                  key={cell.dateStr}
                  className={`calendar-cell ${cell.inMonth ? '' : 'other-month'} ${cell.isToday ? 'today' : ''} ${cell.voided ? 'voided' : ''}`}
                  style={cell.routineColor ? { borderTopColor: cell.routineColor } : undefined}
                  onClick={() => jumpToWeekOf(cell.date)}
                  aria-label={`View the week of ${cell.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}${cell.routineName ? ` — ${cell.routineName}` : ''}${cell.voided ? ' — excused' : ''}`}
                  title={cell.voided ? 'Excused' : cell.routineName}
                >
                  <span className="calendar-cell-date">{cell.date.getDate()}</span>
                  {cell.voided ? (
                    <span className="calendar-cell-voided"><CircleSlash size={14} /></span>
                  ) : (
                    <>
                      <span className="calendar-cell-frac">{cell.doneCount}/{cell.scheduledCount}</span>
                      <div className="calendar-cell-bar">
                        <div style={{ width: cell.scheduledCount ? `${Math.round((cell.doneCount / cell.scheduledCount) * 100)}%` : '0%' }} />
                      </div>
                    </>
                  )}
                  {cell.routineName && (
                    <span className="calendar-cell-routine" style={{ color: cell.routineColor }}>{cell.routineName}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
