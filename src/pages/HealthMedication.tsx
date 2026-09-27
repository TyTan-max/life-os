import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, CircleOff, Download, Eye, EyeOff, PackagePlus, Pill, Plus, X } from 'lucide-react';
import { CollectionPage } from '../components/CollectionPage';
import { useStore } from '../store';
import { Card, Kpi, Modal, formatDate } from '../components/UI';
import { HealthInsightList } from '../components/HealthInsights';
import { computeHealthInsights } from '../lib/healthInsights';
import { medicationAdherenceStreak } from '../lib/healthStreaks';
import { inRange } from '../lib/healthPeriod';
import {
  WEEKDAYS, adherenceStats, dayStatus, defaultTimesFor, doseStatus, isAsNeeded, isDayOff, isDue, isScheduledDay, localIso,
  medStartDate, minutesOverdue, repeatLabel, repeatMode, scheduledTimes, shiftIsoDate, supplyEstimate, takenAsNeeded,
  withAsNeededDose, withDayOff, withDoseStatus, withoutAsNeededDose, type DayStatus, type DoseStatus
} from '../lib/medications';
import type { HealthPeriodProps } from './HealthWellness';
import type { Medication } from '../types';
import { MEDICATION_FREQUENCIES, MEDICATION_FLAGS, MEDICATION_REPEATS } from '../types';

