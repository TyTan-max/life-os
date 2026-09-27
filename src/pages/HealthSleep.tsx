import { useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Badge, Card, Kpi, formatDate } from '../components/UI';
import { SleepTrendChart } from '../components/SleepTrendChart';
import { DatePicker } from '../components/DatePicker';
import { TimeWheelPicker } from '../components/TimeWheelPicker';
import { NumberCell, NotesCell, OptionalNumberCell } from '../components/GridCells';
import { SortableTh, SortableThLabel, toggleSort } from '../components/SortableTh';
import { InfoTip } from '../components/InfoTip';
import type { SortState } from '../components/SortableTh';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { EntrySheetFooter, useAutoAdd } from '../components/EntrySheetFooter';
import { useIsMobile } from '../hooks/useIsMobile';
import { inRange, sleepRecencyLabel } from '../lib/healthPeriod';
import type { HealthPeriodProps } from './HealthWellness';
import type { SleepEntry } from '../types';
import { computeSleepDuration, latestNight, sleepHours, usualSleepTimes } from '../lib/sleep';

// The Quality ⓘ: one consistent way to rate a night, so scores compare night to night.
const QUALITY_GUIDE = (
  <div className="quality-guide">
    <b>Rate it when you wake up</b>
    <p>Within ~30 minutes of getting up: how rested you feel and how the night went. Not how tired you are later — caffeine, workouts and stress muddy that.</p>
    <table>
      <tbody>
        <tr><th>9–10</th><td>Fell asleep easily, barely woke, woke refreshed</td></tr>
        <tr><th>7–8</th><td>Good — woke once or twice, briefly groggy</td></tr>
        <tr><th>5–6</th><td>OK — slow to fall asleep or woke several times</td></tr>
        <tr><th>3–4</th><td>Poor — restless, woke tired or with a headache</td></tr>
        <tr><th>1–2</th><td>Barely slept, or woke exhausted</td></tr>
      </tbody>
    </table>
    <p className="quality-guide-q">Quick check: fell asleep quickly? Stayed asleep? Feel rested now? All yes ≈ 9 · mostly yes ≈ 7 · mostly no ≈ 4 or lower.</p>
  </div>
);

type SleepSortKey = 'date' | 'duration' | 'quality';

