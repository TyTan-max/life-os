import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Dumbbell, Moon, RotateCcw, Scale, UtensilsCrossed } from 'lucide-react';
import { PageHeader } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { Sheet } from '../components/Sheet';
import { useFabAction } from '../hooks/useFabAction';
import { useStore, newRecord } from '../store';
import type { MealEntry, SleepEntry, WeightEntry, WorkoutEntry } from '../types';
import { WORKOUT_TYPES } from '../types';
import {
  HEALTH_PERIODS, formatPeriodLabel, isCurrentPeriod, periodRangeFor, shiftAnchor, toIsoDate
} from '../lib/healthPeriod';
import type { DateRange, HealthPeriod } from '../lib/healthPeriod';
import { HealthOverview } from './HealthOverview';
import { HealthFitness } from './HealthFitness';
import { HealthWeight } from './HealthWeight';
import { HealthSleep } from './HealthSleep';
import { HealthMedication } from './HealthMedication';

export type HealthTab = 'Overview' | 'Fitness' | 'Weight' | 'Sleep' | 'Medication';

const TABS: HealthTab[] = ['Overview', 'Fitness', 'Weight', 'Sleep', 'Medication'];

export interface HealthPeriodProps {
  period: HealthPeriod;
  range: DateRange;
  periodLabel: string;
  activeDate: string;
  onActiveDateChange: (iso: string) => void;
}

type QuickLogKind = 'Weight' | 'Sleep' | 'Meal' | 'Workout';

export function HealthWellness() {
  const { data, upsert } = useStore();
  const [tab, setTab] = useState<HealthTab>('Overview');
  const [period, setPeriod] = useState<HealthPeriod>('Day');
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [quickLogOpen, setQuickLogOpen] = useState(false);

  const range = useMemo(() => periodRangeFor(period, anchorDate), [period, anchorDate]);
  const periodLabel = formatPeriodLabel(period, anchorDate);
  const activeDate = toIsoDate(anchorDate);
  const onActiveDateChange = (v: string) => setAnchorDate(new Date(`${v}T12:00:00`));
  const periodProps: HealthPeriodProps = { period, range, periodLabel, activeDate, onActiveDateChange };

  const shiftPeriod = (delta: number) => setAnchorDate(d => shiftAnchor(period, d, delta));
  const returnToCurrentPeriod = () => setAnchorDate(new Date());

  // Each sub-page owns its own add-entry form and its own "which row is being edited" state,
  // so a quick log from here can create the entry and land on the right tab, but can't jump
  // straight into that sub-page's edit sheet without threading an id through props all four
  // sub-pages would need to accept. Landing on the tab with the new (blank, today-dated) entry
  // visible in the list is the honest stopping point for this pass.
  const quickLog = (kind: QuickLogKind) => {
    const today = toIsoDate(new Date());
    if (kind === 'Weight') {
      const latest = data.weightEntries.slice().sort((a, b) => a.date.localeCompare(b.date)).pop();
      void upsert('weightEntries', newRecord<WeightEntry>({ date: today, weight: latest?.weight ?? 0 }));
      setTab('Weight');
    } else if (kind === 'Sleep') {
      void upsert('sleepEntries', newRecord<SleepEntry>({ date: today, durationHours: data.settings.sleepTargetHours ?? 8 }));
      setTab('Sleep');
    } else if (kind === 'Meal') {
      void upsert('meals', newRecord<MealEntry>({ date: today, mealType: 'Breakfast', description: '' }));
      setTab('Weight');
    } else {
      const workoutTypes = data.settings.workoutTypes ?? WORKOUT_TYPES;
      void upsert('workouts', newRecord<WorkoutEntry>({ date: today, type: workoutTypes[0] ?? 'Run', durationMin: 30 }));
      setTab('Fitness');
    }
    setQuickLogOpen(false);
  };
  useFabAction('Health', 'Quick log', () => setQuickLogOpen(true));

  return (
    <>
      <PageHeader title="Health" subtitle="Fitness, weight, sleep, and medication — the physical basics, tracked in one place." />

      <div className="filter-row health-tab-period-row">
        <div className="segmented">
          {TABS.map(t => (
            <button type="button" key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>

        <div className="health-period-controls">
          <select
            className="health-period-select"
            value={period}
            onChange={e => setPeriod(e.target.value as HealthPeriod)}
            aria-label="Period"
          >
            {HEALTH_PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <div className="tj-period-nav">
            {!isCurrentPeriod(period, anchorDate) && (
              <button
                type="button"
                className="icon-btn"
                onClick={returnToCurrentPeriod}
                aria-label={`Return to current ${period.toLowerCase()}`}
                title={`Return to current ${period.toLowerCase()}`}
              >
                <RotateCcw size={15} />
              </button>
            )}
            <button type="button" className="icon-btn" onClick={() => shiftPeriod(-1)} aria-label={`Previous ${period.toLowerCase()}`}><ChevronLeft size={16} /></button>
            <DatePicker
              value={activeDate}
              onChange={onActiveDateChange}
              displayLabel={periodLabel}
            />
            <button type="button" className="icon-btn" onClick={() => shiftPeriod(1)} aria-label={`Next ${period.toLowerCase()}`}><ChevronRight size={16} /></button>
          </div>
        </div>
      </div>

      {tab === 'Overview' && <HealthOverview onNavigate={setTab} {...periodProps} />}
      {tab === 'Fitness' && <HealthFitness {...periodProps} />}
      {tab === 'Weight' && <HealthWeight {...periodProps} />}
      {tab === 'Sleep' && <HealthSleep {...periodProps} />}
      {tab === 'Medication' && <HealthMedication {...periodProps} />}

      {quickLogOpen && (
        <Sheet title="Quick log" onClose={() => setQuickLogOpen(false)}>
          <div className="health-quicklog-grid">
            <button type="button" className="health-quicklog-btn" onClick={() => quickLog('Weight')}>
              <Scale size={20} /><span>Weight</span>
            </button>
            <button type="button" className="health-quicklog-btn" onClick={() => quickLog('Sleep')}>
              <Moon size={20} /><span>Sleep</span>
            </button>
            <button type="button" className="health-quicklog-btn" onClick={() => quickLog('Meal')}>
              <UtensilsCrossed size={20} /><span>Meal</span>
            </button>
            <button type="button" className="health-quicklog-btn" onClick={() => quickLog('Workout')}>
              <Dumbbell size={20} /><span>Workout</span>
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}
