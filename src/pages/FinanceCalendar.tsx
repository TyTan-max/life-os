import { Fragment, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useStore } from '../store';
import { Card, formatCurrency, formatDate } from '../components/UI';
import { MonthYearPicker } from '../components/MonthYearPicker';
import { billActiveDueDates, billOccurrences, isBillPaused } from '../lib/cashFlowForecast';
import { missedPaymentDates } from '../lib/billPayments';
import { detectSubscriptions } from '../lib/subscriptionDetector';
import { cardPayments } from '../lib/cardPayments';

type EventKind = 'Bill' | 'Subscription' | 'Payday';

interface CalEvent {
  kind: EventKind;
  title: string;
  amount: number;
  date: string;
  /** Already happened — a posted transaction this month, not a forecast. */
  paid?: boolean;
  /** Was due, the imported data covers it, and no matching charge was found. */
  missed?: boolean;
  /** Was due, but the imported transactions don't reach that far yet — can't say either way. */
  pending?: boolean;
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const sameName = (a: string, b: string) => {
  const x = normName(a); const y = normName(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
};

function toIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const gridStart = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

function formatFullDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function FinanceCalendar() {
  const { data } = useStore();
  const [anchor, setAnchor] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const now = new Date();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  const days = useMemo(() => buildGrid(year, month), [year, month]);
  const monthStart = new Date(year, month, 1, 0, 0, 0);
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59);

  // Recurring items, each listed once: tracked bills/subscriptions first; a subscription detected
  // from transactions only adds something when it isn't already a tracked bill.
  const detectedExpense = useMemo(
    () => detectSubscriptions(data.transactions, 'Expense').filter(s => !data.bills.some(b => sameName(b.name, s.merchant))),
    [data.transactions, data.bills]
  );
  const detectedIncome = useMemo(() => detectSubscriptions(data.transactions, 'Income'), [data.transactions]);

  const events = useMemo(() => {
    const list: CalEvent[] = [];
    const monthStartIso = toIso(monthStart);
    const monthEndIso = toIso(monthEnd);
    const nowIso = toIso(new Date());
    const recurring: { kind: EventKind; name: string; type: 'Expense' | 'Income' }[] = [
      ...data.bills.map(b => ({ kind: (b.kind === 'Subscription' ? 'Subscription' : 'Bill') as EventKind, name: b.name, type: 'Expense' as const })),
      ...detectedExpense.map(s => ({ kind: 'Subscription' as EventKind, name: s.merchant, type: 'Expense' as const })),
      ...detectedIncome.map(s => ({ kind: 'Payday' as EventKind, name: s.merchant, type: 'Income' as const }))
    ];
    // What already happened this month, from the actual transactions.
    for (const t of data.transactions) {
      if (t.date < monthStartIso || t.date > monthEndIso) continue;
      const match = recurring.find(r => r.type === t.type && sameName(r.name, t.merchant));
      if (match) list.push({ kind: match.kind, title: match.name, amount: t.amount, date: t.date, paid: true });
    }
    const alreadyPaid = (title: string, date: string) =>
      list.some(e => e.paid && e.title === title && Math.abs(new Date(e.date).getTime() - new Date(date).getTime()) <= 5 * 86400000);
    // What's still scheduled.
    for (const bill of data.bills) {
      const kind: EventKind = bill.kind === 'Subscription' ? 'Subscription' : 'Bill';
      const missed = new Set(missedPaymentDates(bill, data.transactions));
      for (const occ of billActiveDueDates(bill, monthStart, monthEnd)) {
        const date = toIso(occ);
        if (alreadyPaid(bill.name, date)) continue;
        const isMissed = missed.has(date);
        const pending = !isMissed && date < nowIso && !(bill.paidOverrides ?? []).includes(date);
        list.push({ kind, title: bill.name, amount: bill.amount, date, missed: isMissed, pending });
      }
      // Missed dates further back than one period still belong on their day.
      for (const date of missed) {
        if (date >= monthStartIso && date <= monthEndIso && !list.some(e => e.title === bill.name && e.date === date)) {
          list.push({ kind, title: bill.name, amount: bill.amount, date, missed: true });
        }
      }
    }
    // Credit card statement payments (a transfer, not spending — just what's due and whether it went out).
    for (const p of cardPayments(data.financeAccounts, data.transactions, nowIso)) {
      if (p.due < monthStartIso || p.due > monthEndIso) continue;
      list.push({ kind: 'Bill', title: `${p.account.name} payment`, amount: p.amount, date: p.due, paid: p.state === 'paid', missed: p.state === 'missed', pending: p.state === 'pending' });
    }
    for (const sub of detectedExpense) {
      if (sub.nextExpectedDate >= monthStartIso && sub.nextExpectedDate <= monthEndIso && !alreadyPaid(sub.merchant, sub.nextExpectedDate)) {
        list.push({ kind: 'Subscription', title: sub.merchant, amount: sub.monthlyEquivalent, date: sub.nextExpectedDate });
      }
    }
    for (const income of detectedIncome) {
      if (income.nextExpectedDate >= monthStartIso && income.nextExpectedDate <= monthEndIso && !alreadyPaid(income.merchant, income.nextExpectedDate)) {
        list.push({ kind: 'Payday', title: income.merchant, amount: income.lastAmount, date: income.nextExpectedDate });
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.bills, data.transactions, data.financeAccounts, detectedExpense, detectedIncome, year, month]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [events]);

  const todayIso = toIso(new Date());
  const selectedEvents = selectedDate ? (eventsByDate.get(selectedDate) ?? []) : [];

  // Independent of whatever month the grid is showing, so the panel always has something
  // useful to say by default instead of an empty "pick a day" prompt.
  const upcomingEvents = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = addDays(start, 60);
    const list: CalEvent[] = [];
    for (const bill of data.bills) {
      const next = billOccurrences(bill, start, end).find(d => !isBillPaused(bill, toIso(d)));
      if (next) list.push({ kind: bill.kind === 'Subscription' ? 'Subscription' : 'Bill', title: bill.name, amount: bill.amount, date: toIso(next) });
    }
    const startIso = toIso(start);
    const endIso = toIso(end);
    for (const p of cardPayments(data.financeAccounts, data.transactions, startIso)) {
      if (p.state === 'upcoming' && p.due <= endIso) list.push({ kind: 'Bill', title: `${p.account.name} payment`, amount: p.amount, date: p.due });
    }
    for (const sub of detectedExpense) {
      if (sub.nextExpectedDate >= startIso && sub.nextExpectedDate <= endIso) {
        list.push({ kind: 'Subscription', title: sub.merchant, amount: sub.monthlyEquivalent, date: sub.nextExpectedDate });
      }
    }
    for (const income of detectedIncome) {
      if (income.nextExpectedDate >= startIso && income.nextExpectedDate <= endIso) {
        list.push({ kind: 'Payday', title: income.merchant, amount: income.lastAmount, date: income.nextExpectedDate });
      }
    }
    return list.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10);
  }, [data.bills, data.financeAccounts, data.transactions, detectedExpense, detectedIncome]);

