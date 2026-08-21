import { Check, Download, Eye, EyeOff, Pill, X } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { useStore } from '../store';
import { Card, Kpi } from '../components/UI';
import { HealthInsightList } from '../components/HealthInsights';
import { computeHealthInsights } from '../lib/healthInsights';
import { medicationAdherenceStreak } from '../lib/healthStreaks';
import { inRange } from '../lib/healthPeriod';
import type { HealthPeriodProps } from './HealthWellness';
import type { Medication } from '../types';
import { MEDICATION_FREQUENCIES, MEDICATION_FLAGS } from '../types';

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

type DoseStatus = 'taken' | 'skipped' | 'pending';

function doseStatus(med: Medication, date: string, time: string): DoseStatus {
  const entry = med.doseLog.find(d => d.date === date && d.time === time);
  if (!entry) return 'pending';
  if (entry.skipped) return 'skipped';
  if (entry.takenAt) return 'taken';
  return 'pending';
}

function withDoseStatus(med: Medication, date: string, time: string, next: DoseStatus): Medication {
  const existing = med.doseLog.find(d => d.date === date && d.time === time);
  const wasTaken = Boolean(existing?.takenAt) && !existing?.skipped;
  const doseLog = med.doseLog.filter(d => !(d.date === date && d.time === time));
  if (next === 'taken') doseLog.push({ date, time, takenAt: new Date().toISOString() });
  else if (next === 'skipped') doseLog.push({ date, time, skipped: true });

  let pillsRemaining = med.pillsRemaining;
  if (pillsRemaining != null) {
    const nowTaken = next === 'taken';
    if (nowTaken && !wasTaken) pillsRemaining = Math.max(0, pillsRemaining - 1);
    else if (!nowTaken && wasTaken) pillsRemaining = pillsRemaining + 1;
  }
  return { ...med, doseLog, pillsRemaining };
}

