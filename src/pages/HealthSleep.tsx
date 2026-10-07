import { Fragment, useState } from 'react';
import { Copy, Moon, Plus, Sun, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Badge, Card, Kpi, formatDate } from '../components/UI';
import { SleepTrendChart } from '../components/SleepTrendChart';
import { DatePicker } from '../components/DatePicker';
import { TimeWheelPicker } from '../components/TimeWheelPicker';
import { InfoTip } from '../components/InfoTip';
import { DetailPanel } from '../components/DetailPanel';
import { SwipeRow } from '../components/SwipeRow';
import { useAutoAdd } from '../components/EntrySheetFooter';
import { useIsMobile } from '../hooks/useIsMobile';
import { inRange, sleepRecencyLabel } from '../lib/healthPeriod';
import type { HealthPeriodProps } from './HealthWellness';
import type { SleepEntry } from '../types';
import { computeSleepDuration, computeSleepMinutes, formatHours, isNap, lastNightOf, nightsOf, sleepDebtOf, sleepHours, sleepMinutes, usualSleepTimes } from '../lib/sleep';
import type { SleepNight } from '../lib/sleep';

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

interface DayGroup { date: string; night?: SleepNight; pieces: SleepEntry[]; naps: SleepEntry[] }

// "22:45" → "10:45 pm"
function to12h(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// The row timeline covers 6 pm → noon, so every night lines up on the same scale.
const BAR_START = 18 * 60;
const BAR_SPAN = 18 * 60;
function barPos(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return Math.min(1, Math.max(0, (((h * 60 + m) - BAR_START + 1440) % 1440) / BAR_SPAN));
}
// Time awake between two pieces of a night (wake of one → bed of the next).
function gapHours(prev: SleepEntry, next: SleepEntry): number | undefined {
  if (!prev.wakeTime || !next.bedTime) return undefined;
  const mins = computeSleepMinutes(prev.wakeTime, next.bedTime);
  return mins != null && mins < 12 * 60 ? mins / 60 : undefined;
}

export function HealthSleep({ period, range, periodLabel, activeDate, autoAdd, onAutoAdded }: HealthPeriodProps & { autoAdd?: boolean; onAutoAdded?: () => void }) {
  const { data, upsert, remove, updateSettings } = useStore();
  const isMobile = useIsMobile();
  // The night open in the edit panel (by date — a night can be several entries).
  const [editingDate, setEditingDate] = useState<string | null>(null);
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
  const closeEditor = () => setEditingDate(null);
  const entries = data.sleepEntries;
  const target = data.settings.sleepTargetHours ?? 8;
  const inPeriod = entries.filter(e => inRange(e.date, range));
  // Stats are per night: pieces of one night add up, naps are kept apart (see lib/sleep).
  const lastNight = lastNightOf(entries);
  const periodNights = nightsOf(inPeriod);
  const nightByDate = new Map(nightsOf(entries).map(n => [n.date, n]));
  const periodNaps = inPeriod.filter(isNap);
  const weekAgo = (() => { const d = new Date(`${todayIso}T12:00:00`); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
  const napsThisWeek = entries.filter(e => isNap(e) && e.date > weekAgo && e.date <= todayIso).length;
  // REM, Deep and resting HR only come from a sleep tracker. Their columns/fields stay tucked
  // away until any night has one of them (or you open them), so a log kept by hand isn't three
  // permanently-empty columns wide.
  const [showTrackerFields, setShowTrackerFields] = useState(false);
  const hasTrackerData = entries.some(e => e.remHours != null || e.deepHours != null || e.restingHr != null);
  const showTracker = showTrackerFields || hasTrackerData;

  const avgDuration = periodNights.length ? periodNights.reduce((sum, n) => sum + n.hours, 0) / periodNights.length : undefined;
  // Naps pay back part of the debt, though they don't count as night sleep.
  const sleepDebt = sleepDebtOf(inPeriod, target);
  const ratedNights = periodNights.filter(n => n.quality != null);
  const avgQuality = ratedNights.length ? ratedNights.reduce((sum, n) => sum + (n.quality ?? 0), 0) / ratedNights.length : undefined;

  // One group per day: the night (its pieces, in the order slept) and any naps. Sorting works on
  // whole nights, so pieces always stay together under their night.
  const groups: DayGroup[] = (() => {
    const byDate = new Map<string, DayGroup>();
    for (const e of inPeriod) {
      if (!byDate.has(e.date)) byDate.set(e.date, { date: e.date, pieces: [], naps: [] });
      if (isNap(e)) byDate.get(e.date)!.naps.push(e);
    }
    for (const g of byDate.values()) {
      g.night = nightByDate.get(g.date);
      g.pieces = g.night?.pieces ?? [];
      g.naps.sort((a, b) => (a.bedTime ?? '').localeCompare(b.bedTime ?? ''));
    }
    return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  })();

  const patch = (e: SleepEntry, p: Partial<SleepEntry>) => void upsert('sleepEntries', { ...e, ...p });

  // Bed/wake time edits recompute duration automatically; a direct duration edit only applies
  // when there's no time pair driving it (otherwise the next time tweak would just overwrite it).
  const patchTime = (e: SleepEntry, field: 'bedTime' | 'wakeTime', value: string) => {
    const next: SleepEntry = { ...e, [field]: value || undefined };
    // Whether it's night sleep or a nap is never guessed from the time — an evening crash at 6 pm
    // is still sleep. It's a nap only if added with "Add nap" or switched with the moon/sun button.
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
  const usual = usualSleepTimes(nightsOf(entries));
  const addEntry = (date = activeDate) => {
    const record = newRecord<SleepEntry>(usual
      ? { date, bedTime: usual.bedTime, wakeTime: usual.wakeTime, durationHours: computeSleepDuration(usual.bedTime, usual.wakeTime) ?? target }
      : { date, durationHours: target });
    void upsert('sleepEntries', record);
    setEditingDate(record.date);
  };
  // Copies what you know about last night — times, length, quality. Not REM, Deep or resting HR:
  // those are tracker measurements of that one night, and copying them forward would fill the log
  // with numbers nobody measured. Notes are left off too.
  // A night that was logged in pieces copies as its total, without times (one piece spanning
  // first bed → last wake would count the awake gap as sleep).
  const copyLastNight = () => {
    if (!lastNight) return;
    const single = lastNight.pieces.length === 1;
    const record = newRecord<SleepEntry>({
      date: activeDate, bedTime: single ? lastNight.bedTime : undefined, wakeTime: single ? lastNight.wakeTime : undefined,
      durationHours: lastNight.hours, quality: lastNight.quality
    });
    void upsert('sleepEntries', record);
    setEditingDate(record.date);
  };
  // Back asleep after waking: another piece of the same night, starting when this one ended.
  const addAnotherPiece = (e: SleepEntry) => {
    const wake = usual?.wakeTime;
    const len = e.wakeTime && wake ? computeSleepDuration(e.wakeTime, wake) : undefined;
    const ok = len != null && len > 0 && len <= 12;
    const record = newRecord<SleepEntry>({
      date: e.date, bedTime: e.wakeTime, wakeTime: ok ? wake : undefined, durationHours: ok ? len! : 0, nap: false
    });
    void upsert('sleepEntries', record);
    setEditingDate(record.date);
  };
  const addNap = (date = activeDate) => {
    const record = newRecord<SleepEntry>({ date, bedTime: '14:00', wakeTime: '14:45', durationHours: 0.8, nap: true });
    void upsert('sleepEntries', record);
    setEditingDate(record.date);
  };
  const vsTarget = (hours: number) => {
    const d = Math.round((hours - target) * 10) / 10;
    return <Badge tone={d >= 0 ? 'success' : 'warning'}>{d > 0 ? '+' : ''}{d}h</Badge>;
  };
  // Quality and notes belong to the night: kept on its first piece.
  const setNightQuality = (g: DayGroup, q: number | undefined) => {
    g.pieces.forEach((piece, i) => { if (i === 0 ? piece.quality !== q : piece.quality != null) patch(piece, { quality: i === 0 ? q : undefined }); });
  };
  const moveDay = (g: DayGroup, date: string) => { for (const e of [...g.pieces, ...g.naps]) patch(e, { date }); };
  // The timeline for one night: sleep in solid, the awake gaps as the faint track between.
  const timelineBar = (g: DayGroup) => {
    const timed = g.pieces.filter(pc => pc.bedTime && pc.wakeTime);
    if (!timed.length) return <span className="sleep-bar-empty">{g.pieces.length ? 'no times' : ''}</span>;
    const start = barPos(timed[0].bedTime!); const end = barPos(timed[timed.length - 1].wakeTime!);
    return (
      <span className="sleep-bar">
        {end > start && <u style={{ left: `${start * 100}%`, width: `${(end - start) * 100}%` }} />}
        {timed.map(pc => {
          const a = barPos(pc.bedTime!); const b = barPos(pc.wakeTime!);
          return b > a ? <i key={pc.id} style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} title={`${to12h(pc.bedTime!)} – ${to12h(pc.wakeTime!)}`} /> : null;
        })}
      </span>
    );
  };
  const weekday = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' });
  useAutoAdd(autoAdd, () => addEntry(), onAutoAdded);

  return (
    <>
      <div className="kpi-grid four">
        <Kpi
          label={sleepRecencyLabel(lastNight?.date) === 'last night' ? 'Last Night' : 'Latest Night'}
          value={lastNight ? `${lastNight.hours}h` : '—'}
          caption={lastNight ? `${formatDate(lastNight.date)}${lastNight.awakeHours ? ` · awake ${formatHours(lastNight.awakeHours)} in the middle` : ''}${lastNight.naps ? ` · + ${formatHours(lastNight.napHours)} nap` : ''}` : 'no entries yet'}
          tone="default"
        />
        <Kpi label="Avg Duration" value={avgDuration != null ? `${avgDuration.toFixed(1)}h` : '—'} caption={`target ${target}h · ${periodLabel}`} tone={avgDuration != null && avgDuration >= target ? 'green' : 'amber'} />
        <Kpi label="Sleep Debt" value={sleepDebt != null ? `${sleepDebt}h` : '—'} caption={`deficit, ${periodLabel}`} tone={sleepDebt != null && sleepDebt > 3 ? 'red' : 'default'} />
        <Kpi label="Avg Quality" value={avgQuality != null ? avgQuality.toFixed(1) : '—'} caption={`out of 10, ${periodLabel}`} tone="blue" />
      </div>

      {(periodNaps.length > 0 || napsThisWeek >= 3) && (
        <p className={`sleep-naps-line ${napsThisWeek >= 3 ? 'warn' : ''}`}>
          <Sun size={14} />
          {periodNaps.length > 0 && <span><b>{periodNaps.length} nap{periodNaps.length === 1 ? '' : 's'}</b> · {formatHours(periodNaps.reduce((s, n) => s + sleepMinutes(n), 0) / 60)} {periodLabel} — not counted as night sleep, but they pay back sleep debt.</span>}
          {napsThisWeek >= 3 && <span className="sleep-naps-warn">Frequent naps ({napsThisWeek} in the last 7 days): your nights may be too short.</span>}
        </p>
      )}

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

      <div className="sleep-list">
        {!isMobile && groups.length > 0 && (
          <div className="sleep-row sleep-list-head" aria-hidden="true">
            <span>Night</span>
            <span className="sleep-axis"><i>6 pm</i><i>12 am</i><i>6 am</i><i>12 pm</i></span>
            <span>Sleep</span>
            <span>Quality</span>
            <span>Notes</span>
          </div>
        )}
        {groups.map(g => {
          const n = g.night;
          const napHours = g.naps.reduce((sum, x) => sum + sleepMinutes(x), 0) / 60;
          const extra = [n?.awakeHours ? `awake ${formatHours(n.awakeHours)}` : '', g.naps.length ? `+ ${formatHours(napHours)} nap` : ''].filter(Boolean).join(' · ');
          const row = (
            <button type="button" key={g.date} className={`sleep-row ${editingDate === g.date ? 'selected' : ''}`} onClick={() => setEditingDate(g.date)}>
              <span className="sleep-row-date"><b>{weekday(g.date)}</b><small>{formatDate(g.date)}</small></span>
              <span className="sleep-row-bar">{timelineBar(g)}</span>
              <span className="sleep-row-hours">
                <span>{n ? <><b>{n.hours}h</b>{vsTarget(n.hours)}</> : <small>Nap only</small>}</span>
                {extra && <small>{extra}</small>}
              </span>
              <span className="sleep-row-quality">{n?.quality != null ? `${n.quality}/10` : '—'}</span>
              <span className="sleep-row-notes">{g.pieces[0]?.notes ?? ''}</span>
            </button>
          );
          // On a phone, swipe a night left to delete it (the whole day: every piece and nap).
          // Undo brings it back.
          return isMobile ? (
            <SwipeRow
              key={g.date}
              trailing={{
                label: 'Delete',
                icon: <Trash2 size={16} />,
                onTrigger: () => {
                  for (const e of [...g.pieces, ...g.naps]) void remove('sleepEntries', e.id);
                  if (editingDate === g.date) closeEditor();
                }
              }}
            >
              {row}
            </SwipeRow>
          ) : row;
        })}
        {!groups.length && <p className="muted empty-state">No nights logged for {period === 'Day' ? 'this day' : `this ${period.toLowerCase()}`}.</p>}
      </div>

      {editingDate && (() => {
        const n = nightByDate.get(editingDate);
        const g: DayGroup = { date: editingDate, night: n, pieces: n?.pieces ?? [], naps: entries.filter(e => e.date === editingDate && isNap(e)).sort((a, b) => (a.bedTime ?? '').localeCompare(b.bedTime ?? '')) };
        const first = g.pieces[0]; const last = g.pieces[g.pieces.length - 1];
        const entryLine = (e: SleepEntry, nap: boolean) => (
          <li className={`sleep-editor-line ${nap ? 'nap' : ''}`}>
            <button
              type="button"
              className="sleep-kind-btn"
              onClick={() => patch(e, { nap: !nap })}
              title={nap ? 'Nap — tap to count it as night sleep instead' : 'Night sleep — tap to make it a nap instead'}
              aria-label={nap ? 'Nap. Switch to night sleep' : 'Night sleep. Switch to nap'}
            >
              {nap ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <TimeWheelPicker value={e.bedTime} onChange={v => patchTime(e, 'bedTime', v)} placeholder={nap ? 'Start' : 'Bed time'} />
            <span className="sleep-editor-arrow">→</span>
            <TimeWheelPicker value={e.wakeTime} onChange={v => patchTime(e, 'wakeTime', v)} placeholder={nap ? 'End' : 'Wake time'} />
            {computeSleepDuration(e.bedTime, e.wakeTime) != null
              ? <b>{nap ? formatHours(sleepMinutes(e) / 60) : `${sleepHours(e)}h`}</b>
              : <input type="number" inputMode="decimal" step="0.1" className="sleep-editor-hours" value={e.durationHours} onChange={ev => patch(e, { durationHours: Number(ev.target.value) })} aria-label="Hours" />}
            <button type="button" className="icon-btn danger" onClick={() => void remove('sleepEntries', e.id)} aria-label={nap ? 'Delete nap' : 'Delete this sleep'}><Trash2 size={14} /></button>
          </li>
        );
        return (
          <DetailPanel
            eyebrow="Sleep"
            title={`${weekday(editingDate)}, ${formatDate(editingDate)}`}
            onClose={closeEditor}
            footer={<>
              {(g.pieces.length > 0 || g.naps.length > 0) && (
                <button type="button" className="btn ghost danger" onClick={() => { for (const e of [...g.pieces, ...g.naps]) void remove('sleepEntries', e.id); closeEditor(); }}>
                  <Trash2 size={14} /> Delete day
                </button>
              )}
              <button type="button" className="btn primary" onClick={closeEditor}>Done</button>
            </>}
          >
            <div className="sleep-editor">
              {n && (
                <p className="sleep-editor-summary">
                  <b>{n.hours}h</b> asleep{n.awakeHours ? <> · awake {formatHours(n.awakeHours)}</> : null} {vsTarget(n.hours)}
                </p>
              )}
              <label className="sleep-editor-field"><span>Date (the morning you woke up)</span><DatePicker value={editingDate} onChange={v => { if (!v) return; moveDay(g, v); setEditingDate(v); }} /></label>

              <h3 className="sleep-editor-title">Night</h3>
              <ul className="sleep-editor-lines">
                {g.pieces.map((pc, i) => {
                  const gap = i > 0 ? gapHours(g.pieces[i - 1], pc) : undefined;
                  return (
                    <Fragment key={pc.id}>
                      {gap != null && <li className="sleep-editor-gap">awake {formatHours(gap)}</li>}
                      {entryLine(pc, false)}
                    </Fragment>
                  );
                })}
              </ul>
              <button type="button" className="text-btn sleep-editor-add" onClick={() => (last?.wakeTime ? addAnotherPiece(last) : addEntry(editingDate))}>
                <Plus size={14} /> {g.pieces.length ? 'Woke up, then slept again' : 'Add night sleep'}
              </button>

              {first && <>
                <label className="sleep-editor-field">
                  <span className="label-with-info">Quality (1–10) <InfoTip label="How to rate sleep quality">{QUALITY_GUIDE}</InfoTip></span>
                  <input type="number" inputMode="numeric" min={0} max={10} value={n?.quality ?? ''} onChange={ev => setNightQuality(g, ev.target.value === '' ? undefined : Number(ev.target.value))} />
                </label>
                <label className="sleep-editor-field"><span>Notes</span><textarea rows={3} value={first.notes ?? ''} onChange={ev => patch(first, { notes: ev.target.value })} /></label>
                {showTracker ? (
                  <div className="sleep-editor-tracker">
                    <label className="sleep-editor-field"><span>REM (h)</span><input type="number" inputMode="decimal" step="0.1" value={first.remHours ?? ''} onChange={ev => patch(first, { remHours: ev.target.value === '' ? undefined : Number(ev.target.value) })} /></label>
                    <label className="sleep-editor-field"><span>Deep (h)</span><input type="number" inputMode="decimal" step="0.1" value={first.deepHours ?? ''} onChange={ev => patch(first, { deepHours: ev.target.value === '' ? undefined : Number(ev.target.value) })} /></label>
                    <label className="sleep-editor-field"><span>Resting HR</span><input type="number" inputMode="numeric" value={first.restingHr ?? ''} onChange={ev => patch(first, { restingHr: ev.target.value === '' ? undefined : Number(ev.target.value) })} /></label>
                  </div>
                ) : (
                  <button type="button" className="text-btn sleep-editor-add" onClick={() => setShowTrackerFields(true)}><Plus size={14} /> Tracker data (REM, Deep, resting HR)</button>
                )}
              </>}

              <h3 className="sleep-editor-title">Naps</h3>
              {g.naps.length > 0 && <ul className="sleep-editor-lines">{g.naps.map(nap => <Fragment key={nap.id}>{entryLine(nap, true)}</Fragment>)}</ul>}
              <button type="button" className="text-btn sleep-editor-add" onClick={() => addNap(editingDate)}><Plus size={14} /> Add nap</button>
            </div>
          </DetailPanel>
        );
      })()}

      <div className="grid-add-row-group">
        <button
          type="button"
          className="btn teal grid-add-row"
          onClick={() => addEntry()}
          title={usual ? `Starts from your usual ${usual.bedTime} → ${usual.wakeTime}` : undefined}
        >
          <Plus size={16} /> Add night
        </button>
        <button type="button" className="btn ghost grid-add-row" onClick={() => addNap()} title="A daytime nap — kept apart from your night's sleep">
          <Sun size={15} /> Add nap
        </button>
        {lastNight && (
          <button
            type="button"
            className="btn ghost grid-add-row"
            onClick={copyLastNight}
            title={`Copies ${formatDate(lastNight.date)}: ${lastNight.hours}h${lastNight.quality != null ? `, quality ${lastNight.quality}/10` : ''}`}
          >
            <Copy size={15} /> Same as last night
          </button>
        )}
      </div>
    </>
  );
}