  const jumpToDate = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    setAnchor(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelectedDate(iso);
  };

  return (
    <>
      <div className="cal-legend">
        <span className="cal-legend-item"><i className="cal-dot kind-bill" />Bill</span>
        <span className="cal-legend-item"><i className="cal-dot kind-subscription" />Subscription renewal</span>
        <span className="cal-legend-item"><i className="cal-dot kind-payday" />Payday</span>
        <span className="cal-legend-item cal-legend-paid">✓ paid</span>
        <span className="cal-legend-item cal-legend-missed">⚠ no payment found</span>
        <span className="cal-legend-item cal-legend-pending">◌ waiting for import</span>
      </div>

      <div className="cal-layout">
        <Card className="cal-main">
          <div className="cal-nav">
            <button type="button" className="icon-btn" onClick={() => setAnchor(new Date(year, month - 1, 1))} aria-label="Previous month"><ChevronLeft size={18} /></button>
            <MonthYearPicker
              month={month}
              year={year}
              onChange={(m, y) => setAnchor(new Date(y, m, 1))}
              triggerLabel={anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            />
            <button type="button" className="icon-btn" onClick={() => setAnchor(new Date(year, month + 1, 1))} aria-label="Next month"><ChevronRight size={18} /></button>
            {!isCurrentMonth && (
              <button type="button" className="icon-btn" onClick={() => setAnchor(new Date())} aria-label="Return to current month" title="Return to current month">
                <RotateCcw size={15} />
              </button>
            )}
          </div>
          <div className="cal-grid">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div className="cal-weekday" key={d}>{d}</div>)}
            {days.map(day => {
              const iso = toIso(day);
              const inMonth = day.getMonth() === month;
              const dayEvents = eventsByDate.get(iso) ?? [];
              return (
                <Fragment key={iso}>
                  <div
                    className={`cal-cell ${!inMonth ? 'cal-cell-out' : ''} ${selectedDate === iso ? 'selected' : ''}`}
                    onClick={() => setSelectedDate(prev => prev === iso ? null : iso)}
                  >
                    <span className={`cal-daynum ${iso === todayIso ? 'is-today' : ''}`}>{day.getDate()}</span>
                    {dayEvents.length > 0 && (
                      <div className="cal-cell-events">
                        {dayEvents.map((e, i) => (
                          <span key={i} className={`cal-event-chip kind-${e.kind.toLowerCase()} ${e.paid ? 'paid' : ''} ${e.missed ? 'missed' : ''} ${e.pending ? 'pending' : ''}`} title={`${e.title} · ${formatCurrency(e.amount)}${e.paid ? ' · paid' : e.missed ? ' · no payment found' : e.pending ? ' · waiting for import' : ''}`}>{e.paid ? '✓ ' : e.missed ? '⚠ ' : e.pending ? '◌ ' : ''}{e.title}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </Card>

        <Card className="cal-upcoming">
          <div className="cal-upcoming-header"><h2>{selectedDate ? formatFullDate(selectedDate) : 'Upcoming'}</h2></div>
          {selectedDate ? (
            selectedEvents.length ? (
              <div className="cal-upcoming-list">
                {selectedEvents.map((e, i) => (
                  <div className="cal-upcoming-row" key={i}>
                    <i className={`cal-dot kind-${e.kind.toLowerCase()}`} />
                    <div className="cal-upcoming-text"><b>{e.title}</b><small>{e.paid ? 'Paid' : e.missed ? 'No payment found' : e.pending ? 'Waiting for import' : e.kind} · {formatCurrency(e.amount)}</small></div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cal-upcoming-empty"><b>Nothing scheduled</b><span>No bills, subscriptions, or paydays this day.</span></div>
            )
          ) : upcomingEvents.length ? (
            <div className="cal-upcoming-list">
              {upcomingEvents.map((e, i) => (
                <div className="cal-upcoming-row" key={i} onClick={() => jumpToDate(e.date)}>
                  <i className={`cal-dot kind-${e.kind.toLowerCase()}`} />
                  <div className="cal-upcoming-text"><b>{e.title}</b><small>Next due {formatDate(e.date)} · {e.kind} · {formatCurrency(e.amount)}</small></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="cal-upcoming-empty"><b>Nothing scheduled</b><span>No bills, subscriptions, or paydays in the next 60 days.</span></div>
          )}
        </Card>
      </div>
    </>
  );
}
