import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Card } from './UI';
import { DatePicker } from './DatePicker';
import { RichTextEditor } from './RichTextEditor';
import { NumberCell, OptionalNumberCell } from './GridCells';
import { buildStarterRoutine, ROUTINE_EPOCH } from '../lib/starterRoutine';
import { generateId } from '../utils/id';
import type { ExerciseSetLog, ProgramAssignment, RoutineDay, RoutineExercise, RoutineVersion, WorkoutRoutine } from '../types';

// Formats in local time, not UTC — Date#toISOString() converts to UTC first, which rolls
// over to the next calendar day during evening hours in any timezone behind UTC.
function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toLocalIso(d);
}

function shiftIso(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return toLocalIso(d);
}

// The version of the day/exercise structure that was in effect on a given date — the latest
// version whose effectiveFrom is on or before that date. Versions are always kept sorted
// ascending by effectiveFrom, and there's always at least one (created at ROUTINE_EPOCH).
function resolveVersion(routine: WorkoutRoutine, date: string): RoutineVersion {
  let best = routine.versions[0];
  for (const v of routine.versions) {
    if (v.effectiveFrom <= date) best = v;
    else break;
  }
  return best;
}

function cloneDays(days: RoutineDay[]): RoutineDay[] {
  return days.map(d => ({ ...d, exercises: d.exercises.map(ex => ({ ...ex })) }));
}

// Applies a structural edit (rename, sets/reps change, add/remove exercise or day) so it only
// takes effect from `date` forward. A second edit made on the same date coalesces into the
// version already branched for it; an edit on a new date branches a fresh version off of
// whatever was effective on that date, leaving every earlier version — and therefore every
// earlier date's view of the plan — untouched.
function withStructuralEdit(routine: WorkoutRoutine, date: string, mutate: (days: RoutineDay[]) => RoutineDay[]): RoutineVersion[] {
  const idx = routine.versions.findIndex(v => v.effectiveFrom === date);
  if (idx >= 0) {
    const updated = routine.versions.slice();
    updated[idx] = { ...updated[idx], days: mutate(updated[idx].days) };
    return updated;
  }
  const base = resolveVersion(routine, date);
  const branched: RoutineVersion = { effectiveFrom: date, days: mutate(cloneDays(base.days)) };
  return [...routine.versions, branched].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

// Which program was in effect for a given date — the latest assignment on or before it. Dates
// before the first-ever assignment (or before any switch has ever happened) resolve to
// undefined, meaning "no opinion, leave whatever's currently showing alone" rather than
// guessing at a program to jump to.
function resolveProgramForDate(assignments: ProgramAssignment[] | undefined, date: string): string | undefined {
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
function withProgramAssignment(assignments: ProgramAssignment[], date: string, routineId: string): ProgramAssignment[] {
  const idx = assignments.findIndex(a => a.effectiveFrom === date);
  if (idx >= 0) {
    const updated = assignments.slice();
    updated[idx] = { ...updated[idx], routineId };
    return updated;
  }
  return [...assignments, { effectiveFrom: date, routineId }].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

const DAY_ACCENTS = ['teal', 'amber', 'ember', 'purple'];

// Portals the tooltip to document.body with position:fixed so it floats above the
// horizontally-scrolling routine table instead of being clipped by (or widening) it.
function NameTooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left });
  };
  const hide = () => setPos(null);

  return (
    <div ref={wrapRef} className="health-routine-name-wrap" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && createPortal(
        <div className="health-routine-tooltip" style={{ top: pos.top, left: pos.left }}>{text}</div>,
        document.body
      )}
    </div>
  );
}

