import type { ReactNode } from 'react';
import { Activity, ArrowRight, Flame, Moon, Pill, Scale, Snowflake } from 'lucide-react';
import { useStore } from '../store';
import { Card, formatDate } from '../components/UI';
import { HealthInsightList } from '../components/HealthInsights';
import { computeHealthInsights } from '../lib/healthInsights';
import { isMilestone, loggingStreak, medicationAdherenceStreak, nextMilestone } from '../lib/healthStreaks';
import { inRange } from '../lib/healthPeriod';
import type { HealthPeriodProps, HealthTab } from './HealthWellness';

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// Reorders the same four quadrants by time of day instead of changing what's on screen —
// whichever pillar matters most right now (morning meds/weigh-in vs. evening wind-down)
// leads, so the page feels responsive to the moment without adding new components.
type Pillar = 'Fitness' | 'Weight' | 'Sleep' | 'Medication';

function quadrantOrderForHour(hour: number): Pillar[] {
  if (hour < 11) return ['Medication', 'Weight', 'Sleep', 'Fitness'];
  if (hour < 17) return ['Fitness', 'Weight', 'Medication', 'Sleep'];
  return ['Sleep', 'Medication', 'Fitness', 'Weight'];
}

export function HealthOverview({
  onNavigate, period, range, periodLabel
}: { onNavigate: (tab: HealthTab) => void } & HealthPeriodProps) {
  const { data } = useStore();
  const today = iso(0);
  const isDayPeriod = period === 'Day';
  const showInsights = inRange(today, range);
  const insights = showInsights ? computeHealthInsights(data) : [];

  const periodWorkouts = data.workouts.filter(w => inRange(w.date, range));
  const activeMinutes = periodWorkouts.reduce((sum, w) => sum + w.durationMin, 0);
  const lastWorkout = data.workouts.slice().sort((a, b) => b.date.localeCompare(a.date))[0];

  const sortedWeights = data.weightEntries.slice().sort((a, b) => a.date.localeCompare(b.date));
  const latestWeight = sortedWeights[sortedWeights.length - 1];
  const weightUnit = data.settings.weightUnit ?? 'lb';
  const periodWeights = sortedWeights.filter(e => inRange(e.date, range));
  const weightChange = periodWeights.length > 1
    ? Math.round((periodWeights[periodWeights.length - 1].weight - periodWeights[0].weight) * 10) / 10 : undefined;

  const lastNight = data.sleepEntries.slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  const periodSleep = data.sleepEntries.filter(e => inRange(e.date, range));
  const avgSleep = periodSleep.length ? periodSleep.reduce((s, e) => s + e.durationHours, 0) / periodSleep.length : undefined;

  const activeMeds = data.medications.filter(m => m.active);
  const scheduledToday = activeMeds.reduce((sum, m) => sum + m.times.length, 0);
  const takenToday = activeMeds.reduce((sum, m) => sum + m.times.filter(t => {
    const entry = m.doseLog.find(d => d.date === today && d.time === t);
    return Boolean(entry?.takenAt) && !entry?.skipped;
  }).length, 0);
  let periodTaken = 0;
  let periodSkipped = 0;
  for (const m of activeMeds) {
    for (const d of m.doseLog) {
      if (!inRange(d.date, range)) continue;
      if (d.skipped) periodSkipped += 1;
      else if (d.takenAt) periodTaken += 1;
    }
  }
  const periodAdherence = periodTaken + periodSkipped > 0 ? Math.round((periodTaken / (periodTaken + periodSkipped)) * 100) : undefined;
  const refillAlerts = activeMeds.filter(m => m.pillsRemaining != null && m.refillThreshold != null && m.pillsRemaining <= m.refillThreshold);

  const adherenceStreak = medicationAdherenceStreak(data.medications);
  const logging = loggingStreak(data);

  const quadrants: Record<Pillar, ReactNode> = {
    Fitness: (
      <Card className="health-quadrant" key="Fitness">
        <div className="health-quadrant-head">
          <span className="health-quadrant-icon fitness"><Activity size={16} /></span>
          <h3>Fitness</h3>
          <button type="button" className="icon-btn" onClick={() => onNavigate('Fitness')} aria-label="View Fitness"><ArrowRight size={14} /></button>
        </div>
        <strong className="health-quadrant-hero">{periodWorkouts.length}</strong>
        <span className="health-quadrant-hero-label">workouts {periodLabel}</span>
        <small className="health-quadrant-meta">
          {activeMinutes} active min {periodLabel}{lastWorkout ? ` · last: ${lastWorkout.type} on ${formatDate(lastWorkout.date)}` : ''}
        </small>
      </Card>
    ),
    Weight: (
      <Card className="health-quadrant" key="Weight">
        <div className="health-quadrant-head">
          <span className="health-quadrant-icon weight"><Scale size={16} /></span>
          <h3>Weight Loss</h3>
          <button type="button" className="icon-btn" onClick={() => onNavigate('Weight')} aria-label="View Weight"><ArrowRight size={14} /></button>
        </div>
        <strong className="health-quadrant-hero">{latestWeight ? `${latestWeight.weight} ${weightUnit}` : '—'}</strong>
        <span className="health-quadrant-hero-label">{latestWeight ? formatDate(latestWeight.date) : 'no entries yet'}</span>
        <small className="health-quadrant-meta">
          {weightChange != null ? `${weightChange > 0 ? '+' : ''}${weightChange} ${weightUnit} ${periodLabel}` : 'log 2+ weigh-ins in this period to see a change'}
        </small>
      </Card>
    ),
    Sleep: (
      <Card className="health-quadrant" key="Sleep">
        <div className="health-quadrant-head">
          <span className="health-quadrant-icon sleep"><Moon size={16} /></span>
          <h3>Sleep</h3>
          <button type="button" className="icon-btn" onClick={() => onNavigate('Sleep')} aria-label="View Sleep"><ArrowRight size={14} /></button>
        </div>
        <strong className="health-quadrant-hero">{lastNight ? `${lastNight.durationHours}h` : '—'}</strong>
        <span className="health-quadrant-hero-label">last night</span>
        <small className="health-quadrant-meta">
          {avgSleep != null ? `${avgSleep.toFixed(1)}h avg ${periodLabel}` : 'no entries yet'}
        </small>
      </Card>
    ),
    Medication: (
      <Card className="health-quadrant" key="Medication">
        <div className="health-quadrant-head">
          <span className="health-quadrant-icon medication"><Pill size={16} /></span>
          <h3>Medication</h3>
          <button type="button" className="icon-btn" onClick={() => onNavigate('Medication')} aria-label="View Medication"><ArrowRight size={14} /></button>
        </div>
        {isDayPeriod ? (
          <>
            <strong className="health-quadrant-hero">{scheduledToday > 0 ? `${takenToday}/${scheduledToday}` : '—'}</strong>
            <span className="health-quadrant-hero-label">doses confirmed today</span>
          </>
        ) : (
          <>
            <strong className="health-quadrant-hero">{periodAdherence != null ? `${periodAdherence}%` : '—'}</strong>
            <span className="health-quadrant-hero-label">adherence {periodLabel}</span>
          </>
        )}
        <small className={`health-quadrant-meta ${refillAlerts.length ? 'warn' : ''}`}>
          {refillAlerts.length ? `${refillAlerts.length} medication${refillAlerts.length === 1 ? '' : 's'} running low` : 'no refills needed'}
        </small>
      </Card>
    )
  };

  const order = quadrantOrderForHour(new Date().getHours());

  return (
    <>
      <div className="health-streak-row">
        <StreakBadge
          icon={<Pill size={16} />}
          label="Medication Streak"
          length={adherenceStreak}
          caption={activeMeds.length ? undefined : 'no active medications tracked'}
        />
        <StreakBadge
          icon={<Activity size={16} />}
          label="Logging Streak"
          length={logging.length}
          freezeUsed={logging.freezeUsed}
        />
      </div>
      <HealthInsightList insights={insights} title="Today's Insights" />
      <div className="health-quadrant-grid">
        {order.map(pillar => quadrants[pillar])}
      </div>
    </>
  );
}

function StreakBadge({
  icon, label, length, freezeUsed, caption
}: { icon: ReactNode; label: string; length: number; freezeUsed?: boolean; caption?: string }) {
  const milestone = isMilestone(length);
  const next = nextMilestone(length);
  return (
    <Card className={`health-streak-badge ${milestone ? 'milestone' : ''}`}>
      <span className="health-streak-icon">{length > 0 ? <Flame size={18} /> : icon}</span>
      <div className="health-streak-body">
        <div className="health-streak-top">
          <strong>{length}</strong>
          <span>{label}</span>
          {freezeUsed && <span className="health-streak-freeze" title="A missed day was forgiven this streak"><Snowflake size={12} /></span>}
        </div>
        <small>
          {caption ?? (milestone ? `Milestone reached — on to ${next ?? 'the next one'}!` : next != null ? `${next - length} day${next - length === 1 ? '' : 's'} to your ${next}-day milestone` : 'day' + (length === 1 ? '' : 's') + ' in a row')}
        </small>
      </div>
    </Card>
  );
}
