import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Wand2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import { Card, Kpi, formatCurrency, formatDate } from '../components/UI';
import { SortableTh, toggleSort } from '../components/SortableTh';
import type { SortState } from '../components/SortableTh';
import { MonthYearPicker } from '../components/MonthYearPicker';
import { isLiabilityAccount } from './FinanceAccounts';
import { FinanceLedger } from './FinanceLedger';
import {
  actualSpendByCategory, formatMonthLabel, monthKey, monthlyIncome,
  rolloverAmount, shiftMonth, suggest502030
} from '../lib/budgetMath';
import type { Budget, FinanceGoal } from '../types';

function requiredMonthlyContribution(goal: FinanceGoal): number {
  if (!goal.targetDate) return 0;
  const months = Math.max(1, Math.round((new Date(`${goal.targetDate}T12:00:00`).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)));
  return Math.max(0, (goal.targetAmount - goal.currentAmount) / months);
}

interface TrendPoint { label: string; value: number; }

// Catmull-Rom-to-Bezier smoothing so the line curves gently through each point
// instead of the sharp corners a plain polyline would give.
function smoothPath(coords: { x: number; y: number }[]): string {
  if (coords.length < 2) return '';
  if (coords.length === 2) return `M ${coords[0].x} ${coords[0].y} L ${coords[1].x} ${coords[1].y}`;
  let d = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i - 1] ?? coords[i];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