export function HealthMedication({ range, periodLabel }: HealthPeriodProps) {
  const { data, upsert, updateSettings } = useStore();
  const medications = data.medications;
  const active = medications.filter(m => m.active);
  const today = iso(0);
  const showList = !data.settings.medicationListHidden;

  const toggle = (med: Medication, time: string, next: DoseStatus) => {
    const current = doseStatus(med, today, time);
    void upsert('medications', withDoseStatus(med, today, time, current === next ? 'pending' : next));
  };

  const scheduledToday = active.reduce((sum, m) => sum + m.times.length, 0);
  const takenToday = active.reduce((sum, m) => sum + m.times.filter(t => doseStatus(m, today, t) === 'taken').length, 0);

  const thirtyDaysAgo = iso(-30);
  let takenCount = 0;
  let skippedCount = 0;
  for (const m of active) {
    for (const d of m.doseLog) {
      if (!inRange(d.date, range)) continue;
      if (d.skipped) skippedCount += 1;
      else if (d.takenAt) takenCount += 1;
    }
  }
  const adherence = takenCount + skippedCount > 0 ? Math.round((takenCount / (takenCount + skippedCount)) * 100) : undefined;

  const refillAlerts = active.filter(m => m.pillsRemaining != null && m.refillThreshold != null && m.pillsRemaining <= m.refillThreshold);
  const showInsights = inRange(today, range);
  const insights = showInsights ? computeHealthInsights(data).filter(i => i.pillar === 'Medication') : [];
  const streak = medicationAdherenceStreak(medications);

  const exportAdherenceReport = () => {
    const lines: string[] = [
      'Life OS — Medication Adherence Report',
      `Generated ${new Date().toLocaleString()}`,
      '',
      `Overall adherence streak: ${streak} day${streak === 1 ? '' : 's'}`,
      ''
    ];
    for (const med of active) {
      const doses30 = med.doseLog.filter(d => d.date >= thirtyDaysAgo);
      const taken = doses30.filter(d => d.takenAt && !d.skipped).length;
      const skipped = doses30.filter(d => d.skipped).length;
      const pct = taken + skipped > 0 ? Math.round((taken / (taken + skipped)) * 100) : null;
      lines.push(`${med.name} (${med.dosage}, ${med.frequency})`);
      lines.push(`  30-day adherence: ${pct != null ? `${pct}%` : 'no data'} (${taken} taken, ${skipped} skipped)`);
      if (med.pillsRemaining != null) lines.push(`  Pills remaining: ${med.pillsRemaining}`);
      if (med.prescriber) lines.push(`  Prescriber: ${med.prescriber}`);
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `adherence-report-${today}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <HealthInsightList insights={insights} />
      <div className="kpi-grid five">
        <Kpi label="Active Medications" value={active.length} caption="currently tracked" tone="default" />
        <Kpi label="Today's Doses" value={`${takenToday}/${scheduledToday}`} caption="confirmed so far" tone={scheduledToday > 0 && takenToday === scheduledToday ? 'green' : 'default'} />
        <Kpi label="Adherence" value={adherence != null ? `${adherence}%` : '—'} caption={`of logged doses, ${periodLabel}`} tone={adherence != null && adherence >= 90 ? 'green' : adherence != null ? 'amber' : 'default'} />
        <Kpi label="Adherence Streak" value={streak} caption={streak === 1 ? 'day' : 'days'} tone={streak > 0 ? 'green' : 'default'} />
        <Kpi label="Refill Alerts" value={refillAlerts.length} caption="running low" tone={refillAlerts.length ? 'red' : 'default'} />
      </div>

      <Card>
        <div className="card-title">
          <div><h2>Today's Doses</h2></div>
          {active.length > 0 && (
            <button type="button" className="btn ghost small" onClick={exportAdherenceReport}>
              <Download size={14} /> Export Adherence Report
            </button>
          )}
        </div>
        {active.length ? (
          <div className="med-today-list">
            {active.map(med => (
              <div className="med-today-row" key={med.id}>
                <div className="med-today-info">
                  <Pill size={16} />
                  <div>
                    <b>{med.name}</b>
                    <small>{med.dosage}{med.withFood ? ' · with food' : ''}</small>
                  </div>
                  {med.pillsRemaining != null && med.refillThreshold != null && med.pillsRemaining <= med.refillThreshold && (
                    <span className="med-refill-badge">Refill soon — {med.pillsRemaining} left</span>
                  )}
                </div>
                <div className="med-today-doses">
                  {med.times.map(time => {
                    const status = doseStatus(med, today, time);
                    return (
                      <div className="med-dose-chip" key={time}>
                        <span>{time}</span>
                        <button
                          type="button"
                          className={`icon-btn med-dose-btn ${status === 'taken' ? 'on-success' : ''}`}
                          onClick={() => toggle(med, time, 'taken')}
                          aria-label={`Mark ${med.name} at ${time} taken`}
                          title="Mark taken"
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          className={`icon-btn med-dose-btn ${status === 'skipped' ? 'on-danger' : ''}`}
                          onClick={() => toggle(med, time, 'skipped')}
                          aria-label={`Mark ${med.name} at ${time} skipped`}
                          title="Mark skipped"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted empty-state">No active medications yet. Add one below.</p>}
      </Card>

      <button
        type="button"
        className="btn ghost small health-med-list-toggle"
        onClick={() => void updateSettings({ medicationListHidden: showList })}
      >
        {showList ? <EyeOff size={14} /> : <Eye size={14} />}
        {showList ? 'Hide medications list' : 'Show medications list'}
      </button>

      {showList && (
        <CollectionPage<Medication>
          collection="medications"
          itemLabel="Medication"
          title="Medications"
          subtitle="What you take, how often, and refill status"
          fields={[
            { key: 'name', label: 'Name', type: 'text' },
            { key: 'dosage', label: 'Dosage', type: 'text', placeholder: 'e.g. 500mg' },
            { key: 'frequency', label: 'Frequency', type: 'select', options: MEDICATION_FREQUENCIES },
            { key: 'times', label: 'Scheduled Times (comma-separated, e.g. 08:00, 20:00)', type: 'tags' },
            { key: 'withFood', label: 'Take with food', type: 'checkbox' },
            { key: 'flags', label: 'Notes for reminders (optional)', type: 'multiselect', options: MEDICATION_FLAGS },
            { key: 'active', label: 'Active', type: 'checkbox' },
            { key: 'pillsRemaining', label: 'Pills Remaining', type: 'number' },
            { key: 'refillThreshold', label: 'Refill Alert Threshold', type: 'number' },
            { key: 'prescriber', label: 'Prescriber', type: 'text' },
            { key: 'notes', label: 'Notes', type: 'richtext' }
          ]}
          defaults={{ name: '', dosage: '', frequency: 'Once Daily', times: ['08:00'], active: true, doseLog: [] }}
          renderTitle={m => m.name}
          renderSubtitle={m => `${m.dosage} · ${m.frequency}${m.active ? '' : ' · inactive'}`}
          sortBy={(a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1)}
          leading={() => <span className="health-type-icon"><Pill size={14} /></span>}
        />
      )}
    </>
  );
}
