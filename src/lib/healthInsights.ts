import type { AppData } from '../types';
import { computeCalorieTarget, isLowGlucose } from './nutritionTargets';

export type HealthPillar = 'Fitness' | 'Weight' | 'Sleep' | 'Medication';
export type InsightSeverity = 'info' | 'warn';

export interface HealthInsight {
  id: string;
  pillar: HealthPillar;
  severity: InsightSeverity;
  title: string;
  detail: string;
}

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const HIGH_STRAIN_RPE = 7;
const HIGH_STRAIN_MINUTES = 60;
const POOR_SLEEP_QUALITY = 4;
const SLEEP_DEBT_WARN_HOURS = 3;

/**
 * The cross-module "trigger matrix" — reads across Fitness/Weight/Sleep/Medication and
 * surfaces contextual nudges where one pillar's data should change how you read another's.
 * Every insight here is advisory framing ("consider…"), never a dosing or clinical directive —
 * this app tracks adherence and lifestyle context, it doesn't replace a doctor or pharmacist.
 */
export function computeHealthInsights(data: AppData): HealthInsight[] {
  const insights: HealthInsight[] = [];
  const today = iso(0);
  const weekStart = iso(-6);

  // --- The Metabolic Fueling Loop ---
  // High exertion today changes what the body needs — a fueling nudge, not a calorie target,
  // since this app doesn't track meals/macros.
  const todayWorkouts = data.workouts.filter(w => w.date === today);
  const highStrainWorkout = todayWorkouts.find(w => (w.rpe ?? 0) >= HIGH_STRAIN_RPE);
  const totalMinutesToday = todayWorkouts.reduce((sum, w) => sum + w.durationMin, 0);
  if (highStrainWorkout || totalMinutesToday >= HIGH_STRAIN_MINUTES) {
    const calorieTarget = computeCalorieTarget(data, today);
    const reason = highStrainWorkout
      ? `today's ${highStrainWorkout.type.toLowerCase()} session was high-effort (RPE ${highStrainWorkout.rpe})`
      : `${totalMinutesToday} active minutes logged today`;
    insights.push({
      id: 'fueling-loop',
      pillar: 'Weight',
      severity: 'info',
      title: 'High exertion today',
      detail: calorieTarget && calorieTarget.adjustment > 0
        ? `${reason[0].toUpperCase()}${reason.slice(1)} — today's target is up to ${calorieTarget.total} kcal (+${calorieTarget.adjustment} for the session). Lean toward extra protein and carbs.`
        : `${reason[0].toUpperCase()}${reason.slice(1)} — consider extra protein and carbs to support recovery.`
    });
  }

  // A low reading on a day with a high-strain session — this app has no reading timestamp
  // precision guarantee, so the correlation is same-day rather than a strict 2-hour window.
  const glucoseUnit = data.settings.glucoseUnit ?? 'mg/dL';
  const todayGlucose = data.settings.glucoseTrackingEnabled ? data.glucoseEntries.filter(g => g.date === today) : [];
  const lowReading = todayGlucose.find(g => isLowGlucose(g.value, glucoseUnit));
  if (lowReading && todayWorkouts.length) {
    insights.push({
      id: 'fueling-loop-glucose',
      pillar: 'Weight',
      severity: 'warn',
      title: 'Low glucose reading after today\'s workout',
      detail: `${lowReading.value} ${glucoseUnit}${lowReading.time ? ` at ${lowReading.time}` : ''} — on a day with logged exertion, this may be worth a small carb snack. Pattern awareness only, not medical guidance.`
    });
  }

  // --- The Recovery-Driven Workload Adjustment ---
  // Poor sleep (single night or rolling debt) should downgrade today's training suggestion.
  const lastNight = data.sleepEntries.find(e => e.date === today);
  const targetSleep = data.settings.sleepTargetHours ?? 8;
  if (lastNight && (lastNight.durationHours < targetSleep - 1.5 || (lastNight.quality ?? 10) <= POOR_SLEEP_QUALITY)) {
    insights.push({
      id: 'recovery-single-night',
      pillar: 'Fitness',
      severity: 'warn',
      title: 'Recovery looked rough last night',
      detail: `${lastNight.durationHours}h${lastNight.quality ? ` at quality ${lastNight.quality}/10` : ''} — today might be a better day for an easy session or rest instead of pushing intensity.`
    });
  } else {
    const thisWeekSleep = data.sleepEntries.filter(e => e.date >= weekStart);
    if (thisWeekSleep.length >= 3) {
      const debt = targetSleep * thisWeekSleep.length - thisWeekSleep.reduce((s, e) => s + e.durationHours, 0);
      if (debt > SLEEP_DEBT_WARN_HOURS) {
        insights.push({
          id: 'recovery-debt',
          pillar: 'Fitness',
          severity: 'warn',
          title: 'Sleep debt is building up',
          detail: `About ${Math.round(debt)}h behind target over the last week — worth favoring lower-intensity workouts until it's paid back down.`
        });
      }
    }
  }

  // --- The Clinical Bioavailability Sync ---
  // Medications flagged with a food-timing requirement get a same-day reminder tied to
  // whether today's dose has already been confirmed.
  const activeMeds = data.medications.filter(m => m.active);
  for (const med of activeMeds) {
    const flags = med.flags ?? [];
    const doseToday = med.times.some(t => {
      const entry = med.doseLog.find(d => d.date === today && d.time === t);
      return !entry || (!entry.takenAt && !entry.skipped);
    });
    if (!doseToday) continue;
    if (flags.includes('Requires Dietary Fat')) {
      insights.push({
        id: `bioavailability-fat-${med.id}`,
        pillar: 'Medication',
        severity: 'info',
        title: `${med.name} absorbs better with fat`,
        detail: 'Pair today\'s dose with a source of healthy dietary fat for better absorption.'
      });
    }
    if (flags.includes('Empty Stomach Only')) {
      insights.push({
        id: `bioavailability-empty-${med.id}`,
        pillar: 'Medication',
        severity: 'info',
        title: `${med.name} needs an empty stomach`,
        detail: 'Take this one separated from meals, per its instructions.'
      });
    }
  }

  // --- The Safe Exercise Window ---
  // A cardiovascular-affecting medication makes standard age-predicted HR zones unreliable —
  // this is a standing caution, not tied to a specific day.
  const hrMeds = activeMeds.filter(m => (m.flags ?? []).includes('Affects Heart Rate'));
  const bpMeds = activeMeds.filter(m => (m.flags ?? []).includes('Affects Blood Pressure'));
  if (hrMeds.length) {
    insights.push({
      id: 'safe-window-hr',
      pillar: 'Fitness',
      severity: 'warn',
      title: 'Heart-rate zones may be unreliable',
      detail: `${hrMeds.map(m => m.name).join(', ')} can blunt your heart-rate response — go by perceived effort (RPE) rather than HR zone alone during workouts.`
    });
  }
  if (bpMeds.length) {
    insights.push({
      id: 'safe-window-bp',
      pillar: 'Fitness',
      severity: 'warn',
      title: 'Extra caution on high-intensity or rapid position changes',
      detail: `${bpMeds.map(m => m.name).join(', ')} can affect blood pressure regulation — ease into high-intensity sessions and stand up slowly after strength work.`
    });
  }

  return insights;
}
