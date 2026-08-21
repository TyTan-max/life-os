import type { AppData, GlucoseUnit } from '../types';

const LOW_GLUCOSE_THRESHOLD: Record<GlucoseUnit, number> = { 'mg/dL': 70, 'mmol/L': 3.9 };
const HIGH_GLUCOSE_THRESHOLD: Record<GlucoseUnit, number> = { 'mg/dL': 180, 'mmol/L': 10.0 };

export function isLowGlucose(value: number, unit: GlucoseUnit): boolean {
  return value < LOW_GLUCOSE_THRESHOLD[unit];
}

// A single general-purpose band, not context-adjusted (fasting vs. post-meal have different
// normal ranges in reality) — good enough for an at-a-glance computed column, not a diagnosis.
export function glucoseStatus(value: number, unit: GlucoseUnit): 'Low' | 'Normal' | 'High' {
  if (value < LOW_GLUCOSE_THRESHOLD[unit]) return 'Low';
  if (value > HIGH_GLUCOSE_THRESHOLD[unit]) return 'High';
  return 'Normal';
}

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// A high-effort session (RPE 7+) without a logged calorie burn still deserves a fueling
// bump — a rough 8 kcal/min heuristic stands in for a real burn estimate.
const HIGH_RPE_KCAL_PER_MIN = 8;
const HIGH_STRAIN_RPE = 7;

export interface CalorieTarget {
  base: number;
  adjustment: number;
  total: number;
  consumed: number;
  remaining: number;
}

/** The Metabolic Fueling Loop, made concrete: today's calorie target rises with today's exertion. */
export function computeCalorieTarget(data: AppData, date: string = iso(0)): CalorieTarget | undefined {
  const base = data.settings.dailyCalorieTarget;
  if (base == null) return undefined;

  const workoutsToday = data.workouts.filter(w => w.date === date);
  const adjustment = workoutsToday.reduce((sum, w) => {
    if (w.caloriesBurned != null) return sum + w.caloriesBurned;
    if ((w.rpe ?? 0) >= HIGH_STRAIN_RPE) return sum + w.durationMin * HIGH_RPE_KCAL_PER_MIN;
    return sum;
  }, 0);

  const total = base + adjustment;
  const consumed = data.meals.filter(m => m.date === date).reduce((sum, m) => sum + (m.calories ?? 0), 0);

  return { base, adjustment: Math.round(adjustment), total: Math.round(total), consumed, remaining: Math.round(total - consumed) };
}

export interface MacroTotals {
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export function computeMacroTotals(data: AppData, date: string = iso(0)): MacroTotals {
  const today = data.meals.filter(m => m.date === date);
  return {
    proteinG: today.reduce((s, m) => s + (m.proteinG ?? 0), 0),
    carbsG: today.reduce((s, m) => s + (m.carbsG ?? 0), 0),
    fatG: today.reduce((s, m) => s + (m.fatG ?? 0), 0)
  };
}
