import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Dumbbell, Moon, RotateCcw, Scale, UtensilsCrossed } from 'lucide-react';
import { PageHeader } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { Sheet } from '../components/Sheet';
import { useFabAction } from '../hooks/useFabAction';
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

  // Quick log hands off to the tab that owns that kind of entry, which adds it and opens its
  // edit sheet (Discard / Save). It used to save the entry itself with defaults — an 8h night,
  // yesterday's weight again, a 30-minute run — before you'd entered anything.
  const [pendingAdd, setPendingAdd] = useState<QuickLogKind | null>(null);
  const clearPendingAdd = () => setPendingAdd(null);
  const quickLog = (kind: QuickLogKind) => {
    // Log against today, even if a past day is being browsed.
    setAnchorDate(new Date());
    setTab(kind === 'Sleep' ? 'Sleep' : kind === 'Workout' ? 'Fitness' : 'Weight');
    setPendingAdd(kind);
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
            <button type="button" className="icon-btn" onClick={() => shiftPeriod(-1)} aria-label={`Previous ${period.toLowerCase()}`}><ChevronLeft size={16} /></button>
            <DatePicker
              value={activeDate}
              onChange={onActiveDateChange}
              displayLabel={periodLabel}
            />
            <button type="button" className="icon-btn" onClick={() => shiftPeriod(1)} aria-label={`Next ${period.toLowerCase()}`}><ChevronRight size={16} /></button>
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
          </div>
        </div>
      </div>

      {tab === 'Overview' && <HealthOverview onNavigate={setTab} {...periodProps} />}
      {tab === 'Fitness' && <HealthFitness {...periodProps} autoAdd={pendingAdd === 'Workout'} onAutoAdded={clearPendingAdd} />}
      {tab === 'Weight' && (
        <HealthWeight
          {...periodProps}
          autoAdd={pendingAdd === 'Weight' ? 'weight' : pendingAdd === 'Meal' ? 'meal' : undefined}
          onAutoAdded={clearPendingAdd}
        />
      )}
      {tab === 'Sleep' && <HealthSleep {...periodProps} autoAdd={pendingAdd === 'Sleep'} onAutoAdded={clearPendingAdd} />}
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