function TrendAreaChart({ points }: { points: TrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length < 2) {
    return <p className="muted empty-state">Not enough history yet — log transactions across a couple of months to see a trend.</p>;
  }

  const values = points.map(p => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // Pad around the actual variance instead of forcing the axis to include $0 —
  // clamping to zero flattened the line whenever every value sat far from it.
  const pad = (rawMax - rawMin) * 0.15 || Math.max(Math.abs(rawMax), 1) * 0.15;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const range = max - min || 1;
  const n = points.length;
  const coords = points.map((p, i) => ({ x: (i / (n - 1)) * 100, y: 6 + (1 - (p.value - min) / range) * 88 }));
  const linePath = smoothPath(coords);
  const areaPath = `${linePath} L ${coords[n - 1].x} 100 L ${coords[0].x} 100 Z`;
  const hovered = hoverIndex != null ? coords[hoverIndex] : null;
  const hoveredPoint = hoverIndex != null ? points[hoverIndex] : null;
  const showZeroLine = min < 0 && max > 0;
  const zeroY = 6 + (1 - (0 - min) / range) * 88;

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * 100;
    const idx = Math.round((relX / 100) * (n - 1));
    setHoverIndex(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div className="trend-chart">
      <div className="trend-chart-canvas" onMouseMove={handleMove} onMouseLeave={() => setHoverIndex(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} className="trend-area-fill" />
          {showZeroLine && <line x1="0" y1={zeroY} x2="100" y2={zeroY} className="trend-zero-line" />}
          <path d={linePath} fill="none" className="trend-line" />
          {hovered && <line x1={hovered.x} y1="0" x2={hovered.x} y2="100" className="trend-crosshair" />}
        </svg>
        {hovered && <div className="trend-dot" style={{ left: `${hovered.x}%`, top: `${hovered.y}%` }} />}
        {hovered && hoveredPoint && (
          <div className="trend-tooltip" style={{ left: `${hovered.x}%`, top: `${hovered.y}%` }}>
            <b className={hoveredPoint.value >= 0 ? 'positive' : 'negative'}>{formatCurrency(hoveredPoint.value)}</b>
            <span>{hoveredPoint.label}</span>
          </div>
        )}
      </div>
      <div className="trend-chart-labels">
        {points.map((p, i) => <span key={i} className={hoverIndex === i ? 'active' : ''}>{p.label}</span>)}
      </div>
    </div>
  );
}

interface WaterfallItem { label: string; value: number; color: string; }

// Each bar floats from the running cumulative total to the next, cascading left-to-right,
// so the reader can see both each category's individual size and its contribution to the total.
function HorizontalWaterfallChart({ items, total, totalLabel }: { items: WaterfallItem[]; total: number; totalLabel: string }) {
  const scale = total || 1;
  let cumulative = 0;
  const rows = items.map(it => {
    const start = cumulative;
    cumulative += it.value;
    return { ...it, start, end: cumulative };
  });

  return (
    <div className="waterfall-chart">
      {rows.map(r => (
        <div className="waterfall-row" key={r.label}>
          <span className="waterfall-label" title={r.label}>{r.label}</span>
          <div className="waterfall-track">
            <div
              className="waterfall-bar"
              style={{ left: `${(r.start / scale) * 100}%`, width: `${Math.max(0, ((r.end - r.start) / scale) * 100)}%`, background: r.color }}
            />
          </div>
          <span className="waterfall-value">{formatCurrency(r.value)}</span>
        </div>
      ))}
      <div className="waterfall-row waterfall-row-total">
        <span className="waterfall-label">{totalLabel}</span>
        <div className="waterfall-track">
          <div className="waterfall-bar waterfall-bar-total" style={{ left: '0%', width: '100%' }} />
        </div>
        <span className="waterfall-value">{formatCurrency(total)}</span>
      </div>
    </div>
  );
}

export function FinanceBudgets() {
  const { data, upsert } = useStore();
  const [month, setMonth] = useState(monthKey());
  const { budgets, financeCategories: categories, transactions } = data;

  const actual = useMemo(() => actualSpendByCategory(transactions, month), [transactions, month]);
  const income = useMemo(() => monthlyIncome(transactions, month), [transactions, month]);

  const rows = useMemo(() => budgets
    .filter(b => b.month === month)
    .map(b => {
      const category = categories.find(c => c.id === b.categoryId);
      const rollover = rolloverAmount(b.categoryId, month, budgets, transactions);
      const effectiveLimit = b.limit + rollover;
      const spent = actual.get(b.categoryId) ?? 0;
      return { budget: b, category, rollover, effectiveLimit, spent };
    })
    .sort((a, b) => (a.category?.name ?? '').localeCompare(b.category?.name ?? '')),
  [budgets, month, categories, transactions, actual]);

  const totalPlanned = rows.reduce((s, r) => s + r.effectiveLimit, 0);
  const totalActual = rows.reduce((s, r) => s + r.spent, 0);
  const remaining = totalPlanned - totalActual;
  const savings = income - totalActual;
  const savingsRate = income > 0 ? Math.round((savings / income) * 100) : 0;

  const [trendRange, setTrendRange] = useState<6 | 12>(6);
  const cashFlowTrend = useMemo(() => {
    const months: string[] = [];
    for (let i = trendRange - 1; i >= 0; i--) months.push(shiftMonth(month, -i));
    return months.map(m => {
      const inc = monthlyIncome(transactions, m);
      const exp = transactions
        .filter(t => t.type === 'Expense' && t.date.startsWith(m))
        .reduce((s, t) => s + t.amount, 0);
      return { label: formatMonthLabel(m).replace(/ \d{4}$/, ''), value: inc - exp };
    });
  }, [month, trendRange, transactions]);
  const trendAvg = cashFlowTrend.length ? cashFlowTrend.reduce((s, p) => s + p.value, 0) / cashFlowTrend.length : 0;
  const trendCurrent = cashFlowTrend[cashFlowTrend.length - 1]?.value ?? 0;
  const trendPrev = cashFlowTrend[cashFlowTrend.length - 2]?.value;
  const trendDelta = trendPrev != null ? trendCurrent - trendPrev : null;

  // Expenses Summary rolls categories up by budgetGroup so a dozen near-identical 50/30/20
  // placeholder rows collapse into a couple of totals; expand a group to see individual categories.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [hideZeroActual, setHideZeroActual] = useState(true);
  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const expenseGroups = useMemo(() => {
    const order: { key: string; label: string }[] = [
      { key: 'Needs', label: 'Needs' },
      { key: 'Wants', label: 'Wants' },
      { key: 'Other', label: 'Uncategorized' }
    ];
    const byGroup = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.category?.budgetGroup ?? 'Other';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(r);
    }
    return order
      .filter(g => byGroup.has(g.key))
      .map(g => {
        const groupRows = byGroup.get(g.key)!.slice().sort((a, b) => (a.category?.name ?? '').localeCompare(b.category?.name ?? ''));
        return {
          key: g.key,
          label: g.label,
          rows: groupRows,
          totalBudget: groupRows.reduce((s, r) => s + r.effectiveLimit, 0),
          totalActual: groupRows.reduce((s, r) => s + r.spent, 0)
        };
      });
  }, [rows]);

  const monthlyDebtMinimums = useMemo(() => data.financeAccounts
    .filter(a => a.status !== 'Closed' && isLiabilityAccount(a.type))
    .reduce((s, a) => s + (a.minimumPayment ?? 0), 0),
  [data.financeAccounts]);
  const debtAccountsBase = useMemo(() => data.financeAccounts
    .filter(a => a.status !== 'Closed' && isLiabilityAccount(a.type)),
  [data.financeAccounts]);
  const [debtSort, setDebtSort] = useState<SortState<'name' | 'balance' | 'minPayment' | 'apr'>>({ key: 'balance', dir: 'desc' });
  const debtAccounts = useMemo(() => {
    const list = debtAccountsBase.slice();
    list.sort((a, b) => {
      let cmp = 0;
      if (debtSort.key === 'name') cmp = a.name.localeCompare(b.name);
      else if (debtSort.key === 'balance') cmp = a.balance - b.balance;
      else if (debtSort.key === 'minPayment') cmp = (a.minimumPayment ?? 0) - (b.minimumPayment ?? 0);
      else cmp = (a.interestRate ?? 0) - (b.interestRate ?? 0);
      return debtSort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [debtAccountsBase, debtSort]);

  const incomeSaved = useMemo(() => transactions
    .filter(t => t.type === 'Transfer' && t.date.startsWith(month))
    .reduce((s, t) => s + t.amount, 0),
  [transactions, month]);

  const upcomingBillsBase = useMemo(
    () => data.bills.filter(b => (b.kind ?? 'Bill') === 'Bill').sort((a, b) => a.nextDue.localeCompare(b.nextDue)).slice(0, 8),
    [data.bills]
  );
  const upcomingSubscriptionsBase = useMemo(
    () => data.bills.filter(b => b.kind === 'Subscription').sort((a, b) => a.nextDue.localeCompare(b.nextDue)).slice(0, 8),
    [data.bills]
  );
  const billsOnlyTotal = upcomingBillsBase.reduce((s, b) => s + b.amount, 0);
  const subscriptionsTotal = upcomingSubscriptionsBase.reduce((s, b) => s + b.amount, 0);
  const billsSummaryTotal = billsOnlyTotal + subscriptionsTotal;

  const sortRecurring = (list: typeof upcomingBillsBase, sort: SortState<'name' | 'due' | 'amount'>) => {
    const next = list.slice();
    next.sort((a, b) => {
      let cmp = 0;
      if (sort.key === 'name') cmp = a.name.localeCompare(b.name);
      else if (sort.key === 'due') cmp = a.nextDue.localeCompare(b.nextDue);
      else cmp = a.amount - b.amount;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return next;
  };
  const [billsSort, setBillsSort] = useState<SortState<'name' | 'due' | 'amount'>>({ key: 'due', dir: 'asc' });
  const upcomingBills = useMemo(() => sortRecurring(upcomingBillsBase, billsSort), [upcomingBillsBase, billsSort]);
  const [subsSort, setSubsSort] = useState<SortState<'name' | 'due' | 'amount'>>({ key: 'due', dir: 'asc' });
  const upcomingSubscriptions = useMemo(() => sortRecurring(upcomingSubscriptionsBase, subsSort), [upcomingSubscriptionsBase, subsSort]);

  const savingsMonthlyTotal = data.financeGoals.reduce((s, g) => s + requiredMonthlyContribution(g), 0);

  // Cash Flow Summary is derived entirely from the worksheet panels below it, so the two always agree:
  // Income Summary → Income, Bills Summary → Bills, Expenses Summary → Expenses,
  // Debt Payments → Debts, Savings → Savings (required monthly contribution across goals).
  const totalCashLeftOver = income - billsSummaryTotal - totalActual - monthlyDebtMinimums - savingsMonthlyTotal;

  // Waterfall only maps Expenses (never mixed with Income/Bills/Debts/Savings) so its total
  // bar always matches what it visually represents — top categories by spend, rest bucketed.
  const expenseBreakdownSorted = rows.filter(r => r.spent > 0).slice().sort((a, b) => b.spent - a.spent);
  const expenseBreakdownTop = expenseBreakdownSorted.slice(0, 6);
  const expenseBreakdownRestTotal = expenseBreakdownSorted.slice(6).reduce((s, r) => s + r.spent, 0);
  const expenseBreakdownSlices: WaterfallItem[] = [
    ...expenseBreakdownTop.map(r => ({ label: r.category?.name ?? 'Other', value: r.spent, color: r.category?.color || 'var(--text-faint)' })),
    ...(expenseBreakdownRestTotal > 0 ? [{ label: 'Other', value: expenseBreakdownRestTotal, color: 'var(--text-faint)' }] : [])
  ];

  const incomeRowsBase = useMemo(() => transactions
    .filter(t => t.type === 'Income' && t.date.startsWith(month)),
  [transactions, month]);
  const [incomeSort, setIncomeSort] = useState<SortState<'merchant' | 'date' | 'amount'>>({ key: 'date', dir: 'desc' });
  const incomeRows = useMemo(() => {
    const list = incomeRowsBase.slice();
    list.sort((a, b) => {
      let cmp = 0;
      if (incomeSort.key === 'merchant') cmp = a.merchant.localeCompare(b.merchant);
      else if (incomeSort.key === 'date') cmp = a.date.localeCompare(b.date);
      else cmp = a.amount - b.amount;
      return incomeSort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [incomeRowsBase, incomeSort]);

  const [savingsSort, setSavingsSort] = useState<SortState<'name' | 'target' | 'saved' | 'remaining' | 'monthly'>>({ key: 'name', dir: 'asc' });
  const sortedGoalRows = useMemo(() => {
    const list = data.financeGoals.map(g => ({
      goal: g,
      remaining: Math.max(0, g.targetAmount - g.currentAmount),
      monthly: requiredMonthlyContribution(g)
    }));
    list.sort((a, b) => {
      let cmp = 0;
      if (savingsSort.key === 'name') cmp = a.goal.name.localeCompare(b.goal.name);
      else if (savingsSort.key === 'target') cmp = a.goal.targetAmount - b.goal.targetAmount;
      else if (savingsSort.key === 'saved') cmp = a.goal.currentAmount - b.goal.currentAmount;
      else if (savingsSort.key === 'remaining') cmp = a.remaining - b.remaining;
      else cmp = a.monthly - b.monthly;
      return savingsSort.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [data.financeGoals, savingsSort]);
  const apply502030 = async () => {
    const suggestions = suggest502030(income, categories);
    for (const [categoryId, limit] of suggestions) {
      const existing = budgets.find(b => b.categoryId === categoryId && b.month === month);
      if (existing) {
        await upsert('budgets', { ...existing, limit });
      } else {
        await upsert('budgets', newRecord<Budget>({ categoryId, month, limit, rolloverEnabled: false }));
      }
    }
  };

  return (
    <>
      <div className="month-nav">
        <button type="button" className="icon-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month"><ChevronLeft size={16} /></button>
        <MonthYearPicker
          month={Number(month.slice(5, 7)) - 1}
          year={Number(month.slice(0, 4))}
          onChange={(m, y) => setMonth(`${y}-${String(m + 1).padStart(2, '0')}`)}
          triggerClassName="month-nav-title"
          triggerLabel={formatMonthLabel(month)}
        />
        <button type="button" className="icon-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month"><ChevronRight size={16} /></button>
        {month !== monthKey() && <button type="button" className="btn ghost small" onClick={() => setMonth(monthKey())}>Today</button>}
        <button type="button" className="btn ghost small" onClick={() => void apply502030()} disabled={income <= 0} title={income <= 0 ? 'No income recorded this month yet' : 'Distribute 50% of income across Needs, 30% across Wants'}>
          <Wand2 size={14} /> Apply 50/30/20
        </button>
      </div>

      <div className="kpi-grid four">
        <Kpi label="Monthly Income" value={formatCurrency(income)} caption={`${income > 0 ? 'this month' : 'no income logged yet'}`} tone="blue" />
        <Kpi label="Planned" value={formatCurrency(totalPlanned)} caption={`${rows.length} categor${rows.length === 1 ? 'y' : 'ies'} budgeted`} tone="default" />
        <Kpi label="Actual Spent" value={formatCurrency(totalActual)} caption={income > 0 ? `${Math.round((totalActual / income) * 100)}% of income` : undefined} tone={totalActual > totalPlanned ? 'red' : 'green'} />
        <Kpi label="Remaining" value={formatCurrency(remaining)} caption={`savings rate ${savingsRate}%`} tone={remaining < 0 ? 'red' : 'green'} />
      </div>

      <div className="budget-dashboard-grid">
        <div className="budget-dashboard-col-narrow">
          <Card className="budget-overview-card">
            <div className="card-title"><div><h2>Budget Overview</h2></div></div>
            <p className="muted mini-table-hint">Income minus category spending only — bills, debts, and savings goals aren't subtracted here.</p>
            <div className="mini-table-wrap">
              <table className="mini-table">
                <tbody>
                  <tr><td>Income Received</td><td>{formatCurrency(income)}</td></tr>
                  <tr><td>Actual Expenses</td><td>{formatCurrency(totalActual)}</td></tr>
                  <tr><td>Income Saved</td><td>{formatCurrency(incomeSaved)}</td></tr>
                  <tr className={`mini-table-highlight ${savings < 0 ? 'mini-table-highlight-negative' : ''}`}><td>Remaining Income</td><td><b className={savings >= 0 ? 'positive' : 'negative'}>{formatCurrency(savings)}</b></td></tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="budget-cashflow-table-card">
            <div className="card-title"><div><h2>Cash Flow Summary</h2></div></div>
            <p className="muted mini-table-hint">What's left after income also covers bills, debts, and every savings goal's required monthly contribution.</p>
            <div className="mini-table-wrap">
              <table className="mini-table">
                <tbody>
                  <tr className="mini-table-highlight"><td>Income</td><td>{formatCurrency(income)}</td></tr>
                  <tr><td>Bills</td><td>{formatCurrency(billsSummaryTotal)}</td></tr>
                  <tr><td>Expenses</td><td>{formatCurrency(totalActual)}</td></tr>
                  <tr><td>Savings</td><td>{formatCurrency(savingsMonthlyTotal)}</td></tr>
                  <tr><td>Debts</td><td>{formatCurrency(monthlyDebtMinimums)}</td></tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total Cash Left Over</td>
                    <td><b className={totalCashLeftOver >= 0 ? 'positive' : 'negative'}>{formatCurrency(totalCashLeftOver)}</b></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>

        <div className="budget-dashboard-col-wide">
          <Card className="budget-chart-card trend-card">
            <div className="trend-header-row">
              <h2>Cash Flow Over Time</h2>
              <div className="trend-range-toggle">
                <button type="button" className={trendRange === 6 ? 'on' : ''} onClick={() => setTrendRange(6)}>Last 6 Months</button>
                <button type="button" className={trendRange === 12 ? 'on' : ''} onClick={() => setTrendRange(12)}>Year to Date</button>
              </div>
            </div>
            <div className="trend-kpis">
              <div className="trend-kpi"><span>This Month</span><b className={trendCurrent >= 0 ? 'positive' : 'negative'}>{formatCurrency(trendCurrent)}</b></div>
              <div className="trend-kpi"><span>Avg / mo</span><b className={trendAvg >= 0 ? 'positive' : 'negative'}>{formatCurrency(trendAvg)}</b></div>
              {trendDelta != null && (
                <div className="trend-kpi"><span>vs Last Month</span><b className={trendDelta >= 0 ? 'positive' : 'negative'}>{trendDelta >= 0 ? '+' : ''}{formatCurrency(trendDelta)}</b></div>
              )}
            </div>
            <TrendAreaChart points={cashFlowTrend} />
          </Card>

          <Card className="budget-chart-card">
            <div className="card-title"><div><h2>Expenses Breakdown</h2></div></div>
            {expenseBreakdownSlices.length ? (
              <HorizontalWaterfallChart items={expenseBreakdownSlices} total={totalActual} totalLabel="Total Spent" />
            ) : <p className="muted empty-state">No expenses logged this month.</p>}
          </Card>
        </div>
      </div>

      <div className="budget-worksheets-grid">
          <Card className="worksheet-card">
            <div className="card-title"><div><h2>Income Summary</h2></div></div>
            {incomeRows.length ? (
              <div className="mini-table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <SortableTh label="Description" sortKey="merchant" state={incomeSort} onSort={k => setIncomeSort(s => toggleSort(s, k))} />
                      <SortableTh label="Date" sortKey="date" state={incomeSort} onSort={k => setIncomeSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="Amount" sortKey="amount" state={incomeSort} onSort={k => setIncomeSort(s => toggleSort(s, k, 'desc'))} />
                    </tr>
                  </thead>
                  <tbody>
                    {incomeRows.map(t => (
                      <tr key={t.id}><td>{t.merchant}</td><td>{formatDate(t.date)}</td><td>{formatCurrency(t.amount)}</td></tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={2}>Total</td><td>{formatCurrency(income)}</td></tr></tfoot>
                </table>
              </div>
            ) : <p className="muted empty-state">No income logged this month.</p>}
          </Card>

          <Card className="worksheet-card">
            <div className="card-title"><div><h2>Savings</h2></div></div>
            {data.financeGoals.length ? (
              <div className="mini-table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <SortableTh label="Goal" sortKey="name" state={savingsSort} onSort={k => setSavingsSort(s => toggleSort(s, k))} />
                      <SortableTh label="Target" sortKey="target" state={savingsSort} onSort={k => setSavingsSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="Saved" sortKey="saved" state={savingsSort} onSort={k => setSavingsSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="Remaining" sortKey="remaining" state={savingsSort} onSort={k => setSavingsSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="Monthly" sortKey="monthly" state={savingsSort} onSort={k => setSavingsSort(s => toggleSort(s, k, 'desc'))} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedGoalRows.map(({ goal: g, remaining, monthly }) => (
                      <tr key={g.id}>
                        <td>{g.name}</td>
                        <td>{formatCurrency(g.targetAmount)}</td>
                        <td>{formatCurrency(g.currentAmount)}</td>
                        <td>{formatCurrency(remaining)}</td>
                        <td>{formatCurrency(monthly)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td>{formatCurrency(data.financeGoals.reduce((s, g) => s + g.targetAmount, 0))}</td>
                      <td>{formatCurrency(data.financeGoals.reduce((s, g) => s + g.currentAmount, 0))}</td>
                      <td></td>
                      <td>{formatCurrency(savingsMonthlyTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : <p className="muted empty-state">No savings goals yet — add one on the Goals tab.</p>}
          </Card>

          <Card className="worksheet-card">
            <div className="card-title"><div><h2>Debt Payments</h2></div></div>
            {debtAccounts.length ? (
              <div className="mini-table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <SortableTh label="Account" sortKey="name" state={debtSort} onSort={k => setDebtSort(s => toggleSort(s, k))} />
                      <SortableTh label="Balance" sortKey="balance" state={debtSort} onSort={k => setDebtSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="Min. Payment" sortKey="minPayment" state={debtSort} onSort={k => setDebtSort(s => toggleSort(s, k, 'desc'))} />
                      <SortableTh label="APR" sortKey="apr" state={debtSort} onSort={k => setDebtSort(s => toggleSort(s, k, 'desc'))} />
                    </tr>
                  </thead>
                  <tbody>
                    {debtAccounts.map(a => (
                      <tr key={a.id}>
                        <td>{a.name}</td>
                        <td>{formatCurrency(a.balance)}</td>
                        <td>{formatCurrency(a.minimumPayment ?? 0)}</td>
                        <td>{(a.interestRate ?? 0).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td>{formatCurrency(debtAccounts.reduce((s, a) => s + a.balance, 0))}</td>
                      <td>{formatCurrency(monthlyDebtMinimums)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : <p className="muted empty-state">No debt accounts yet.</p>}
          </Card>

          <Card className="worksheet-card">
            <div className="card-title"><div><h2>Bills Summary</h2></div></div>
            {upcomingBills.length ? (
              <div className="mini-table-wrap">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <SortableTh label="Bill" sortKey="name" state={billsSort} onSort={k => setBillsSort(s => toggleSort(s, k))} />
                      <SortableTh label="Due" sortKey="due" state={billsSort} onSort={k => setBillsSort(s => toggleSort(s, k))} />
                      <SortableTh label="Amount" sortKey="amount" state={billsSort} onSort={k => setBillsSort(s => toggleSort(s, k, 'desc'))} />
                    </tr>
                  </thead>
                  <tbody>
                    {upcomingBills.map(b => (
                      <tr key={b.id}>
                        <td>{b.name}</td>
                        <td>{formatDate(b.nextDue)}</td>
                        <td>{formatCurrency(b.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={2}>Total</td><td>{formatCurrency(billsOnlyTotal)}</td></tr>
                  </tfoot>
                </table>
              </div>
            ) : <p className="muted empty-state">No bills yet.</p>}
          </Card>

        <Card className="worksheet-card">
          <div className="card-title">
            <div><h2>Expenses Summary</h2></div>
            <label className="expense-summary-toggle">
              <input type="checkbox" checked={hideZeroActual} onChange={e => setHideZeroActual(e.target.checked)} />
              Hide $0 categories
            </label>
          </div>
          {expenseGroups.length ? (
            <div className="mini-table-wrap">
              <table className="mini-table expense-summary-table">
                <thead><tr><th>Category</th><th>Budget</th><th>Actual</th><th>Remaining</th></tr></thead>
                <tbody>
                  {expenseGroups.map(group => {
                    const groupRemaining = group.totalBudget - group.totalActual;
                    const expanded = expandedGroups.has(group.key);
                    const visibleRows = group.rows.filter(r => !hideZeroActual || r.spent > 0);
                    const hiddenCount = group.rows.length - visibleRows.length;
                    return (
                      <Fragment key={group.key}>
                        <tr className="expense-group-row" onClick={() => toggleGroup(group.key)}>
                          <td>
                            <span className={`expense-group-chevron ${expanded ? 'open' : ''}`}><ChevronDown size={13} /></span>
                            <b>{group.label}</b> <small>({group.rows.length})</small>
                          </td>
                          <td>{formatCurrency(group.totalBudget)}</td>
                          <td>{formatCurrency(group.totalActual)}</td>
                          <td><span className={groupRemaining >= 0 ? 'positive' : 'negative'}>{formatCurrency(groupRemaining)}</span></td>
                        </tr>
                        {expanded && visibleRows.map(r => {
                          const rowRemaining = r.effectiveLimit - r.spent;
                          return (
                            <tr className="expense-subrow" key={r.budget.id}>
                              <td>{r.category?.name ?? 'Uncategorized'}</td>
                              <td>{formatCurrency(r.effectiveLimit)}</td>
                              <td>{formatCurrency(r.spent)}</td>
                              <td><span className={rowRemaining >= 0 ? 'positive' : 'negative'}>{formatCurrency(rowRemaining)}</span></td>
                            </tr>
                          );
                        })}
                        {expanded && hiddenCount > 0 && (
                          <tr className="expense-subrow expense-subrow-note">
                            <td colSpan={4}>{hiddenCount} categor{hiddenCount === 1 ? 'y' : 'ies'} with $0 actual hidden</td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr><td>Total</td><td>{formatCurrency(totalPlanned)}</td><td>{formatCurrency(totalActual)}</td><td>{formatCurrency(remaining)}</td></tr>
                </tfoot>
              </table>
            </div>
          ) : <p className="muted empty-state">No budgeted categories yet.</p>}
        </Card>

        <Card className="worksheet-card">
          <div className="card-title"><div><h2>Subscriptions Summary</h2></div></div>
          {upcomingSubscriptions.length ? (
            <div className="mini-table-wrap">
              <table className="mini-table">
                <thead>
                  <tr>
                    <SortableTh label="Subscription" sortKey="name" state={subsSort} onSort={k => setSubsSort(s => toggleSort(s, k))} />
                    <SortableTh label="Due" sortKey="due" state={subsSort} onSort={k => setSubsSort(s => toggleSort(s, k))} />
                    <SortableTh label="Amount" sortKey="amount" state={subsSort} onSort={k => setSubsSort(s => toggleSort(s, k, 'desc'))} />
                  </tr>
                </thead>
                <tbody>
                  {upcomingSubscriptions.map(b => (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td>{formatDate(b.nextDue)}</td>
                      <td>{formatCurrency(b.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={2}>Total</td><td>{formatCurrency(subscriptionsTotal)}</td></tr>
                </tfoot>
              </table>
            </div>
          ) : <p className="muted empty-state">No subscriptions yet.</p>}
        </Card>
      </div>

      <FinanceLedger />
    </>
  );
}
