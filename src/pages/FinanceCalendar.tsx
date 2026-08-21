import { Fragment, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useStore } from '../store';
import { Card, formatCurrency, formatDate } from '../components/UI';
import { MonthYearPicker } from '../components/MonthYearPicker';
import { billOccurrences } from '../lib/cashFlowForecast';
import { detectSubscriptions } from '../lib/subscriptionDetector';

type EventKind = 'Bill' | 'Subscription' | 'Payday';

interface CalEvent {
  kind: EventKind;
  title: string;
  amount: number;
  date: string;
}

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

  const events = useMemo(() => {
    const list: CalEvent[] = [];
    for (const bill of data.bills) {
      for (const occ of billOccurrences(bill, monthStart, monthEnd)) {
        list.push({ kind: 'Bill', title: bill.name, amount: bill.amount, date: toIso(occ) });
      }
    }
    const monthStartIso = toIso(monthStart);
    const monthEndIso = toIso(monthEnd);
    for (const sub of detectSubscriptions(data.transactions, 'Expense')) {
      if (sub.nextExpectedDate >= monthStartIso && sub.nextExpectedDate <= monthEndIso) {
        list.push({ kind: 'Subscription', title: sub.merchant, amount: sub.monthlyEquivalent, date: sub.nextExpectedDate });
      }
    }
    for (const income of detectSubscriptions(data.transactions, 'Income')) {
      if (income.nextExpectedDate >= monthStartIso && income.nextExpectedDate <= monthEndIso) {
        list.push({ kind: 'Payday', title: income.merchant, amount: income.lastAmount, date: income.nextExpectedDate });
      }
    }
    return list;
  }, [data.bills, data.transactions, year, month]);

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
      for (const occ of billOccurrences(bill, start, end)) {
        list.push({ kind: 'Bill', title: bill.name, amount: bill.amount, date: toIso(occ) });
      }
    }
    const startIso = toIso(start);
    const endIso = toIso(end);
    for (const sub of detectSubscriptions(data.transactions, 'Expense')) {
      if (sub.nextExpectedDate >= startIso && sub.nextExpectedDate <= endIso) {
        list.push({ kind: 'Subscription', title: sub.merchant, amount: sub.monthlyEquivalent, date: sub.nextExpectedDate });
      }
    }
    for (const income of detectSubscriptions(data.transactions, 'Income')) {
      if (income.nextExpectedDate >= startIso && income.nextExpectedDate <= endIso) {
        list.push({ kind: 'Payday', title: income.merchant, amount: income.lastAmount, date: income.nextExpectedDate });
      }
    }
    return list.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
  }, [data.bills, data.transactions]);

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
                          <span key={i} className={`cal-event-chip kind-${e.kind.toLowerCase()}`}>{e.title}</span>
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
                    <div className="cal-upcoming-text"><b>{e.title}</b><small>{e.kind} · {formatCurrency(e.amount)}</small></div>
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
                  <div className="cal-upcoming-text"><b>{e.title}</b><small>{formatDate(e.date)} · {e.kind} · {formatCurrency(e.amount)}</small></div>
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
