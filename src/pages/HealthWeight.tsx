import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Badge, Card, Kpi, ProgressBar, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { NumberCell, NotesCell, OptionalNumberCell } from '../components/GridCells';
import { SortableTh, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import { MobileRecordList } from '../components/MobileRecordList';
import { Sheet } from '../components/Sheet';
import { useIsMobile } from '../hooks/useIsMobile';
import { HealthInsightList } from '../components/HealthInsights';
import { computeHealthInsights } from '../lib/healthInsights';
import { computeCalorieTarget, glucoseStatus } from '../lib/nutritionTargets';
import { inRange } from '../lib/healthPeriod';
import type { HealthPeriodProps } from './HealthWellness';
import type { GlucoseEntry, MealEntry } from '../types';
import { GLUCOSE_CONTEXTS, MEAL_TYPES } from '../types';
import type { WeightEntry } from '../types';

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function WeightTrendChart({ entries }: { entries: WeightEntry[] }) {
  const sorted = entries.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  if (sorted.length < 2) return <p className="muted empty-state">Log at least two weigh-ins to see a trend.</p>;

  const values = sorted.map(e => e.weight);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coords = sorted.map((e, i) => ({
    x: (i / (sorted.length - 1)) * 100,
    y: 36 - ((e.weight - min) / range) * 32 - 2,
    entry: e
  }));
  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');
  const areaD = `${pathD} L 100 40 L 0 40 Z`;
  const trendingDown = values[values.length - 1] <= values[0];

  return (
    <div className="weight-trend-chart">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="weight-trend-svg">
        <path d={areaD} className={trendingDown ? 'weight-trend-area-good' : 'weight-trend-area-warn'} />
        <path d={pathD} fill="none" className={trendingDown ? 'weight-trend-line-good' : 'weight-trend-line-warn'} />
        {coords.map((c, i) => <circle key={i} cx={c.x} cy={c.y} r="1" className="weight-trend-dot" />)}
      </svg>
      <div className="weight-trend-labels">
        <span>{formatDate(sorted[0].date)}</span>
        <span>{formatDate(sorted[sorted.length - 1].date)}</span>
      </div>
    </div>
  );
}

type WeightSortKey = 'date' | 'weight';
type MealSortKey = 'date' | 'calories';
type GlucoseSortKey = 'date' | 'value';

export function HealthWeight({ period, range, periodLabel, activeDate }: HealthPeriodProps) {
  const { data, updateSettings, upsert, remove } = useStore();
  const entries = data.weightEntries;
  const unit = data.settings.weightUnit ?? 'lb';
  const [targetInput, setTargetInput] = useState(String(data.settings.weightGoalTarget ?? ''));
  const [calorieTargetInput, setCalorieTargetInput] = useState(String(data.settings.dailyCalorieTarget ?? ''));
  const [proteinTargetInput, setProteinTargetInput] = useState(String(data.settings.proteinTargetG ?? ''));
  const isMobile = useIsMobile();
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
  const [editingGlucoseId, setEditingGlucoseId] = useState<string | null>(null);
  const [editingWeightId, setEditingWeightId] = useState<string | null>(null);
  const editingMeal = data.meals.find(m => m.id === editingMealId) ?? null;
  const editingGlucose = data.glucoseEntries.find(g => g.id === editingGlucoseId) ?? null;
  const editingWeight = entries.find(e => e.id === editingWeightId) ?? null;

  const sorted = useMemo(() => entries.slice().sort((a, b) => a.date.localeCompare(b.date)), [entries]);
  const latest = sorted[sorted.length - 1];
  // "Current weight" and "body fat" are always the latest known reading regardless of which
  // period is being browsed — but the change figure is scoped to the period, so viewing a past
  // week/month shows what actually happened then rather than a fixed 30-day window.
  const inPeriodWeights = sorted.filter(e => inRange(e.date, range));
  const periodFirst = inPeriodWeights[0];
  const periodLast = inPeriodWeights[inPeriodWeights.length - 1];
  const change = periodFirst && periodLast && periodFirst.id !== periodLast.id
    ? Math.round((periodLast.weight - periodFirst.weight) * 10) / 10 : undefined;
  const target = data.settings.weightGoalTarget;
  const remaining = latest && target ? Math.round((latest.weight - target) * 10) / 10 : undefined;
  const showInsights = inRange(iso(0), range);
  const insights = showInsights ? computeHealthInsights(data).filter(i => i.pillar === 'Weight') : [];
  const proteinTarget = data.settings.proteinTargetG;
  const glucoseUnit = data.settings.glucoseUnit ?? 'mg/dL';
  const glucoseTrackingEnabled = data.settings.glucoseTrackingEnabled ?? false;

  // Nutrition: a single-day period shows that exact day's totals (with the fueling-loop
  // calorie adjustment for that day's exertion); a wider period shows the average per day
  // that actually had a meal logged, since summing across many days isn't a useful number.
  const isDayPeriod = period === 'Day';
  const mealsInPeriod = data.meals.filter(m => inRange(m.date, range));
  const loggedDayCount = new Set(mealsInPeriod.map(m => m.date)).size;
  const sumOf = (key: 'calories' | 'proteinG' | 'carbsG' | 'fatG') => mealsInPeriod.reduce((s, m) => s + (m[key] ?? 0), 0);
  const perDay = (key: 'calories' | 'proteinG' | 'carbsG' | 'fatG') => loggedDayCount ? Math.round(sumOf(key) / loggedDayCount) : 0;
  const dayCalorieTarget = isDayPeriod ? computeCalorieTarget(data, range.start) : undefined;
  const dailyCalorieBase = data.settings.dailyCalorieTarget;
  const nutrition = dailyCalorieBase != null ? {
    consumed: isDayPeriod ? sumOf('calories') : perDay('calories'),
    target: isDayPeriod ? (dayCalorieTarget?.total ?? dailyCalorieBase) : dailyCalorieBase,
    adjustment: dayCalorieTarget?.adjustment ?? 0,
    protein: isDayPeriod ? sumOf('proteinG') : perDay('proteinG'),
    carbs: isDayPeriod ? sumOf('carbsG') : perDay('carbsG'),
    fat: isDayPeriod ? sumOf('fatG') : perDay('fatG')
  } : undefined;

  const [weightSort, setWeightSort] = useState<SortState<WeightSortKey>>({ key: 'date', dir: 'desc' });
  const sortedWeightRows = inPeriodWeights.slice().sort((a, b) => {
    const cmp = weightSort.key === 'date' ? a.date.localeCompare(b.date) : a.weight - b.weight;
    return weightSort.dir === 'asc' ? cmp : -cmp;
  });
  const patchWeight = (e: WeightEntry, p: Partial<WeightEntry>) => void upsert('weightEntries', { ...e, ...p });
  const [lastAddedWeightId, setLastAddedWeightId] = useState<string | null>(null);
  const addWeight = () => {
    // Starts from the last known weight (a reasonable jumping-off point day to day) but
    // auto-selects the field below so the very next keystroke overwrites it — otherwise an
    // unedited "Add" silently creates a same-value duplicate that looks like nothing happened.
    // Dated to whatever day is currently being viewed (not always "today") — otherwise adding
    // a row while browsing a past day/week creates a today-dated entry invisible in the view
    // you're looking at, and the button looks like it did nothing.
    const record = newRecord<WeightEntry>({ date: activeDate, weight: latest?.weight ?? 0 });
    setLastAddedWeightId(record.id);
    void upsert('weightEntries', record);
  };

  const [mealSort, setMealSort] = useState<SortState<MealSortKey>>({ key: 'date', dir: 'desc' });
  const sortedMeals = mealsInPeriod.slice().sort((a, b) => {
    const cmp = mealSort.key === 'date' ? a.date.localeCompare(b.date) : (a.calories ?? 0) - (b.calories ?? 0);
    return mealSort.dir === 'asc' ? cmp : -cmp;
  });
  const patchMeal = (m: MealEntry, p: Partial<MealEntry>) => void upsert('meals', { ...m, ...p });
  const addMeal = () => void upsert('meals', newRecord<MealEntry>({ date: activeDate, mealType: 'Breakfast', description: '' }));

  const [glucoseSort, setGlucoseSort] = useState<SortState<GlucoseSortKey>>({ key: 'date', dir: 'desc' });
  const glucoseInPeriod = data.glucoseEntries.filter(g => inRange(g.date, range));
  const sortedGlucose = glucoseInPeriod.slice().sort((a, b) => {
    const cmp = glucoseSort.key === 'date' ? `${a.date}${a.time ?? ''}`.localeCompare(`${b.date}${b.time ?? ''}`) : a.value - b.value;
    return glucoseSort.dir === 'asc' ? cmp : -cmp;
  });
  const patchGlucose = (g: GlucoseEntry, p: Partial<GlucoseEntry>) => void upsert('glucoseEntries', { ...g, ...p });
  const addGlucose = () => void upsert('glucoseEntries', newRecord<GlucoseEntry>({ date: activeDate, value: 0 }));

  return (
    <>
      <HealthInsightList insights={insights} />
      <div className="kpi-grid four">
        <Kpi label="Current Weight" value={latest ? `${latest.weight} ${unit}` : '—'} caption={latest ? formatDate(latest.date) : 'no entries yet'} tone="default" />
        <Kpi
          label="Change"
          value={change != null ? `${change > 0 ? '+' : ''}${change} ${unit}` : '—'}
          caption={change != null ? periodLabel : 'need 2+ readings in period'}
          tone={change != null ? (change <= 0 ? 'green' : 'amber') : 'default'}
        />
        <Kpi label="Body Fat %" value={latest?.bodyFatPct != null ? `${latest.bodyFatPct}%` : '—'} caption="most recent reading" tone="blue" />
        <Kpi
          label="To Goal"
          value={remaining != null ? `${Math.abs(remaining)} ${unit}` : '—'}
          caption={remaining != null ? (remaining <= 0 ? 'goal reached' : 'remaining') : 'set a target below'}
          tone={remaining != null && remaining <= 0 ? 'green' : 'default'}
        />
      </div>

      <Card>
        <div className="card-title">
          <div><h2>Trend</h2></div>
        </div>
        <WeightTrendChart entries={period === 'Day' ? entries : inPeriodWeights} />
      </Card>

      <Card>
        <div className="card-title">
          <div><h2>Goal & Units</h2></div>
        </div>
        <div className="health-goal-row">
          <label className="health-inline-field">
            <span>Target weight ({unit})</span>
            <input
              type="number"
              value={targetInput}
              onChange={e => setTargetInput(e.target.value)}
              onBlur={() => void updateSettings({ weightGoalTarget: targetInput === '' ? undefined : Number(targetInput) })}
              placeholder="e.g. 170"
            />
          </label>
          <label className="health-inline-field">
            <span>Unit</span>
            <select value={unit} onChange={e => void updateSettings({ weightUnit: e.target.value as 'lb' | 'kg' })}>
              <option value="lb">lb</option>
              <option value="kg">kg</option>
            </select>
          </label>
          <label className="health-inline-field">
            <span>Daily calorie target</span>
            <input
              type="number"
              value={calorieTargetInput}
              onChange={e => setCalorieTargetInput(e.target.value)}
              onBlur={() => void updateSettings({ dailyCalorieTarget: calorieTargetInput === '' ? undefined : Number(calorieTargetInput) })}
              placeholder="e.g. 2200"
            />
          </label>
          <label className="health-inline-field">
            <span>Daily protein target (g)</span>
            <input
              type="number"
              value={proteinTargetInput}
              onChange={e => setProteinTargetInput(e.target.value)}
              onBlur={() => void updateSettings({ proteinTargetG: proteinTargetInput === '' ? undefined : Number(proteinTargetInput) })}
              placeholder="e.g. 150"
            />
          </label>
          <label className="health-inline-field health-checkbox-field">
            <span>Track glucose</span>
            <input
              type="checkbox"
              checked={glucoseTrackingEnabled}
              onChange={e => void updateSettings({ glucoseTrackingEnabled: e.target.checked })}
            />
          </label>
          {glucoseTrackingEnabled && (
            <label className="health-inline-field">
              <span>Glucose unit</span>
              <select value={glucoseUnit} onChange={e => void updateSettings({ glucoseUnit: e.target.value as 'mg/dL' | 'mmol/L' })}>
                <option value="mg/dL">mg/dL</option>
                <option value="mmol/L">mmol/L</option>
              </select>
            </label>
          )}
        </div>
      </Card>

      <Card>
        <div className="card-title">
          <div><h2>{isDayPeriod ? `Nutrition — ${periodLabel}` : `Avg Daily Nutrition — ${periodLabel}`}</h2></div>
        </div>
        {nutrition ? (
          <div className="health-nutrition-grid">
            <div className="health-nutrition-metric">
              <div className="health-nutrition-top">
                <span>Calories</span>
                <b>{nutrition.consumed} / {nutrition.target} kcal</b>
              </div>
              <ProgressBar value={nutrition.target > 0 ? (nutrition.consumed / nutrition.target) * 100 : 0} />
              {isDayPeriod && nutrition.adjustment > 0 && <small className="health-nutrition-note">+{nutrition.adjustment} kcal added for that day's exertion</small>}
              {!isDayPeriod && <small className="health-nutrition-note">{loggedDayCount} day{loggedDayCount === 1 ? '' : 's'} logged in this period</small>}
            </div>
            {proteinTarget != null && (
              <div className="health-nutrition-metric">
                <div className="health-nutrition-top">
                  <span>Protein</span>
                  <b>{nutrition.protein}g / {proteinTarget}g</b>
                </div>
                <ProgressBar value={proteinTarget > 0 ? (nutrition.protein / proteinTarget) * 100 : 0} />
              </div>
            )}
            <div className="health-nutrition-macros">
              <span>Carbs: <b>{nutrition.carbs}g</b></span>
              <span>Fat: <b>{nutrition.fat}g</b></span>
            </div>
          </div>
        ) : <p className="muted empty-state">Set a daily calorie target above to see progress.</p>}
      </Card>

      <h2 className="grid-section-title">Meal Log</h2>
      {isMobile ? (
        <>
          <MobileRecordList
            items={sortedMeals}
            primary={m => m.description || m.mealType}
            secondary={m => `${formatDate(m.date)} · ${m.mealType}`}
            trailing={m => (m.calories != null ? `${m.calories} kcal` : '—')}
            fields={[
              { label: 'Protein', value: m => (m.proteinG != null ? `${m.proteinG}g` : '—') },
              { label: 'Carbs / Fat', value: m => `${m.carbsG ?? '—'} / ${m.fatG ?? '—'}` }
            ]}
            onOpen={m => setEditingMealId(m.id)}
            onDelete={m => void remove('meals', m.id)}
            deleteLabel={m => `Delete ${m.description || m.mealType}`}
            empty="No meals logged in this period."
          />
          {editingMeal && (
            <Sheet title={editingMeal.description || editingMeal.mealType} onClose={() => setEditingMealId(null)}>
              <div className="sheet-form">
                <label><span>Date</span><DatePicker value={editingMeal.date} onChange={v => patchMeal(editingMeal, { date: v })} /></label>
                <label>
                  <span>Meal</span>
                  <select value={editingMeal.mealType} onChange={e => patchMeal(editingMeal, { mealType: e.target.value as MealEntry['mealType'] })}>
                    {MEAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
                <label><span>Description</span><input type="text" value={editingMeal.description} placeholder="e.g. Grilled chicken salad" onChange={e => patchMeal(editingMeal, { description: e.target.value })} /></label>
                <label><span>Calories (kcal)</span><input type="number" inputMode="numeric" value={editingMeal.calories ?? ''} onChange={e => patchMeal(editingMeal, { calories: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Protein (g)</span><input type="number" inputMode="numeric" value={editingMeal.proteinG ?? ''} onChange={e => patchMeal(editingMeal, { proteinG: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Carbs (g)</span><input type="number" inputMode="numeric" value={editingMeal.carbsG ?? ''} onChange={e => patchMeal(editingMeal, { carbsG: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Fat (g)</span><input type="number" inputMode="numeric" value={editingMeal.fatG ?? ''} onChange={e => patchMeal(editingMeal, { fatG: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
              </div>
            </Sheet>
          )}
        </>
      ) : (
      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <SortableTh label="Date" sortKey="date" state={mealSort} onSort={k => setMealSort(s => toggleSort(s, k, 'desc'))} />
              <th>Meal</th>
              <th>Description</th>
              <SortableTh label="Calories" sortKey="calories" state={mealSort} onSort={k => setMealSort(s => toggleSort(s, k, 'desc'))} />
              <th>Protein</th>
              <th>Carbs</th>
              <th>Fat</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedMeals.map(m => (
              <tr key={m.id}>
                <td><DatePicker value={m.date} onChange={v => patchMeal(m, { date: v })} /></td>
                <td>
                  <select className="grid-cell-select" value={m.mealType} onChange={e => patchMeal(m, { mealType: e.target.value as MealEntry['mealType'] })}>
                    {MEAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td><input type="text" className="grid-cell-input input-wide" value={m.description} placeholder="e.g. Grilled chicken salad" onChange={e => patchMeal(m, { description: e.target.value })} /></td>
                <td className="grid-td-compact"><OptionalNumberCell value={m.calories} onChange={n => patchMeal(m, { calories: n })} placeholder="kcal" /></td>
                <td className="grid-td-compact"><OptionalNumberCell value={m.proteinG} onChange={n => patchMeal(m, { proteinG: n })} placeholder="g" /></td>
                <td className="grid-td-compact"><OptionalNumberCell value={m.carbsG} onChange={n => patchMeal(m, { carbsG: n })} placeholder="g" /></td>
                <td className="grid-td-compact"><OptionalNumberCell value={m.fatG} onChange={n => patchMeal(m, { fatG: n })} placeholder="g" /></td>
                <td><button type="button" className="icon-btn danger" onClick={() => void remove('meals', m.id)} aria-label="Delete meal"><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sortedMeals.length && <p className="muted grid-table-empty">No meals logged for {period === 'Day' ? 'this day' : `this ${period.toLowerCase()}`}.</p>}
      </div>
      )}
      <button type="button" className="btn teal grid-add-row" onClick={addMeal}><Plus size={16} /> Add meal</button>

      {glucoseTrackingEnabled && (
        <>
          <h2 className="grid-section-title">Glucose Log</h2>
          {isMobile ? (
            <>
              <MobileRecordList
                items={sortedGlucose}
                primary={g => `${g.value} ${glucoseUnit}`}
                secondary={g => `${formatDate(g.date)}${g.time ? ` · ${g.time}` : ''}`}
                trailing={g => glucoseStatus(g.value, glucoseUnit)}
                trailingTone={g => {
                  const s = glucoseStatus(g.value, glucoseUnit);
                  return s === 'Low' ? 'negative' : s === 'Normal' ? 'positive' : undefined;
                }}
                fields={[{ label: 'Context', value: g => g.context ?? '—' }]}
                onOpen={g => setEditingGlucoseId(g.id)}
                onDelete={g => void remove('glucoseEntries', g.id)}
                deleteLabel={() => 'Delete reading'}
                empty="No readings logged in this period."
              />
              {editingGlucose && (
                <Sheet title={`${editingGlucose.value} ${glucoseUnit}`} onClose={() => setEditingGlucoseId(null)}>
                  <div className="sheet-form">
                    <label><span>Date</span><DatePicker value={editingGlucose.date} onChange={v => patchGlucose(editingGlucose, { date: v })} /></label>
                    <label><span>Time</span><input type="text" value={editingGlucose.time ?? ''} placeholder="07:15" onChange={e => patchGlucose(editingGlucose, { time: e.target.value || undefined })} /></label>
                    <label><span>Value ({glucoseUnit})</span><input type="number" inputMode="decimal" value={editingGlucose.value} onChange={e => patchGlucose(editingGlucose, { value: Number(e.target.value) })} /></label>
                    <label>
                      <span>Context</span>
                      <select value={editingGlucose.context ?? ''} onChange={e => patchGlucose(editingGlucose, { context: (e.target.value || undefined) as GlucoseEntry['context'] })}>
                        <option value="">—</option>
                        {GLUCOSE_CONTEXTS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </label>
                    <label><span>Notes</span><textarea rows={3} value={editingGlucose.notes ?? ''} onChange={e => patchGlucose(editingGlucose, { notes: e.target.value })} /></label>
                  </div>
                </Sheet>
              )}
            </>
          ) : (
          <div className="grid-table-wrap grid-table-scroll">
            <table className="grid-table">
              <thead>
                <tr>
                  <SortableTh label="Date" sortKey="date" state={glucoseSort} onSort={k => setGlucoseSort(s => toggleSort(s, k, 'desc'))} />
                  <th>Time</th>
                  <SortableTh label="Value" sortKey="value" state={glucoseSort} onSort={k => setGlucoseSort(s => toggleSort(s, k, 'desc'))} />
                  <th>Context</th>
                  <th>Status<br /><small>Computed</small></th>
                  <th>Notes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedGlucose.map(g => {
                  const status = glucoseStatus(g.value, glucoseUnit);
                  return (
                    <tr key={g.id}>
                      <td><DatePicker value={g.date} onChange={v => patchGlucose(g, { date: v })} /></td>
                      <td><input type="text" className="grid-cell-input" value={g.time ?? ''} placeholder="07:15" onChange={e => patchGlucose(g, { time: e.target.value || undefined })} /></td>
                      <td className="grid-td-compact"><NumberCell value={g.value} onChange={n => patchGlucose(g, { value: n })} /></td>
                      <td>
                        <select className="grid-cell-select" value={g.context ?? ''} onChange={e => patchGlucose(g, { context: (e.target.value || undefined) as GlucoseEntry['context'] })}>
                          <option value="">—</option>
                          {GLUCOSE_CONTEXTS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td><Badge tone={status === 'Low' ? 'danger' : status === 'High' ? 'warning' : 'success'}>{status}</Badge></td>
                      <td><NotesCell value={g.notes ?? ''} onChange={v => patchGlucose(g, { notes: v })} /></td>
                      <td><button type="button" className="icon-btn danger" onClick={() => void remove('glucoseEntries', g.id)} aria-label="Delete reading"><Trash2 size={14} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!sortedGlucose.length && <p className="muted grid-table-empty">No readings logged for {period === 'Day' ? 'this day' : `this ${period.toLowerCase()}`}.</p>}
          </div>
          )}
          <button type="button" className="btn teal grid-add-row" onClick={addGlucose}><Plus size={16} /> Add reading</button>
        </>
      )}

      <h2 className="grid-section-title">Weigh-Ins</h2>
      {isMobile ? (
        <>
          <MobileRecordList
            items={sortedWeightRows}
            primary={e => `${e.weight} ${unit}`}
            secondary={e => formatDate(e.date)}
            trailing={e => {
              const idx = sorted.findIndex(s => s.id === e.id);
              const prev = idx > 0 ? sorted[idx - 1] : undefined;
              if (!prev) return '—';
              const d = Math.round((e.weight - prev.weight) * 10) / 10;
              return `${d > 0 ? '+' : ''}${d} ${unit}`;
            }}
            trailingTone={e => {
              const idx = sorted.findIndex(s => s.id === e.id);
              const prev = idx > 0 ? sorted[idx - 1] : undefined;
              if (!prev) return undefined;
              return e.weight - prev.weight <= 0 ? 'positive' : 'negative';
            }}
            fields={[{ label: 'Body fat', value: e => (e.bodyFatPct != null ? `${e.bodyFatPct}%` : '—') }]}
            onOpen={e => setEditingWeightId(e.id)}
            onDelete={e => void remove('weightEntries', e.id)}
            deleteLabel={e => `Delete ${formatDate(e.date)}`}
            empty="No weigh-ins logged in this period."
          />
          {editingWeight && (
            <Sheet title={formatDate(editingWeight.date)} onClose={() => setEditingWeightId(null)}>
              <div className="sheet-form">
                <label><span>Date</span><DatePicker value={editingWeight.date} onChange={v => patchWeight(editingWeight, { date: v })} /></label>
                <label><span>Weight ({unit})</span><input type="number" inputMode="decimal" step="0.1" value={editingWeight.weight} onChange={e => patchWeight(editingWeight, { weight: Number(e.target.value) })} /></label>
                <label><span>Body fat (%)</span><input type="number" inputMode="decimal" step="0.1" value={editingWeight.bodyFatPct ?? ''} onChange={e => patchWeight(editingWeight, { bodyFatPct: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
                <label><span>Notes</span><textarea rows={3} value={editingWeight.notes ?? ''} onChange={e => patchWeight(editingWeight, { notes: e.target.value })} /></label>
              </div>
            </Sheet>
          )}
        </>
      ) : (
      <div className="grid-table-wrap grid-table-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <SortableTh label="Date" sortKey="date" state={weightSort} onSort={k => setWeightSort(s => toggleSort(s, k, 'desc'))} />
              <SortableTh label="Weight" sortKey="weight" state={weightSort} onSort={k => setWeightSort(s => toggleSort(s, k, 'desc'))} />
              <th>Body Fat %</th>
              <th>Trend<br /><small>Computed</small></th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedWeightRows.map(e => {
              const idx = sorted.findIndex(s => s.id === e.id);
              const prev = idx > 0 ? sorted[idx - 1] : undefined;
              const diff = prev ? Math.round((e.weight - prev.weight) * 10) / 10 : undefined;
              return (
                <tr key={e.id}>
                  <td><DatePicker value={e.date} onChange={v => patchWeight(e, { date: v })} /></td>
                  <td className="grid-td-compact"><NumberCell value={e.weight} onChange={n => patchWeight(e, { weight: n })} autoFocus={e.id === lastAddedWeightId} /></td>
                  <td className="grid-td-compact"><OptionalNumberCell value={e.bodyFatPct} onChange={n => patchWeight(e, { bodyFatPct: n })} placeholder="%" /></td>
                  <td>
                    {diff != null ? (
                      <Badge tone={diff <= 0 ? 'success' : 'warning'}>{diff > 0 ? '+' : ''}{diff} {unit}</Badge>
                    ) : <span className="grid-static-cell">—</span>}
                  </td>
                  <td><NotesCell value={e.notes ?? ''} onChange={v => patchWeight(e, { notes: v })} /></td>
                  <td><button type="button" className="icon-btn danger" onClick={() => void remove('weightEntries', e.id)} aria-label="Delete entry"><Trash2 size={14} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!sortedWeightRows.length && <p className="muted grid-table-empty">No weigh-ins logged for {period === 'Day' ? 'this day' : `this ${period.toLowerCase()}`}.</p>}
      </div>
      )}
      <button type="button" className="btn teal grid-add-row" onClick={addWeight}><Plus size={16} /> Add weigh-in</button>
    </>
  );
}
