import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Badge, Kpi, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { TimeWheelPicker } from '../components/TimeWheelPicker';
import { NumberCell, NotesCell, OptionalNumberCell } from '../components/GridCells';
import { SortableTh, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { inRange } from '../lib/healthPeriod';
import type { HealthPeriodProps } from './HealthWellness';
import type { SleepEntry } from '../types';

// Bed/wake times are "HH:mm" 24h strings — a wake time earlier than bed time means it
// crossed midnight, so that case wraps forward a full day rather than going negative.
function computeSleepDuration(bedTime?: string, wakeTime?: string): number | undefined {
  if (!bedTime || !wakeTime) return undefined;
  const [bh, bm] = bedTime.split(':').map(Number);
  const [wh, wm] = wakeTime.split(':').map(Number);
  if ([bh, bm, wh, wm].some(n => Number.isNaN(n))) return undefined;
  let minutes = (wh * 60 + wm) - (bh * 60 + bm);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 10) / 10;
}

type SleepSortKey = 'date' | 'duration' | 'quality';

export function HealthSleep({ period, range, periodLabel, activeDate }: HealthPeriodProps) {
  const { data, upsert, remove } = useStore();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  const entries = data.sleepEntries;
  const target = data.settings.sleepTargetHours ?? 8;
  const inPeriod = entries.filter(e => inRange(e.date, range));
  const lastNight = entries.slice().sort((a, b) => b.date.localeCompare(a.date))[0];

  const avgDuration = inPeriod.length ? inPeriod.reduce((sum, e) => sum + e.durationHours, 0) / inPeriod.length : undefined;
  const sleepDebt = inPeriod.length ? Math.max(0, Math.round((target * inPeriod.length - inPeriod.reduce((sum, e) => sum + e.durationHours, 0)) * 10) / 10) : undefined;
  const qualityEntries = inPeriod.filter(e => e.quality != null);
  const avgQuality = qualityEntries.length ? qualityEntries.reduce((sum, e) => sum + (e.quality ?? 0), 0) / qualityEntries.length : undefined;

  const editing = entries.find(e => e.id === editingId) ?? null;
  const [sort, setSort] = useState<SortState<SleepSortKey>>({ key: 'date', dir: 'desc' });
  const sorted = inPeriod.slice().sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'date': cmp = a.date.localeCompare(b.date); break;
      case 'duration': cmp = a.durationHours - b.durationHours; break;
      case 'quality': cmp = (a.quality ?? 0) - (b.quality ?? 0); break;
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const patch = (e: SleepEntry, p: Partial<SleepEntry>) => void upsert('sleepEntries', { ...e, ...p });

  // Bed/wake time edits recompute duration automatically; a direct duration edit only applies
  // when there's no time pair driving it (otherwise the next time tweak would just overwrite it).
  const patchTime = (e: SleepEntry, field: 'bedTime' | 'wakeTime', value: string) => {
    const next: SleepEntry = { ...e, [field]: value || undefined };
    const duration = computeSleepDuration(next.bedTime, next.wakeTime);
    if (duration != null) next.durationHours = duration;
    void upsert('sleepEntries', next);
  };

  // Defaults to whatever day is currently being viewed, not always "today" — otherwise adding
  // a row while browsing a past day/week silently creates a today-dated entry that's invisible
  // in the view you're looking at, and the button looks like it did nothing.
  const addEntry = () => void upsert('sleepEntries', newRecord<SleepEntry>({ date: activeDate, durationHours: target }));

  return (
    <>
      <div className="kpi-grid four">
        <Kpi label="Last Night" value={lastNight ? `${lastNight.durationHours}h` : '—'} caption={lastNight ? formatDate(lastNight.date) : 'no entries yet'} tone="default" />
        <Kpi label="Avg Duration" value={avgDuration != null ? `${avgDuration.toFixed(1)}h` : '—'} caption={`target ${target}h · ${periodLabel}`} tone={avgDuration != null && avgDuration >= target ? 'green' : 'amber'} />
        <Kpi label="Sleep Debt" value={sleepDebt != null ? `${sleepDebt}h` : '—'} caption={`deficit, ${periodLabel}`} tone={sleepDebt != null && sleepDebt > 3 ? 'red' : 'default'} />
        <Kpi label="Avg Quality" value={avgQuality != null ? avgQuality.toFixed(1) : '—'} caption={`out of 10, ${periodLabel}`} tone="blue" />
      </div>

      {isMobile ? (
        <>
          <MobileRecordList
            items={sorted}
            primary={e => formatDate(e.date)}
            secondary={e => (e.bedTime && e.wakeTime ? `${e.bedTime} – ${e.wakeTime}` : 'No times logged')}
            trailing={e => `${computeSleepDuration(e.bedTime, e.wakeTime) ?? e.durationHours}h`}
            trailingTone={e => ((computeSleepDuration(e.bedTime, e.wakeTime) ?? e.durationHours) >= target ? 'positive' : undefined)}
            fields={[
              { label: 'Quality', value: e => (e.quality != null ? `${e.quality}/10` : '—') },
              { label: 'vs Target', value: e => {
                const d = Math.round(((computeSleepDuration(e.bedTime, e.wakeTime) ?? e.durationHours) - target) * 10) / 10;
                return `${d > 0 ? '+' : ''}${d}h`;
              } }
            ]}
            onOpen={e => setEditingId(e.id)}
            onDelete={e => void remove('sleepEntries', e.id)}
            deleteLabel={e => `Delete ${formatDate(e.date)}`}
            empty="No nights logged in this period."
          />
          {editing && (
            <Sheet title={formatDate(editing.date)} onClose={() => setEditingId(null)}>
              <div className="sheet-form">
                <label><span>Date</span><DatePicker value={editing.date} onChange={v => patch(editing, { date: v })} /></label>
                <label><span>Bed time</span><TimeWheelPicker value={editing.bedTime} onChange={v => patchTime(editing, 'bedTime', v)} placeholder="Bed time" /></label>
                <label><span>Wake time</span><TimeWheelPicker value={editing.wakeTime} onChange={v => patchTime(editing, 'wakeTime', v)} placeholder="Wake time" /></label>
                {computeSleepDuration(editing.bedTime, editing.wakeTime) == null && (
                  <label>
                    <span>Duration (hours)</span>
                    <input type="number" inputMode="decimal" step="0.1" value={editing.durationHours} onChange={e => patch(editing, { durationHours: Number(e.target.value) })} />
                  </label>
                )}
                <label><span>Quality (1–10)</span><input type="number" inputMode="numeric" min={0} max={10} value={editing.quality ?? ''} onChange={e => patch(editing, { quality: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>REM (hours)</span><input type="number" inputMode="decimal" step="0.1" value={editing.remHours ?? ''} onChange={e => patch(editing, { remHours: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Deep (hours)</span><input type="number" inputMode="decimal" step="0.1" value={editing.deepHours ?? ''} onChange={e => patch(editing, { deepHours: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Resting HR (bpm)</span><input type="number" inputMode="numeric" value={editing.restingHr ?? ''} onChange={e => patch(editing, { restingHr: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
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
              <th>Bed Time</th>
              <th>Wake Time</th>
              <SortableTh label="Duration" sortKey="duration" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
              <SortableTh label="Quality" sortKey="quality" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
              <th>REM</th>
              <th>Deep</th>
              <th>Resting HR</th>
              <th>vs Target<br /><small>Computed</small></th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(e => {
              const diff = Math.round((e.durationHours - target) * 10) / 10;
              const autoDuration = computeSleepDuration(e.bedTime, e.wakeTime);
              return (
                <tr key={e.id}>
                  <td><DatePicker value={e.date} onChange={v => patch(e, { date: v })} /></td>
                  <td><TimeWheelPicker value={e.bedTime} onChange={v => patchTime(e, 'bedTime', v)} placeholder="Bed time" /></td>
                  <td><TimeWheelPicker value={e.wakeTime} onChange={v => patchTime(e, 'wakeTime', v)} placeholder="Wake time" /></td>
                  <td className="grid-td-compact">
                    {autoDuration != null ? (
                      <span className="grid-computed-cell" title="Calculated from bed and wake time">{autoDuration}h</span>
                    ) : (
                      <NumberCell value={e.durationHours} onChange={n => patch(e, { durationHours: n })} />
                    )}
                  </td>
                  <td className="grid-td-compact"><OptionalNumberCell value={e.quality} onChange={n => patch(e, { quality: n })} placeholder="1-10" min={0} max={10} /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={e.remHours} onChange={n => patch(e, { remHours: n })} placeholder="hrs" min={0} max={8} /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={e.deepHours} onChange={n => patch(e, { deepHours: n })} placeholder="hrs" min={0} max={8} /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={e.restingHr} onChange={n => patch(e, { restingHr: n })} placeholder="bpm" /></td>
                  <td><Badge tone={diff >= 0 ? 'success' : 'warning'}>{diff > 0 ? '+' : ''}{diff}h</Badge></td>
                  <td><NotesCell value={e.notes ?? ''} onChange={v => patch(e, { notes: v })} /></td>
                  <td><button type="button" className="icon-btn danger" onClick={() => void remove('sleepEntries', e.id)} aria-label="Delete night"><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sorted.length && <p className="muted grid-table-empty">No nights logged for {period === 'Day' ? 'this day' : `this ${period.toLowerCase()}`}.</p>}
      </div>
      )}
      <button type="button" className="btn teal grid-add-row" onClick={addEntry}><Plus size={16} /> Add night</button>
    </>
  );
}