export function HealthSleep({ period, range, periodLabel, activeDate, autoAdd, onAutoAdded }: HealthPeriodProps & { autoAdd?: boolean; onAutoAdded?: () => void }) {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  const [editingId, setEditingId] = useState<string | null>(null);
  // Trend window (7 or 30 nights), ending at the viewed period's end — or today, if that's sooner.
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const todayIso = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const trendEnd = range.end < todayIso ? range.end : todayIso;
  // The sleep target was fixed at 8h with nowhere to change it; it drives the target line, the
  // debt and every at/below-target colour. Edited as text, committed on blur/Enter, kept 4–12h.
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const commitTarget = () => {
    if (targetDraft == null) return;
    const n = Number(targetDraft);
    if (targetDraft.trim() !== '' && Number.isFinite(n)) {
      void updateSettings({ sleepTargetHours: Math.min(12, Math.max(4, Math.round(n * 2) / 2)) });
    }
    setTargetDraft(null);
  };
  // The entry Add just created, while its sheet is still open for the first time.
  const [newId, setNewId] = useState<string | null>(null);
  const closeSheet = () => { setEditingId(null); setNewId(null); };
  const entries = data.sleepEntries;
  const target = data.settings.sleepTargetHours ?? 8;
  const inPeriod = entries.filter(e => inRange(e.date, range));
  const lastNight = latestNight(entries);
  // REM, Deep and resting HR only come from a sleep tracker. Their columns/fields stay tucked
  // away until any night has one of them (or you open them), so a log kept by hand isn't three
  // permanently-empty columns wide.
  const [showTrackerFields, setShowTrackerFields] = useState(false);
  const hasTrackerData = entries.some(e => e.remHours != null || e.deepHours != null || e.restingHr != null);
  const showTracker = showTrackerFields || hasTrackerData;

  const avgDuration = inPeriod.length ? inPeriod.reduce((sum, e) => sum + sleepHours(e), 0) / inPeriod.length : undefined;
  const sleepDebt = inPeriod.length ? Math.max(0, Math.round((target * inPeriod.length - inPeriod.reduce((sum, e) => sum + sleepHours(e), 0)) * 10) / 10) : undefined;
  const qualityEntries = inPeriod.filter(e => e.quality != null);
  const avgQuality = qualityEntries.length ? qualityEntries.reduce((sum, e) => sum + (e.quality ?? 0), 0) / qualityEntries.length : undefined;

  const editing = entries.find(e => e.id === editingId) ?? null;
  const [sort, setSort] = useState<SortState<SleepSortKey>>({ key: 'date', dir: 'desc' });
  const sorted = inPeriod.slice().sort((a, b) => {
    let cmp = 0;
    switch (sort.key) {
      case 'date': cmp = a.date.localeCompare(b.date); break;
      case 'duration': cmp = sleepHours(a) - sleepHours(b); break;
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
  // On a phone the new entry opens straight into its sheet — otherwise it silently logged an
  // 8h night (the target) that you then had to find and correct.
  // A new night starts from your usual bed and wake time (median of the last 7 nights), so a
  // typical night is logged by just adding it; falls back to the target length with no times.
  const usual = usualSleepTimes(entries);
  const addEntry = () => {
    const record = newRecord<SleepEntry>(usual
      ? { date: activeDate, bedTime: usual.bedTime, wakeTime: usual.wakeTime, durationHours: computeSleepDuration(usual.bedTime, usual.wakeTime) ?? target }
      : { date: activeDate, durationHours: target });
    void upsert('sleepEntries', record);
    if (isMobile) { setNewId(record.id); setEditingId(record.id); }
  };
  // Copies what you know about last night — times, length, quality. Not REM, Deep or resting HR:
  // those are tracker measurements of that one night, and copying them forward would fill the log
  // with numbers nobody measured. Notes are left off too.
  const copyLastNight = () => {
    if (!lastNight) return;
    const record = newRecord<SleepEntry>({
      date: activeDate, bedTime: lastNight.bedTime, wakeTime: lastNight.wakeTime, durationHours: lastNight.durationHours,
      quality: lastNight.quality
    });
    void upsert('sleepEntries', record);
    if (isMobile) { setNewId(record.id); setEditingId(record.id); }
  };
  useAutoAdd(autoAdd, addEntry, onAutoAdded);

  return (
    <>
      <div className="kpi-grid four">
        <Kpi
          label={sleepRecencyLabel(lastNight?.date) === 'last night' ? 'Last Night' : 'Latest Night'}
          value={lastNight ? `${sleepHours(lastNight)}h` : '—'}
          caption={lastNight ? formatDate(lastNight.date) : 'no entries yet'}
          tone="default"
        />
        <Kpi label="Avg Duration" value={avgDuration != null ? `${avgDuration.toFixed(1)}h` : '—'} caption={`target ${target}h · ${periodLabel}`} tone={avgDuration != null && avgDuration >= target ? 'green' : 'amber'} />
        <Kpi label="Sleep Debt" value={sleepDebt != null ? `${sleepDebt}h` : '—'} caption={`deficit, ${periodLabel}`} tone={sleepDebt != null && sleepDebt > 3 ? 'red' : 'default'} />
        <Kpi label="Avg Quality" value={avgQuality != null ? avgQuality.toFixed(1) : '—'} caption={`out of 10, ${periodLabel}`} tone="blue" />
      </div>

      <Card className="sleep-trend-card">
        <div className="card-title">
          <div><h2>Sleep trend</h2></div>
          <div className="sleep-trend-controls">
            <label className="sleep-target-field">
              <span>Target</span>
              <input
                type="number"
                inputMode="decimal"
                step={0.5}
                min={4}
                max={12}
                value={targetDraft ?? String(target)}
                onChange={e => setTargetDraft(e.target.value)}
                onBlur={commitTarget}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                aria-label="Sleep target in hours"
              />
              <span>h</span>
            </label>
            <div className="segmented">
              {([7, 30] as const).map(n => (
                <button type="button" key={n} className={trendDays === n ? 'on' : ''} onClick={() => setTrendDays(n)}>{n} nights</button>
              ))}
            </div>
          </div>
        </div>
        <SleepTrendChart entries={entries} target={target} days={trendDays} endDate={trendEnd} />
      </Card>

      {isMobile ? (
        <>
          <MobileRecordList
            items={sorted}
            primary={e => formatDate(e.date)}
            secondary={e => (e.bedTime && e.wakeTime ? `${e.bedTime} – ${e.wakeTime}` : 'No times logged')}
            trailing={e => `${sleepHours(e)}h`}
            trailingTone={e => (sleepHours(e) >= target ? 'positive' : undefined)}
            fields={[
              { label: 'Quality', value: e => (e.quality != null ? `${e.quality}/10` : '—') },
              { label: 'vs Target', value: e => {
                const d = Math.round((sleepHours(e) - target) * 10) / 10;
                return `${d > 0 ? '+' : ''}${d}h`;
              } }
            ]}
            onOpen={e => setEditingId(e.id)}
            onDelete={e => void remove('sleepEntries', e.id)}
            deleteLabel={e => `Delete ${formatDate(e.date)}`}
            empty="No nights logged in this period."
          />
          {editing && (
            <Sheet
              title={editing.id === newId ? 'Log a night' : formatDate(editing.date)}
              onClose={closeSheet}
              footer={<EntrySheetFooter
                isNew={editing.id === newId}
                onRemove={() => { void remove('sleepEntries', editing.id); closeSheet(); }}
                onDone={closeSheet}
              />}
            >
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
                <label><span className="label-with-info">Quality (1–10) <InfoTip label="How to rate sleep quality">{QUALITY_GUIDE}</InfoTip></span><input type="number" inputMode="numeric" min={0} max={10} value={editing.quality ?? ''} onChange={e => patch(editing, { quality: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                {showTracker ? <>
                  <label><span>REM (hours)</span><input type="number" inputMode="decimal" step="0.1" value={editing.remHours ?? ''} onChange={e => patch(editing, { remHours: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                  <label><span>Deep (hours)</span><input type="number" inputMode="decimal" step="0.1" value={editing.deepHours ?? ''} onChange={e => patch(editing, { deepHours: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                  <label><span>Resting HR (bpm)</span><input type="number" inputMode="numeric" value={editing.restingHr ?? ''} onChange={e => patch(editing, { restingHr: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                </> : (
                  <button type="button" className="text-btn sleep-tracker-toggle" onClick={() => setShowTrackerFields(true)}>
                    <Plus size={14} /> Add tracker data (REM, Deep, resting HR)
                  </button>
                )}
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
              <th className="sortable-th">
                <span className="th-with-info">
                  <SortableThLabel label="Quality" sortKey="quality" state={sort} onSort={k => setSort(s => toggleSort(s, k, 'desc'))} />
                  <InfoTip label="How to rate sleep quality">{QUALITY_GUIDE}</InfoTip>
                </span>
              </th>
              {showTracker && <>
                <th>REM</th>
                <th>Deep</th>
                <th>Resting HR</th>
              </>}
              <th>vs Target<br /><small>Computed</small></th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(e => {
              const diff = Math.round((sleepHours(e) - target) * 10) / 10;
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
                  {showTracker && <>
                    <td className="grid-td-compact"><OptionalNumberCell value={e.remHours} onChange={n => patch(e, { remHours: n })} placeholder="hrs" min={0} max={8} /></td>
                    <td className="grid-td-compact"><OptionalNumberCell value={e.deepHours} onChange={n => patch(e, { deepHours: n })} placeholder="hrs" min={0} max={8} /></td>
                    <td className="grid-td-compact"><OptionalNumberCell value={e.restingHr} onChange={n => patch(e, { restingHr: n })} placeholder="bpm" /></td>
                  </>}
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
      <div className="grid-add-row-group">
        <button
          type="button"
          className="btn teal grid-add-row"
          onClick={addEntry}
          title={usual ? `Starts from your usual ${usual.bedTime} → ${usual.wakeTime}` : undefined}
        >
          <Plus size={16} /> Add night
        </button>
        {lastNight && (
          <button
            type="button"
            className="btn ghost grid-add-row"
            onClick={copyLastNight}
            title={`Copies ${formatDate(lastNight.date)}: ${sleepHours(lastNight)}h${lastNight.quality != null ? `, quality ${lastNight.quality}/10` : ''}`}
          >
            <Copy size={15} /> Same as last night
          </button>
        )}
        {/* Desktop table: open or close the tracker columns. Once any night has tracker data they
            stay open (hiding them would hide real numbers). */}
        {!isMobile && !hasTrackerData && (
          <button type="button" className="text-btn sleep-tracker-toggle" onClick={() => setShowTrackerFields(s => !s)}>
            {showTrackerFields ? 'Hide tracker columns' : <><Plus size={14} /> Tracker data (REM, Deep, resting HR)</>}
          </button>
        )}
      </div>
    </>
  );
}
