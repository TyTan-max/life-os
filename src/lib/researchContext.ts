import type { AppData } from '../types';
import { actualSpendByCategory, monthKey, monthlyIncome, shiftMonth } from './budgetMath';
import { nightsOf, formatHours } from './sleep';

// A plain-text summary of your Life OS data for the Research assistant.
//
// PRIVACY: this is only ever given to the LOCAL engine (Ollama, on this computer). The cloud
// adapter has no parameter that could carry it — see ResearchChat's streamGemini — so it cannot
// be sent to Google, whatever the UI state.

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function localIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type ContextArea = 'finance' | 'sleep' | 'habits' | 'tasks' | 'health';
export const CONTEXT_AREAS: { key: ContextArea; label: string }[] = [
  { key: 'finance', label: 'Finance' },
  { key: 'sleep', label: 'Sleep' },
  { key: 'habits', label: 'Habits' },
  { key: 'tasks', label: 'Tasks & goals' },
  { key: 'health', label: 'Workouts & weight' }
];

export function buildLifeOsContext(data: AppData, areas: ContextArea[] = CONTEXT_AREAS.map(a => a.key)): string {
  const on = (area: ContextArea) => areas.includes(area);
  const today = localIso();
  const month = monthKey();
  const lastMonth = shiftMonth(month, -1);
  const catName = (id?: string) => data.financeCategories.find(c => c.id === id)?.name ?? 'Uncategorized';
  const lines: string[] = [`Today is ${today}. The following is the user's own data from their Life OS app.`];

  // ---- Finance
  const monthLine = (m: string) => {
    const spend = [...actualSpendByCategory(data.transactions, m)].sort((a, b) => b[1] - a[1]);
    const total = spend.reduce((s, [, v]) => s + v, 0);
    return `${m}: income ${money(monthlyIncome(data.transactions, m))}, spending ${money(total)}`
      + (spend.length ? ` (${spend.slice(0, 8).map(([id, v]) => `${catName(id)} ${money(v)}`).join(', ')})` : '');
  };
  if (on('finance')) {
  lines.push('', 'FINANCE', monthLine(month), monthLine(lastMonth), monthLine(shiftMonth(month, -2)));
  const accounts = data.financeAccounts.filter(a => a.status !== 'Closed');
  if (accounts.length) lines.push(`Accounts: ${accounts.map(a => `${a.name} (${a.type}) ${money(a.balance)}`).join('; ')}`);
  const budgets = data.budgets.filter(b => b.month === month && b.limit > 0);
  if (budgets.length) lines.push(`This month's budgets: ${budgets.map(b => `${catName(b.categoryId)} ${money(b.limit)}`).join(', ')}`);
  const bills = data.bills.filter(b => !b.paused);
  if (bills.length) lines.push(`Bills & subscriptions: ${bills.map(b => `${b.name} ${money(b.amount)} ${b.frequency ?? 'Monthly'} next ${b.nextDue}`).join('; ')}`);
  for (const g of data.financeGoals) lines.push(`Savings goal: ${g.name} ${money(g.currentAmount)} of ${money(g.targetAmount)}${g.targetDate ? ` by ${g.targetDate}` : ''}`);
  for (const p of data.settings.paySchedules ?? []) lines.push(`Pay schedule: ${p.name} ${money(p.amount)} ${p.frequency}, first payday ${p.firstPayday}`);
  }

  // ---- Sleep
  const nights = nightsOf(data.sleepEntries.filter(e => e.date <= today)).slice(-14);
  if (on('sleep') && nights.length) {
    const avg = nights.reduce((s, n) => s + n.hours, 0) / nights.length;
    lines.push('', `SLEEP (target ${data.settings.sleepTargetHours ?? 8}h; last ${nights.length} nights, average ${avg.toFixed(1)}h)`,
      ...nights.map(n => `${n.date}: ${n.hours}h${n.bedTime && n.wakeTime ? ` (${n.bedTime}–${n.wakeTime})` : ''}${n.awakeHours ? `, awake ${formatHours(n.awakeHours)}` : ''}${n.naps ? `, nap ${formatHours(n.napHours)}` : ''}${n.quality != null ? `, quality ${n.quality}/10` : ''}`));
  }

  // ---- Habits
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
  const weekAgoIso = localIso(weekAgo);
  const habits = data.habits.filter(h => h.active !== false);
  if (on('habits') && habits.length) {
    lines.push('', 'HABITS (check-ins in the last 7 days)',
      ...habits.map(h => `${h.name}: ${h.checkins.filter(d => d >= weekAgoIso && d <= today).length}${h.targetPerWeek ? ` of ${h.targetPerWeek}` : ''} (${h.frequency})`));
  }

  // ---- Tasks & goals
  const open = data.tasks.filter(t => t.status !== 'Completed');
  if (on('tasks') && open.length) lines.push('', 'OPEN TASKS', ...open.slice(0, 25).map(t => `${t.title} — due ${t.dueDate || 'no date'}, ${t.priority} priority`));
  if (on('tasks') && data.goals.length) lines.push('', 'GOALS', ...data.goals.slice(0, 25).map(g => `${g.title} — ${g.progress}%${g.targetDate ? `, target ${g.targetDate}` : ''}${g.status ? `, ${g.status}` : ''}`));

  // ---- Health
  const workouts = data.workouts.filter(w => w.date >= weekAgoIso && w.date <= today);
  if (on('health') && workouts.length) lines.push('', `WORKOUTS (last 7 days): ${workouts.map(w => `${w.date} ${w.type}${w.durationMin ? ` ${w.durationMin}m` : ''}`).join('; ')}`);
  const weights = data.weightEntries.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-5);
  if (on('health') && weights.length) lines.push(`WEIGHT (latest): ${weights.map(w => `${w.date} ${w.weight}`).join('; ')}`);

  return lines.join('\n');
}
