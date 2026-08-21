import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Kpi, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { NumberCell, NotesCell, OptionalNumberCell } from '../components/GridCells';
import { SortableTh, SortableThLabel, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import { HealthInsightList } from '../components/HealthInsights';
import { WorkoutRoutineSection } from '../components/WorkoutRoutineSection';
import { ListManagerModal } from '../components/ListManagerModal';
import { computeHealthInsights } from '../lib/healthInsights';
import { inRange } from '../lib/healthPeriod';
import type { HealthPeriodProps } from './HealthWellness';
import type { WorkoutEntry } from '../types';
import { WORKOUT_TYPES } from '../types';

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function currentStreak(workouts: WorkoutEntry[]): number {
  const days = new Set(workouts.map(w => w.date));
  let streak = 0;
  let cursor = 0;
  // Today doesn't break the streak if it just hasn't happened yet — only count backward
  // from today if today already has an entry, otherwise start from yesterday.
  if (!days.has(iso(0))) cursor = -1;
  while (days.has(iso(cursor))) { streak += 1; cursor -= 1; }
  return streak;
}

type WorkoutSortKey = 'date' | 'type' | 'duration';

export function HealthFitness({ period, range, periodLabel, activeDate, onActiveDateChange }: HealthPeriodProps) {
  const { data, upsert, remove, updateSettings } = useStore();
  const workouts = data.workouts;
  // Undefined settings.workoutTypes means "still on the default list" — only forked into
  // settings once the user actually adds/renames/deletes a type, same lazy pattern Finance
  // uses for custom debt types.
  const workoutTypes = data.settings.workoutTypes ?? WORKOUT_TYPES;
  const [manageTypesOpen, setManageTypesOpen] = useState(false);
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = workouts.find(w => w.id === editingId) ?? null;
  const inPeriod = workouts.filter(w => inRange(w.date, range));
  const activeMinutes = inPeriod.reduce((sum, w) => sum + w.durationMin, 0);
  const rpeEntries = inPeriod.filter(w => w.rpe != null);
  const avgRpe = rpeEntries.length ? rpeEntries.reduce((sum, w) => sum + (w.rpe ?? 0), 0) / rpeEntries.length : undefined;
  const streak = currentStreak(workouts);
  const showInsights = inRange(iso(0), range);
  const insights = showInsights ? computeHealthInsights(data).filter(i => i.pillar === 'Fitness') : [];

  const [sort, setSort] = useState<SortState<WorkoutSortKey>>({ key: 'date', dir: 'desc' });
  const sorted = inPeriod.slice().sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'date': cmp = a.date.localeCompare(b.date); break;
      case 'type': cmp = a.type.localeCompare(b.type); break;
      case 'duration': cmp = a.durationMin - b.durationMin; break;
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const patch = (w: WorkoutEntry, p: Partial<WorkoutEntry>) => void upsert('workouts', { ...w, ...p });
  // Defaults to whatever day is currently being viewed, not always "today" — otherwise adding
  // a row while browsing a past day/week silently creates a today-dated entry that's invisible
  // in the view you're looking at, and the button looks like it did nothing.
  const addWorkout = () => void upsert('workouts', newRecord<WorkoutEntry>({ date: activeDate, type: workoutTypes[0] ?? 'Run', durationMin: 30 }));

  const addWorkoutType = (name: string) => {
    if (workoutTypes.some(t => t.toLowerCase() === name.toLowerCase())) return;
    void updateSettings({ workoutTypes: [...workoutTypes, name] });
  };

  // Renaming propagates to every existing entry using the old label — unlike delete, a rename
  // is meant to replace the label everywhere, not leave history pointing at a name that no
  // longer exists in the picker.
  const renameWorkoutType = (oldName: string, nextName: string) => {
    void updateSettings({ workoutTypes: workoutTypes.map(t => (t === oldName ? nextName : t)) });
    for (const w of workouts) {
      if (w.type === oldName) void upsert('workouts', { ...w, type: nextName });
    }
  };

  const deleteWorkoutType = (name: string) => {
    void updateSettings({ workoutTypes: workoutTypes.filter(t => t !== name) });
  };

  return (
    <>
      <HealthInsightList insights={insights} />
      <div className="kpi-grid four">
        <Kpi label="Workouts" value={inPeriod.length} caption={periodLabel} tone="default" />
        <Kpi label="Active Minutes" value={activeMinutes} caption={periodLabel} tone="blue" />
        <Kpi label="Avg Exertion" value={avgRpe != null ? avgRpe.toFixed(1) : '—'} caption={`RPE, ${periodLabel} (1-10)`} tone="amber" />
        <Kpi label="Streak" value={streak} caption={streak === 1 ? 'day in a row' : 'days in a row'} tone={streak > 0 ? 'green' : 'default'} />
      </div>

      <h2 className="grid-section-title">Fitness Log</h2>
      {isMobile ? (
        <>
          <MobileRecordList
            items={sorted}
            primary={w => w.type}
            secondary={w => formatDate(w.date)}
            trailing={w => `${w.durationMin}m`}
            fields={[
              { label: 'RPE', value: w => w.rpe ?? '—' },
              { label: 'Load', value: w => (w.rpe != null ? Math.round(w.durationMin * w.rpe) : '—') }
            ]}
            onOpen={w => setEditingId(w.id)}
            onDelete={w => void remove('workouts', w.id)}
            deleteLabel={w => `Delete ${w.type}`}
            empty="No workouts logged in this period."
          />
          {editing && (
            <Sheet title={editing.type} onClose={() => setEditingId(null)}>
              <div className="sheet-form">
                <label><span>Date</span><DatePicker value={editing.date} onChange={v => patch(editing, { date: v })} /></label>
                <label>
                  <span>Type</span>
                  <select value={editing.type} onChange={e => patch(editing, { type: e.target.value })}>
                    {(workoutTypes.includes(editing.type) ? workoutTypes : [editing.type, ...workoutTypes]).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label><span>Duration (min)</span><input type="number" inputMode="numeric" value={editing.durationMin} onChange={e => patch(editing, { durationMin: Number(e.target.value) })} /></label>
                <label><span>Avg HR (bpm)</span><input type="number" inputMode="numeric" value={editing.avgHr ?? ''} onChange={e => patch(editing, { avgHr: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Max HR (bpm)</span><input type="number" inputMode="numeric" value={editing.maxHr ?? ''} onChange={e => patch(editing, { maxHr: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>RPE (1–10)</span><input type="number" inputMode="numeric" min={0} max={10} value={editing.rpe ?? ''} onChange={e => patch(editing, { rpe: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Calories (kcal)</span><input type="number" inputMode="numeric" value={editing.caloriesBurned ?? ''} onChange={e => patch(editing, { caloriesBurned: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Notes</span><textarea rows={3} value={editing.notes ?? ''} onChange={e => patch(editing, { notes: e.target.value })} /></label>
              </div>
            </Sheet>
          )}
        </>
      ) : (
      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <SortableTh label="Date" sortKey="date" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
              <th>
                <SortableThLabel label="Type" sortKey="type" state={sort} onSort={k => setSort(s => toggleSort(s, k))} />
                <button type="button" className="col-edit-btn" onClick={() => setManageTypesOpen(true)} aria-label="Manage workout types" title="Add, rename, or remove workout types">
                  <Pencil size={11} />
                </button>
              </th>
              <SortableTh label="Duration" sortKey="duration" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
              <th>Avg HR</th>
              <th>Max HR</th>
              <th>RPE</th>
              <th>Calories</th>
              <th>Load<br /><small>Computed</small></th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(w => {
              const load = w.rpe != null ? Math.round(w.durationMin * w.rpe) : undefined;
              return (
                <tr key={w.id}>
                  <td><DatePicker value={w.date} onChange={v => patch(w, { date: v })} /></td>
                  <td>
                    <select className="grid-cell-select" value={w.type} onChange={e => patch(w, { type: e.target.value })}>
                      {/* The row's own current type may have been deleted from the picklist since
                          it was set — keep it selectable so the cell doesn't silently jump to a
                          different value out from under an untouched row. */}
                      {(workoutTypes.includes(w.type) ? workoutTypes : [w.type, ...workoutTypes]).map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </td>
                  <td className="grid-td-compact"><NumberCell value={w.durationMin} onChange={n => patch(w, { durationMin: n })} /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={w.avgHr} onChange={n => patch(w, { avgHr: n })} placeholder="bpm" /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={w.maxHr} onChange={n => patch(w, { maxHr: n })} placeholder="bpm" /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={w.rpe} onChange={n => patch(w, { rpe: n })} placeholder="1-10" /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={w.caloriesBurned} onChange={n => patch(w, { caloriesBurned: n })} placeholder="kcal" /></td>
                  <td className="grid-computed-cell">{load ?? '—'}</td>
                  <td><NotesCell value={w.notes ?? ''} onChange={v => patch(w, { notes: v })} /></td>
                  <td><button type="button" className="icon-btn danger" onClick={() => void remove('workouts', w.id)} aria-label="Delete workout"><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sorted.length && <p className="muted grid-table-empty">No workouts logged for {period === 'Day' ? 'this day' : `this ${period.toLowerCase()}`}.</p>}
      </div>
      )}
      <button type="button" className="btn teal grid-add-row" onClick={addWorkout}><Plus size={16} /> Add workout</button>

      <WorkoutRoutineSection activeDate={activeDate} onActiveDateChange={onActiveDateChange} />

      {manageTypesOpen && (
        <ListManagerModal
          title="Manage workout types"
          subtitle="Rename or delete the types shown in the Type dropdown. Deleting a type doesn't change any logged workouts that already used it."
          items={workoutTypes.map(t => ({ id: t, label: t }))}
          onAdd={addWorkoutType}
          onRename={renameWorkoutType}
          onDelete={deleteWorkoutType}
          onClose={() => setManageTypesOpen(false)}
          addPlaceholder="New type…"
        />
      )}
    </>
  );
}