// "08:00" → "8:00 AM"
function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function formatOverdue(minutes: number): string {
  if (minutes < 60) return `due ${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  return `due ${h}h ago`;
}

function isRefillLow(med: Medication): boolean {
  return med.pillsRemaining != null && med.refillThreshold != null && med.pillsRemaining <= med.refillThreshold;
}

export function HealthMedication({ range, periodLabel, activeDate, onActiveDateChange }: HealthPeriodProps) {
  const { data, upsert, updateSettings } = useStore();
  const medications = data.medications;
  const active = medications.filter(m => m.active);
  const today = localIso();
  const showList = !data.settings.medicationListHidden;
  const [refilling, setRefilling] = useState<Medication | undefined>();

  // The checklist follows the date picker, so a forgotten dose can be back-filled on the day it
  // belonged to. Future days are view-only.
  const day = activeDate;
  const isToday = day === today;
  const isFuture = day > today;
  const dayLabel = isToday ? "Today's Doses" : `Doses · ${formatDate(day)}`;
  const dayMeds = active.filter(m => day >= medStartDate(m));

  // "No meds needed" for the whole day: every scheduled medication gets the day marked off, so
  // nothing on it counts as due or missed. As-needed medications aren't affected.
  const scheduledMeds = active.filter(m => !isAsNeeded(m) && day >= medStartDate(m));
  const dayIsOff = scheduledMeds.some(m => isDayOff(m, day));
  const canMarkOff = dayIsOff || scheduledMeds.some(m => isScheduledDay(m, day));
  const setDayOff = async (off: boolean) => {
    for (const med of scheduledMeds) {
      if (off ? isScheduledDay(med, day) && !isDayOff(med, day) : isDayOff(med, day)) {
        await upsert('medications', withDayOff(med, day, off));
      }
    }
  };
  const visibleMeds = dayIsOff ? dayMeds.filter(isAsNeeded) : dayMeds;

  const toggle = (med: Medication, time: string, next: DoseStatus) => {
    if (isFuture) return;
    const current = doseStatus(med, day, time);
    void upsert('medications', withDoseStatus(med, day, time, current === next ? 'pending' : next));
  };

  const scheduledOnDay = active.reduce((sum, m) => sum + scheduledTimes(m, day).length, 0);
  const takenOnDay = active.reduce((sum, m) => sum + scheduledTimes(m, day).filter(t => doseStatus(m, day, t) === 'taken').length, 0);

  // The next dose still to take today, across every medication.
  const nextDose = active
    .flatMap(m => scheduledTimes(m, today).filter(t => doseStatus(m, today, t) === 'pending' && !isDue(today, t)).map(t => ({ med: m, time: t })))
    .sort((a, b) => a.time.localeCompare(b.time))[0];

  const stats = adherenceStats(active, range.start, range.end);
  const refillAlerts = active.filter(isRefillLow);
  const showInsights = inRange(today, range);
  const insights = showInsights ? computeHealthInsights(data).filter(i => i.pillar === 'Medication') : [];
  const streak = medicationAdherenceStreak(medications);

  const exportAdherenceReport = () => {
    const start = shiftIsoDate(today, -29);
    const lines: string[] = [
      'Life OS — Medication Adherence Report',
      `Generated ${new Date().toLocaleString()}`,
      '',
      `Overall adherence streak: ${streak} day${streak === 1 ? '' : 's'}`,
      ''
    ];
    for (const med of active) {
      lines.push(`${med.name} (${med.dosage}, ${med.frequency}${!isAsNeeded(med) && repeatMode(med) !== 'Every day' ? `, ${repeatLabel(med)}` : ''})`);
      if (isAsNeeded(med)) {
        const used = med.doseLog.filter(d => d.date >= start && d.takenAt && !d.skipped).length;
        lines.push(`  Taken as needed: ${used} time${used === 1 ? '' : 's'} in the last 30 days`);
      } else {
        const s = adherenceStats([med], start, today);
        lines.push(`  30-day adherence: ${s.pct != null ? `${s.pct}%` : 'no data'} (${s.taken} taken, ${s.skipped} skipped, ${s.missed} missed of ${s.due} due)`);
      }
      const supply = supplyEstimate(med);
      if (med.pillsRemaining != null) lines.push(`  Pills remaining: ${med.pillsRemaining}${supply ? ` (about ${supply.daysLeft} days, runs out ${formatDate(supply.runsOut)})` : ''}`);
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

  const adherenceCaption = stats.pct == null
    ? `no doses due ${periodLabel}`
    : `${stats.taken}/${stats.due} due${stats.missed ? ` · ${stats.missed} missed` : ''}${stats.skipped ? ` · ${stats.skipped} skipped` : ''}`;

  return (
    <>
      <HealthInsightList insights={insights} />
      <div className="kpi-grid five">
        <Kpi label="Active Medications" value={active.length} caption="currently tracked" tone="default" />
        <Kpi
          label={isToday ? "Today's Doses" : 'Doses That Day'}
          value={scheduledOnDay ? `${takenOnDay}/${scheduledOnDay}` : '—'}
          caption={isToday && nextDose ? `next: ${nextDose.med.name}, ${formatTime(nextDose.time)}` : isToday ? 'confirmed so far' : formatDate(day)}
          tone={scheduledOnDay > 0 && takenOnDay === scheduledOnDay ? 'green' : 'default'}
        />
        <Kpi label="Adherence" value={stats.pct != null ? `${stats.pct}%` : '—'} caption={adherenceCaption} tone={stats.pct != null && stats.pct >= 90 ? 'green' : stats.pct != null ? 'amber' : 'default'} />
        <Kpi label="Adherence Streak" value={streak} caption={streak === 1 ? 'day' : 'days'} tone={streak > 0 ? 'green' : 'default'} />
        <Kpi label="Refill Alerts" value={refillAlerts.length} caption="running low" tone={refillAlerts.length ? 'red' : 'default'} />
      </div>

      <Card>
        <div className="card-title">
          <div>
            <h2>{dayLabel}</h2>
            {!isToday && (
              <button type="button" className="med-back-today" onClick={() => onActiveDateChange(today)}>Back to today</button>
            )}
          </div>
          <div className="med-card-actions">
            {canMarkOff && !dayIsOff && (
              <button type="button" className="btn ghost small" onClick={() => void setDayOff(true)} title="Nothing scheduled on this day will count as due or missed">
                <CircleOff size={14} /> No meds needed
              </button>
            )}
            {active.length > 0 && (
              <button type="button" className="btn ghost small" onClick={exportAdherenceReport}>
                <Download size={14} /> Export<span className="med-export-long"> Adherence Report</span>
              </button>
            )}
          </div>
        </div>
        {dayIsOff && (
          <div className="med-day-off-banner">
            <CircleOff size={15} />
            <span><b>No meds needed {isToday ? 'today' : 'this day'}.</b> Scheduled doses don't count toward adherence or your streak.</span>
            <button type="button" className="btn ghost small" onClick={() => void setDayOff(false)}>Undo</button>
          </div>
        )}
        {isFuture && !dayIsOff && <p className="muted med-day-note">This day hasn't happened yet — doses can be marked once it arrives.</p>}
        {visibleMeds.length ? (
          <div className="med-today-list">
            {visibleMeds.map(med => (
              <MedDayRow
                key={med.id}
                med={med}
                day={day}
                readOnly={isFuture}
                onToggle={toggle}
                onTookOne={() => void upsert('medications', withAsNeededDose(med, day))}
                onRemoveDose={time => void upsert('medications', withoutAsNeededDose(med, day, time))}
                onRefill={() => setRefilling(med)}
              />
            ))}
          </div>
        ) : !dayIsOff && (
          <p className="muted empty-state">
            {active.length ? 'Nothing scheduled on this day.' : 'No active medications yet. Add one below.'}
          </p>
        )}
      </Card>

      {active.length > 0 && (
        <HistoryCalendar meds={active} selected={day} onSelect={onActiveDateChange} />
      )}

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
            { key: 'repeat', label: 'Repeats', type: 'select', options: MEDICATION_REPEATS, fallback: 'Every day', showWhen: f => f.frequency !== 'As Needed' },
            { key: 'weekdays', label: 'On These Days', type: 'multiselect', options: WEEKDAYS, placeholder: 'Pick days…', showWhen: f => f.frequency !== 'As Needed' && f.repeat === 'Specific days' },
            { key: 'repeatFrom', label: 'Counting From (a day you take it)', type: 'date', showWhen: f => f.frequency !== 'As Needed' && f.repeat === 'Every other day' },
            { key: 'times', label: 'Scheduled Times', type: 'times', showWhen: f => f.frequency !== 'As Needed' },
            { key: 'withFood', label: 'Take with food', type: 'checkbox' },
            { key: 'flags', label: 'Notes for reminders (optional)', type: 'multiselect', options: MEDICATION_FLAGS },
            { key: 'active', label: 'Active', type: 'checkbox' },
            { key: 'pillsRemaining', label: 'Pills Remaining', type: 'number' },
            { key: 'pillsPerDose', label: 'Pills per Dose', type: 'number', placeholder: '1' },
            { key: 'refillThreshold', label: 'Refill Alert Threshold', type: 'number' },
            { key: 'prescriber', label: 'Prescriber', type: 'text' },
            { key: 'notes', label: 'Notes', type: 'richtext' }
          ]}
          defaults={{ name: '', dosage: '', frequency: 'Once Daily', repeat: 'Every day', times: ['08:00'], pillsPerDose: 1, active: true, doseLog: [] }}
          // Changing the frequency sets a matching number of dose times (e.g. Twice Daily → 8 AM & 8 PM).
          onFieldChange={(key, value, form) => (
            key === 'frequency' ? { times: defaultTimesFor(String(value), form.times ?? []) } : undefined
          )}
          renderTitle={m => m.name}
          renderSubtitle={m => {
            const supply = m.active ? supplyEstimate(m) : undefined;
            const schedule = !isAsNeeded(m) && repeatMode(m) !== 'Every day' ? `${m.frequency} · ${repeatLabel(m)}` : m.frequency;
            return `${m.dosage ? `${m.dosage} · ` : ''}${schedule}${supply ? ` · ${supply.daysLeft}d supply` : ''}${m.active ? '' : ' · inactive'}`;
          }}
          sortBy={(a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1)}
          leading={() => <span className="health-type-icon"><Pill size={14} /></span>}
        />
      )}

      {refilling && (
        <RefillModal
          med={refilling}
          onClose={() => setRefilling(undefined)}
          onSave={count => {
            void upsert('medications', { ...refilling, pillsRemaining: (refilling.pillsRemaining ?? 0) + count, lastRefillSize: count });
            setRefilling(undefined);
          }}
        />
      )}
    </>
  );
}

function MedDayRow({
  med, day, readOnly, onToggle, onTookOne, onRemoveDose, onRefill
}: {
  med: Medication;
  day: string;
  readOnly: boolean;
  onToggle: (med: Medication, time: string, next: DoseStatus) => void;
  onTookOne: () => void;
  onRemoveDose: (time: string) => void;
  onRefill: () => void;
}) {
  const supply = supplyEstimate(med);
  const low = isRefillLow(med);
  const times = scheduledTimes(med, day);
  const offDay = !isAsNeeded(med) && !isScheduledDay(med, day);
  const takenPrn = isAsNeeded(med) ? takenAsNeeded(med, day) : [];

  return (
    <div className={`med-today-row ${offDay ? 'off-day' : ''}`}>
      <div className="med-today-info">
        <Pill size={16} />
        <div>
          <b>{med.name}</b>
          <small>
            {[med.dosage, med.withFood ? 'with food' : '', supply ? `${supply.daysLeft} day${supply.daysLeft === 1 ? '' : 's'} left · runs out ${formatDate(supply.runsOut)}` : '']
              .filter(Boolean).join(' · ')}
          </small>
        </div>
        {low && <span className="med-refill-badge">Refill soon — {med.pillsRemaining} left</span>}
        {med.pillsRemaining != null && (
          <button type="button" className="btn ghost small med-refill-btn" onClick={onRefill} title="Add a refill to the pill count">
            <PackagePlus size={13} /> Refilled
          </button>
        )}
      </div>
      <div className="med-today-doses">
        {offDay && <span className="med-off-day">Not today · {repeatLabel(med)}</span>}
        {isAsNeeded(med) && (
          <>
            {takenPrn.map(d => (
              <span className="med-dose-chip taken" key={d.time}>
                <span>Took {formatTime(d.time)}</span>
                {!readOnly && (
                  <button type="button" className="icon-btn med-dose-btn" onClick={() => onRemoveDose(d.time)} aria-label={`Remove ${med.name} dose at ${d.time}`} title="Remove">
                    <X size={13} />
                  </button>
                )}
              </span>
            ))}
            {!readOnly && (
              <button type="button" className="btn ghost small med-took-one" onClick={onTookOne}>
                <Plus size={13} /> Took one
              </button>
            )}
            {readOnly && !takenPrn.length && <span className="med-off-day">As needed</span>}
          </>
        )}
        {times.map(time => {
          const status = doseStatus(med, day, time);
          const overdue = status === 'pending' ? minutesOverdue(day, time) : 0;
          const missed = status === 'pending' && isDue(day, time) && !overdue;
          return (
            <div className={`med-dose-chip ${status} ${overdue ? 'overdue' : ''} ${missed ? 'missed' : ''}`} key={time}>
              <span>
                {formatTime(time)}
                {overdue > 0 && <em>{formatOverdue(overdue)}</em>}
                {missed && <em>missed</em>}
              </span>
              <button
                type="button"
                className={`icon-btn med-dose-btn ${status === 'taken' ? 'on-success' : ''}`}
                onClick={() => onToggle(med, time, 'taken')}
                disabled={readOnly}
                aria-label={`Mark ${med.name} at ${time} taken`}
                title="Mark taken"
              >
                <Check size={13} />
              </button>
              <button
                type="button"
                className={`icon-btn med-dose-btn ${status === 'skipped' ? 'on-danger' : ''}`}
                onClick={() => onToggle(med, time, 'skipped')}
                disabled={readOnly}
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
  );
}

function RefillModal({ med, onClose, onSave }: { med: Medication; onClose: () => void; onSave: (count: number) => void }) {
  const [count, setCount] = useState(String(med.lastRefillSize ?? 30));
  const n = Math.floor(Number(count));
  const valid = Number.isFinite(n) && n > 0;
  return (
    <Modal
      title={`Refill ${med.name}`}
      eyebrow="Medication"
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!valid} onClick={() => onSave(n)}>Add pills</button>
        </>
      )}
    >
      <div className="form-grid"><label className="field-full">
        <span>Pills in this refill</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={count}
          autoFocus
          onChange={e => setCount(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && valid) onSave(n); }}
        />
      </label></div>
      <p className="muted med-refill-note">
        {med.pillsRemaining ?? 0} left now → {(med.pillsRemaining ?? 0) + (valid ? n : 0)} after the refill.
      </p>
    </Modal>
  );
}

const DAY_STATUS_LABEL: Record<DayStatus, string> = {
  complete: 'All taken',
  partial: 'Some missed',
  missed: 'Missed',
  upcoming: 'On track',
  off: 'No meds needed',
  none: 'Nothing scheduled',
  future: ''
};

// Month grid of how each day went — click a day to open it in the checklist above.
function HistoryCalendar({ meds, selected, onSelect }: { meds: Medication[]; selected: string; onSelect: (iso: string) => void }) {
  const [month, setMonth] = useState(selected.slice(0, 7));
  useEffect(() => { setMonth(selected.slice(0, 7)); }, [selected]);

  const first = new Date(`${month}-01T12:00:00`);
  const lead = first.getDay();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  ];
  while (cells.length % 7) cells.push(null);

  const shiftMonth = (delta: number) => {
    const d = new Date(first.getFullYear(), first.getMonth() + delta, 1, 12);
    setMonth(localIso(d).slice(0, 7));
  };
  const today = localIso();
  const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <Card className="med-history-card">
      <div className="card-title">
        <div><h2>History</h2></div>
        <div className="med-history-nav">
          <button type="button" className="icon-btn" onClick={() => shiftMonth(-1)} aria-label="Previous month"><ChevronLeft size={15} /></button>
          <span>{title}</span>
          <button type="button" className="icon-btn" onClick={() => shiftMonth(1)} aria-label="Next month" disabled={month > today.slice(0, 7)}><ChevronRight size={15} /></button>
        </div>
      </div>
      <div className="med-history-grid">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span className="med-history-head" key={i}>{d}</span>)}
        {cells.map((date, i) => {
          if (!date) return <span key={i} />;
          const status = dayStatus(meds, date);
          return (
            <button
              type="button"
              key={date}
              className={`med-history-day ${status} ${date === selected ? 'selected' : ''} ${date === today ? 'today' : ''}`}
              onClick={() => onSelect(date)}
              title={`${formatDate(date)}${DAY_STATUS_LABEL[status] ? ` — ${DAY_STATUS_LABEL[status]}` : ''}`}
            >
              {Number(date.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="med-history-legend">
        <span><i className="complete" /> All taken</span>
        <span><i className="partial" /> Some missed</span>
        <span><i className="missed" /> Missed</span>
        <span><i className="off" /> No meds needed</span>
      </div>
    </Card>
  );
}
