import type { AppData, DailyLog, Habit } from '../types';
import { actualSpendByCategory } from './budgetMath';
import { getEffectiveRoutineFilter, loadSavedRoutineFilter, matchesRoutineFilter, sortRoutines } from './habitRoutines';
import { formatCurrency } from '../components/UI';

function netOf(l: Pick<DailyLog, 'dailyPL' | 'dailyFees'>): number {
  return l.dailyPL - l.dailyFees;
}

function localIso(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function scheduledDays(habit: Habit): number[] {
  if (Array.isArray(habit.scheduledDays) && habit.scheduledDays.length) return habit.scheduledDays;
  if (habit.frequency === 'Weekdays') return [1, 2, 3, 4, 5];
  if (habit.frequency === 'Weekly') return [0];
  return [0, 1, 2, 3, 4, 5, 6];
}

// Same rule set as the Dashboard's own "Smart daily brief" card — kept here as the single
// source of truth so the scheduled notification (notifications.ts) can never drift out of sync
// with what the card on screen actually says.
export function computeDailyBrief(data: AppData, today: string = localIso()): string[] {
  const openTasks = data.tasks.filter(t => t.status !== 'Completed');
  const overdue = openTasks.filter(t => t.dueDate < today);

  const routines = sortRoutines(data.habitRoutines);
  const effectiveRoutineFilter = getEffectiveRoutineFilter(routines, loadSavedRoutineFilter());
  const habitsInRoutine = routines.length === 0 ? data.habits : data.habits.filter(h => matchesRoutineFilter(h, effectiveRoutineFilter));
  const activeHabits = habitsInRoutine.filter(h => h.active !== false);
  const todayDayIndex = new Date().getDay();
  const habitsDueToday = activeHabits.filter(h => scheduledDays(h).includes(todayDayIndex));
  const todayDone = habitsDueToday.filter(h => h.checkins.includes(today)).length;

  const month = today.slice(0, 7);
  const monthBudgets = data.budgets.filter(b => b.month === month);
  const spendByCategory = actualSpendByCategory(data.transactions, month);
  const overBudgetCount = monthBudgets.filter(b => (spendByCategory.get(b.categoryId) ?? 0) > b.limit).length;

  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const in7Iso = localIso(in7);
  const upcomingBills = data.bills.filter(b => (b.kind ?? 'Bill') === 'Bill' && b.nextDue >= today && b.nextDue <= in7Iso);
  const upcomingBillsTotal = upcomingBills.reduce((s, b) => s + b.amount, 0);

  const backlogNeedsReview =
    data.movies.filter(m => m.needsReview).length +
    data.videogames.filter(g => g.needsReview).length +
    data.books.filter(b => b.needsReview).length;

  const tradingLogs = data.dailyLogs;
  const tradingTotalTrades = tradingLogs.reduce((sum, log) => sum + (log.totalTrades || 0), 0);
  const tradingWinRate = tradingLogs.length
    ? Math.round((tradingLogs.filter(log => netOf(log) > 0).length / tradingLogs.length) * 100)
    : 0;

  return [
    overdue.length ? `${overdue.length} overdue task${overdue.length === 1 ? '' : 's'} need attention.` : 'No overdue tasks.',
    habitsDueToday.length ? `${todayDone} of ${habitsDueToday.length} scheduled habits are complete today.` : 'No habits are scheduled today.',
    overBudgetCount
      ? `${overBudgetCount} budget categor${overBudgetCount === 1 ? 'y is' : 'ies are'} over their limit this month.`
      : upcomingBills.length
      ? `${upcomingBills.length} bill${upcomingBills.length === 1 ? '' : 's'} due in the next 7 days (${formatCurrency(upcomingBillsTotal)}).`
      : 'Budgets and bills are on track.',
    backlogNeedsReview
      ? `${backlogNeedsReview} backlog item${backlogNeedsReview === 1 ? '' : 's'} in Movies/Games/Books need info.`
      : tradingLogs.length
      ? `${tradingLogs.length} trading day${tradingLogs.length === 1 ? '' : 's'} logged (${tradingTotalTrades} trades) with ${tradingWinRate}% green days.`
      : 'Start logging trading days to build your scalping data.'
  ];
}
