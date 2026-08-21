import type { ExerciseSetLog, RoutineDay, RoutineExercise, WorkoutRoutine } from '../types';
import { generateId } from '../utils/id';

// Any real "logging for" date will be >= this, so the starter's one version always resolves.
export const ROUTINE_EPOCH = '1970-01-01';

function iso(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// A per-set ramp for the most recent session (e.g. [40, 50, 60, 70] for a 4-set ramp),
// with the rep count achieved on the final set — not a history across past sessions.
// Collects the seeded weights into `logs` (keyed by the exercise's id) rather than nesting
// them on the exercise, matching the routine's flat exerciseLogs storage.
function ex(
  logs: ExerciseSetLog[], name: string, targetSets: number, targetReps: string,
  weights?: (number | undefined)[], lastReps?: number
): RoutineExercise {
  const id = generateId();
  if (weights) logs.push({ exerciseId: id, date: iso(0), weights, lastReps });
  return { id, name, targetSets, targetReps };
}

export function buildStarterRoutine(): Omit<WorkoutRoutine, 'id' | 'createdAt' | 'updatedAt'> {
  const logs: ExerciseSetLog[] = [];
  const days: RoutineDay[] = [
    {
      id: generateId(),
      name: 'Day 1: Strength Foundation (Heavier Weights)',
      warmup: '5 min light cardio + dynamic shoulder & hip mobility',
      exercises: [
        ex(logs, 'Dumbbell Goblet Squat', 4, '12', [40, 50, 60, 70], 12),
        ex(logs, 'Seated Dumbbell Shoulder Press', 4, '12', [20, 40, 50, 50], 8),
        ex(logs, 'Dumbbell Romanian Deadlift', 3, '12', [35, 40, 50]),
        ex(logs, 'Dumbbell Lateral Raise', 3, '12'),
        ex(logs, 'Flat Dumbbell Press', 3, '12'),
        ex(logs, 'One-Arm Dumbbell Row', 3, '12'),
        ex(logs, 'Weighted Plank', 3, '45 sec')
      ]
    },
    {
      id: generateId(),
      name: 'Day 2: Volume & Isolation Focus',
      warmup: 'Band pull-aparts + leg swings (2-3 min)',
      exercises: [
        ex(logs, 'Dumbbell Split Squat (Bulgarian optional)', 4, '12'),
        ex(logs, 'Arnold Press', 4, '12'),
        ex(logs, 'Dumbbell Step-Ups (onto bench)', 3, '12'),
        ex(logs, 'Incline Dumbbell Lateral Raise', 3, '15'),
        ex(logs, 'Dumbbell Chest-Supported Row', 3, '10-12'),
        ex(logs, 'Dumbbell Incline Press', 3, '12'),
        ex(logs, 'Hanging Leg Raise / Weighted Crunch', 3, '15'),
        ex(logs, 'Optional finisher: Dumbbell Jump Squats', 3, '15')
      ]
    },
    {
      id: generateId(),
      name: 'Day 3: Hypertrophy & Burnout',
      warmup: '5 min cardio + shoulder circles',
      exercises: [
        ex(logs, 'Dumbbell Front Squat (double)', 4, '12'),
        ex(logs, 'Dumbbell Upright Row', 3, '12'),
        ex(logs, 'Dumbbell Walking Lunges', 3, '12'),
        ex(logs, 'Dumbbell Lateral Raise + Front Raise Combo', 3, '10'),
        ex(logs, 'Dumbbell Incline Curl', 3, '10-12'),
        ex(logs, 'Dumbbell Reverse Fly (bent-over)', 3, '15'),
        ex(logs, 'Dumbbell Russian Twist', 3, '20')
      ]
    },
    {
      id: generateId(),
      name: 'Extra: Optional Delt Finisher (5 Minutes)',
      warmup: '3 rounds, no rest between exercises — 30 sec rest between rounds',
      exercises: [
        ex(logs, 'Dumbbell Front Raises', 3, '10'),
        ex(logs, 'Dumbbell Lateral Raises', 3, '10'),
        ex(logs, 'Dumbbell Rear Delt Flys', 3, '10'),
        ex(logs, 'Arnold Presses', 3, '10')
      ]
    }
  ];

  return {
    name: 'Dumbbell Strength & Hypertrophy Program',
    versions: [{ effectiveFrom: ROUTINE_EPOCH, days }],
    exerciseLogs: logs,
    progressionNotes:
      'Weeks 1-2: Focus on form.\n' +
      'Weeks 3-6: Increase dumbbell weight gradually.\n' +
      'Week 7+: Add 1 more set to lagging areas (especially delts or quads).'
  };
}