// Icon-only trigger (the name is already shown right beside it in an editable field) that opens
// a portal-based menu for switching, creating, and deleting programs.
function ProgramMenu({
  routines, activeId, onSwitch, onCreate, onDelete
}: {
  routines: WorkoutRoutine[];
  activeId: string;
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
    }
    setOpen(o => !o);
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="icon-btn health-routine-program-trigger"
        onClick={toggle}
        aria-label="Switch workout program"
        title="Switch workout program"
      >
        <ChevronDown size={16} />
      </button>
      {open && createPortal(
        <div className="health-routine-program-menu" ref={menuRef} style={{ top: pos.top, left: pos.left }}>
          {routines.map(r => (
            <div key={r.id} className={`health-routine-program-row${r.id === activeId ? ' active' : ''}`}>
              <button
                type="button"
                className="health-routine-program-row-name"
                onClick={() => { onSwitch(r.id); setOpen(false); }}
              >
                {r.id === activeId ? <Check size={14} /> : <span className="health-routine-program-row-spacer" />}
                <span>{r.name || 'Untitled Program'}</span>
              </button>
              <button
                type="button"
                className="icon-btn danger small"
                onClick={() => onDelete(r.id)}
                aria-label={`Delete ${r.name || 'program'}`}
                title="Delete program"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button type="button" className="health-routine-program-add" onClick={() => { onCreate(); setOpen(false); }}>
            <Plus size={14} /> New Program
          </button>
        </div>,
        document.body
      )}
    </>
  );
}

function RoutineExerciseRow({
  exercise, maxSets, activeEntry, onLogDate, onEditWeight, onEditLastReps, onEditField, onDelete
}: {
  exercise: RoutineExercise;
  maxSets: number;
  activeEntry: ExerciseSetLog | undefined;
  onLogDate: () => void;
  onEditWeight: (setIndex: number, weight: number | undefined) => void;
  onEditLastReps: (reps: number | undefined) => void;
  onEditField: (patch: Partial<RoutineExercise>) => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td>
        <NameTooltip text={exercise.name}>
          <input type="text" className="grid-cell-input input-wide" value={exercise.name} onChange={e => onEditField({ name: e.target.value })} />
        </NameTooltip>
      </td>
      <td className="grid-td-compact"><NumberCell value={exercise.targetSets} onChange={n => onEditField({ targetSets: n })} /></td>
      <td className="grid-td-compact"><input type="text" className="grid-cell-input" value={exercise.targetReps} placeholder="e.g. 12 or 10-12" onChange={e => onEditField({ targetReps: e.target.value })} /></td>
      {Array.from({ length: maxSets }, (_, i) => {
        if (i >= exercise.targetSets) return <td key={i} className="health-routine-blank-cell" />;
        if (!activeEntry) {
          return i === 0
            ? <td key={i} className="grid-td-compact"><button type="button" className="btn ghost small" onClick={onLogDate}>+ Log</button></td>
            : <td key={i} className="health-routine-blank-cell" />;
        }
        return (
          <td key={i} className="grid-td-compact">
            <OptionalNumberCell value={activeEntry.weights[i]} onChange={n => onEditWeight(i, n)} placeholder="lb" />
          </td>
        );
      })}
      <td className="grid-td-compact">
        {activeEntry && <OptionalNumberCell value={activeEntry.lastReps} onChange={onEditLastReps} placeholder="reps" />}
      </td>
      <td><button type="button" className="icon-btn danger" onClick={onDelete} aria-label={`Delete ${exercise.name}`}><Trash2 size={13} /></button></td>
    </tr>
  );
}

function RoutineDayCard({
  day, accent, entryByExerciseId, onLogDate, onEditWeight, onEditLastReps, onEditField, onDeleteExercise, onAddExercise, onEditDay, onDeleteDay
}: {
  day: RoutineDay;
  accent: string;
  entryByExerciseId: Map<string, ExerciseSetLog>;
  onLogDate: (exerciseId: string) => void;
  onEditWeight: (exerciseId: string, setIndex: number, weight: number | undefined) => void;
  onEditLastReps: (exerciseId: string, reps: number | undefined) => void;
  onEditField: (exerciseId: string, patch: Partial<RoutineExercise>) => void;
  onDeleteExercise: (exerciseId: string) => void;
  onAddExercise: () => void;
  onEditDay: (patch: Partial<RoutineDay>) => void;
  onDeleteDay: () => void;
}) {
  const maxSets = Math.max(1, ...day.exercises.map(e => e.targetSets));

  return (
    <Card className={`health-routine-day accent-${accent}`}>
      <div className="health-routine-day-head">
        <input type="text" className="grid-cell-input health-routine-day-name" value={day.name} onChange={e => onEditDay({ name: e.target.value })} />
        <button type="button" className="icon-btn danger" onClick={onDeleteDay} aria-label={`Delete ${day.name}`}><Trash2 size={13} /></button>
      </div>
      <label className="health-routine-warmup-field">
        <span>Warm-up</span>
        <input type="text" className="grid-cell-input" value={day.warmup ?? ''} placeholder="e.g. 5 min light cardio" onChange={e => onEditDay({ warmup: e.target.value || undefined })} />
      </label>
      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Exercise</th>
              <th>Sets</th>
              <th>Reps</th>
              {Array.from({ length: maxSets }, (_, i) => <th key={i}>Weight</th>)}
              <th>Last Rep</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {day.exercises.map(ex => (
              <RoutineExerciseRow
                key={ex.id}
                exercise={ex}
                maxSets={maxSets}
                activeEntry={entryByExerciseId.get(ex.id)}
                onLogDate={() => onLogDate(ex.id)}
                onEditWeight={(i, w) => onEditWeight(ex.id, i, w)}
                onEditLastReps={reps => onEditLastReps(ex.id, reps)}
                onEditField={patch => onEditField(ex.id, patch)}
                onDelete={() => onDeleteExercise(ex.id)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn ghost small health-routine-add-exercise" onClick={onAddExercise}><Plus size={14} /> Add exercise</button>
    </Card>
  );
}

export function WorkoutRoutineSection({
  activeDate: logDate, onActiveDateChange: setLogDate
}: {
  activeDate: string;
  onActiveDateChange: (iso: string) => void;
}) {
  const { data, upsert, remove, updateSettings } = useStore();
  const routines = data.workoutRoutines;
  const routine = routines.find(r => r.id === data.settings.activeWorkoutRoutineId) ?? routines[0];

  // Whichever program was assigned to a given date should reload when you come back to that
  // date, regardless of which program you last had open elsewhere. Dates the assignment
  // history doesn't cover leave the currently active program alone.
  useEffect(() => {
    const resolvedId = resolveProgramForDate(data.settings.workoutRoutineAssignments, logDate);
    if (resolvedId && resolvedId !== routine?.id && routines.some(r => r.id === resolvedId)) {
      void updateSettings({ activeWorkoutRoutineId: resolvedId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logDate]);

  const loadStarter = () => {
    const r = newRecord<WorkoutRoutine>(buildStarterRoutine());
    void upsert('workoutRoutines', r);
    void updateSettings({ activeWorkoutRoutineId: r.id });
  };

  if (!routine) {
    return (
      <Card>
        <div className="card-title"><div><h2>Workout Routine</h2></div></div>
        <p className="muted empty-state">No program set up yet.</p>
        <button type="button" className="btn teal" onClick={loadStarter}><Plus size={16} /> Load Starter Program</button>
      </Card>
    );
  }

  // Seeds an epoch assignment for whatever's currently active the first time you ever switch,
  // so every date before this point retroactively resolves to the program it was actually
  // logged under, instead of leaving a gap with no assignment history.
  const seedAssignments = (): ProgramAssignment[] => {
    const existing = data.settings.workoutRoutineAssignments ?? [];
    return existing.length === 0 && routine ? [{ effectiveFrom: ROUTINE_EPOCH, routineId: routine.id }] : existing;
  };

  const switchProgram = (id: string) => {
    const assignments = withProgramAssignment(seedAssignments(), logDate, id);
    void updateSettings({ workoutRoutineAssignments: assignments, activeWorkoutRoutineId: id });
  };

  const createProgram = () => {
    const r = newRecord<WorkoutRoutine>({ name: 'New Program', versions: [{ effectiveFrom: ROUTINE_EPOCH, days: [] }], exerciseLogs: [] });
    void upsert('workoutRoutines', r);
    const assignments = withProgramAssignment(seedAssignments(), logDate, r.id);
    void updateSettings({ workoutRoutineAssignments: assignments, activeWorkoutRoutineId: r.id });
  };

  const deleteProgram = (id: string) => {
    void remove('workoutRoutines', id);
    if (id === routine.id) {
      const remaining = routines.filter(r => r.id !== id);
      void updateSettings({ activeWorkoutRoutineId: remaining[0]?.id });
    }
  };

  // Falls back to auto-detecting from exercise logs only until the user has ever toggled the
  // badge themselves — once they do, loggedDates becomes the sole source of truth.
  const loggedDates = routine.loggedDates ?? [...new Set(routine.exerciseLogs.map(l => l.date))];
  const loggedOnActiveDate = loggedDates.includes(logDate);

  const toggleLogged = () => {
    const set = new Set(loggedDates);
    if (set.has(logDate)) set.delete(logDate); else set.add(logDate);
    void upsert('workoutRoutines', { ...routine, loggedDates: [...set] });
  };

  const activeDays = resolveVersion(routine, logDate).days;
  const entryByExerciseId = new Map(routine.exerciseLogs.filter(l => l.date === logDate).map(l => [l.exerciseId, l]));

  const patchDays = (mutate: (days: RoutineDay[]) => RoutineDay[]) => {
    void upsert('workoutRoutines', { ...routine, versions: withStructuralEdit(routine, logDate, mutate) });
  };

  const patchExercise = (dayId: string, exerciseId: string, updater: (ex: RoutineExercise) => RoutineExercise) => {
    patchDays(days => days.map(d => d.id !== dayId ? d : {
      ...d,
      exercises: d.exercises.map(ex => ex.id !== exerciseId ? ex : updater(ex))
    }));
  };

  const patchDay = (dayId: string, patch: Partial<RoutineDay>) => {
    patchDays(days => days.map(d => d.id !== dayId ? d : { ...d, ...patch }));
  };

  const logForDate = (exerciseId: string, targetSets: number) => {
    if (routine.exerciseLogs.some(l => l.exerciseId === exerciseId && l.date === logDate)) return;
    const prior = routine.exerciseLogs.filter(l => l.exerciseId === exerciseId).sort((a, b) => a.date.localeCompare(b.date));
    const last = prior[prior.length - 1];
    const weights: (number | undefined)[] = Array.from({ length: targetSets }, (_, i) => last?.weights[i]);
    const entry: ExerciseSetLog = { exerciseId, date: logDate, weights, lastReps: last?.lastReps };
    void upsert('workoutRoutines', { ...routine, exerciseLogs: [...routine.exerciseLogs, entry] });
  };

  const editWeight = (exerciseId: string, setIndex: number, weight: number | undefined) => {
    const exerciseLogs = routine.exerciseLogs.map(l => {
      if (l.exerciseId !== exerciseId || l.date !== logDate) return l;
      const weights = l.weights.slice();
      weights[setIndex] = weight;
      return { ...l, weights };
    });
    void upsert('workoutRoutines', { ...routine, exerciseLogs });
  };

  const editLastReps = (exerciseId: string, reps: number | undefined) => {
    const exerciseLogs = routine.exerciseLogs.map(l => (l.exerciseId === exerciseId && l.date === logDate) ? { ...l, lastReps: reps } : l);
    void upsert('workoutRoutines', { ...routine, exerciseLogs });
  };

  const editExerciseField = (dayId: string, exerciseId: string, patch: Partial<RoutineExercise>) => {
    patchExercise(dayId, exerciseId, ex => ({ ...ex, ...patch }));
  };

  const addExercise = (dayId: string) => {
    patchDays(days => days.map(d => d.id !== dayId ? d : {
      ...d,
      exercises: [...d.exercises, { id: generateId(), name: '', targetSets: 3, targetReps: '12' }]
    }));
  };

  const deleteExercise = (dayId: string, exerciseId: string) => {
    patchDays(days => days.map(d => d.id !== dayId ? d : { ...d, exercises: d.exercises.filter(ex => ex.id !== exerciseId) }));
  };

  const addDay = () => {
    const newDay: RoutineDay = { id: generateId(), name: `Day ${activeDays.length + 1}`, exercises: [] };
    patchDays(days => [...days, newDay]);
  };

  const deleteDay = (dayId: string) => {
    patchDays(days => days.filter(d => d.id !== dayId));
  };

  return (
    <>
      <div className="health-routine-header">
        <ProgramMenu
          routines={routines}
          activeId={routine.id}
          onSwitch={switchProgram}
          onCreate={createProgram}
          onDelete={deleteProgram}
        />
        <input
          type="text"
          className="grid-cell-input health-routine-name-field"
          value={routine.name}
          onChange={e => void upsert('workoutRoutines', { ...routine, name: e.target.value })}
          placeholder="Program name"
        />
      </div>

      <div className="health-routine-log-date-row">
        <span className="muted">Logging for</span>
        {logDate !== iso(0) && (
          <button type="button" className="icon-btn" onClick={() => setLogDate(iso(0))} aria-label="Return to today" title="Return to today">
            <RotateCcw size={14} />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => setLogDate(shiftIso(logDate, -1))} aria-label="Previous day">
          <ChevronLeft size={16} />
        </button>
        <DatePicker value={logDate} onChange={setLogDate} markedDates={loggedDates} />
        <button type="button" className="icon-btn" onClick={() => setLogDate(shiftIso(logDate, 1))} aria-label="Next day">
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          className={`health-routine-logged-badge${loggedOnActiveDate ? ' logged' : ''}`}
          onClick={toggleLogged}
          title={loggedOnActiveDate ? 'Mark as not logged' : 'Mark as logged'}
        >
          {loggedOnActiveDate ? <CheckCircle2 size={16} /> : <Circle size={16} />}
          {loggedOnActiveDate ? 'Logged' : 'Not logged'}
        </button>
      </div>

      {activeDays.map((day, i) => (
        <RoutineDayCard
          key={day.id}
          day={day}
          accent={DAY_ACCENTS[i % DAY_ACCENTS.length]}
          entryByExerciseId={entryByExerciseId}
          onLogDate={exId => {
            const ex = day.exercises.find(e => e.id === exId);
            if (ex) logForDate(exId, ex.targetSets);
          }}
          onEditWeight={(exId, setIndex, w) => editWeight(exId, setIndex, w)}
          onEditLastReps={(exId, reps) => editLastReps(exId, reps)}
          onEditField={(exId, patch) => editExerciseField(day.id, exId, patch)}
          onDeleteExercise={exId => deleteExercise(day.id, exId)}
          onAddExercise={() => addExercise(day.id)}
          onEditDay={patch => patchDay(day.id, patch)}
          onDeleteDay={() => deleteDay(day.id)}
        />
      ))}
      <button type="button" className="btn ghost health-routine-add-day" onClick={addDay}><Plus size={16} /> Add day</button>

      <Card className="health-routine-notes">
        <div className="card-title"><div><h2>Progression Notes</h2></div></div>
        <RichTextEditor
          value={routine.progressionNotes ?? ''}
          onChange={v => void upsert('workoutRoutines', { ...routine, progressionNotes: v })}
          placeholder="e.g. Weeks 1-2: focus on form. Weeks 3-6: increase weight gradually."
        />
      </Card>
    </>
  );
}
