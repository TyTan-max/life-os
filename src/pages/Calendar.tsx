import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, Clock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useStore, newRecord } from '../store';
import type { CalendarEvent } from '../types';
import { Modal, PageHeader, formatDate } from '../components/UI';
import { DatePicker } from '../components/DatePicker';
import { TimeWheelPicker } from '../components/TimeWheelPicker';
import { MonthYearPicker } from '../components/MonthYearPicker';
import { RichTextEditor } from '../components/RichTextEditor';
import { Sheet } from '../components/Sheet';
import { SwipeRow } from '../components/SwipeRow';
import { useIsMobile } from '../hooks/useIsMobile';
import { useFabAction } from '../hooks/useFabAction';
import { getHolidays } from '../data/holidays';

const DAY_POPOVER_WIDTH = 260;
const DAY_POPOVER_MAX_HEIGHT = 320;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function blankEvent(date?: string): Partial<CalendarEvent> {
  return { title: '', date: date ?? toIsoDate(new Date()) };
}

function formatFullDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

type ImportantKind = 'Event' | 'Task' | 'Goal' | 'Holiday';

interface ImportantDate {
  id: string;
  title: string;
  date: string;
  time?: string;
  kind: ImportantKind;
}

// Tasks and Goals no longer have their own pages — they live in Second Brain's tabs now.
const KIND_PAGE: Record<Exclude<ImportantKind, 'Event' | 'Holiday'>, string> = {
  Task: 'Second Brain',
  Goal: 'Second Brain'
};
const KIND_TAB: Record<Exclude<ImportantKind, 'Event' | 'Holiday'>, string> = {
  Task: 'Tasks',
  Goal: 'Goals'
};

const KIND_COLLECTION: Record<Exclude<ImportantKind, 'Holiday'>, 'events' | 'tasks' | 'goals'> = {
  Event: 'events',
  Task: 'tasks',
  Goal: 'goals'
};

export function Calendar({ navigate }: { navigate: (page: string, tab?: string) => void }) {
  const { data, upsert, remove, toggleTask } = useStore();
  const [anchor, setAnchor] = useState(() => new Date());
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<CalendarEvent>>(blankEvent());
  const mainRef = useRef<HTMLDivElement>(null);
  const [mainHeight, setMainHeight] = useState<number | null>(null);
  const [dayPopover, setDayPopover] = useState<{ date: string; top: number; left: number; placement: 'above' | 'below' } | null>(null);
  const isMobile = useIsMobile();
  // Agenda first on a phone: a 7-column grid yields ~46px cells, enough for a date and nothing
  // else. The grid stays one tap away for the genuinely spatial "how busy is this month" read.
  const [mobileView, setMobileView] = useState<'Agenda' | 'Month'>('Agenda');
  const [stripStart, setStripStart] = useState(() => { const d = new Date(); d.setHours(12, 0, 0, 0); return addDays(d, -d.getDay()); });
  const [daySheet, setDaySheet] = useState<string | null>(null);
  // Widening past the breakpoint (rotate to landscape, or a resized window) would otherwise
  // strand the sheet as a blocking overlay with no control left on screen to dismiss it.
  useEffect(() => { if (!isMobile) setDaySheet(null); }, [isMobile]);
  const closeTimer = useRef<number | null>(null);

  const cancelPopoverClose = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const schedulePopoverClose = () => {
    cancelPopoverClose();
    closeTimer.current = window.setTimeout(() => setDayPopover(null), 120);
  };
  useEffect(() => () => cancelPopoverClose(), []);

  const openDayPopover = (dateIso: string, rect: DOMRect) => {
    cancelPopoverClose();
    let left = rect.left;
    if (left + DAY_POPOVER_WIDTH > window.innerWidth - 8) left = Math.max(8, window.innerWidth - DAY_POPOVER_WIDTH - 8);
    let top = rect.bottom + 6;
    let placement: 'above' | 'below' = 'below';
    if (top + DAY_POPOVER_MAX_HEIGHT > window.innerHeight - 8) {
      top = rect.top - 6;
      placement = 'above';
    }
    setDayPopover({ date: dateIso, top, left, placement });
  };

  // Upcoming panel shrinks to fit its own content (no dead space when there's little to show),
  // but is capped to the calendar's rendered height so it never grows taller — and scrolls
  // internally once there's more content than that available space.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setMainHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const events = data.events.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));

  // Pulls in every other date-bearing item in the app — task due dates, goal target dates,
  // project due dates — plus federal holidays, religious/cultural observances, and seasonal
  // markers, alongside manually-created calendar events. Bill due dates are deliberately
  // excluded — those live on the Finance > Calendar tab instead.
  const importantDates: ImportantDate[] = useMemo(() => {
    const items: ImportantDate[] = events.map(e => ({ id: e.id, title: e.title || 'Untitled', date: e.date, time: e.startTime, kind: 'Event' }));
    data.tasks.forEach(t => {
      if (t.dueDate && t.status !== 'Completed') items.push({ id: t.id, title: t.title, date: t.dueDate, kind: 'Task' });
    });
    data.goals.forEach(g => {
      if (g.targetDate && g.status !== 'Completed') items.push({ id: g.id, title: g.title, date: g.targetDate, kind: 'Goal' });
    });
    // Cover both the currently-visible year and today's year (±1) so the grid stays correct
    // wherever you've navigated to, and the Upcoming list (always relative to today) doesn't run dry.
    const todayYear = new Date().getFullYear();
    const anchorYear = anchor.getFullYear();
    const years = Array.from(new Set([todayYear - 1, todayYear, todayYear + 1, anchorYear - 1, anchorYear, anchorYear + 1]));
    years.forEach(y => {
      getHolidays(y).forEach(h => items.push({ id: `${h.date}-${h.title}`, title: h.title, date: h.date, kind: 'Holiday' }));
    });
    return items.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
  }, [events, data.tasks, data.goals, anchor]);

  // Phone-only kind filters (the legend doubles as the toggle row). Holidays start hidden: the
  // agenda runs ~60 days ahead and most of that was holiday rows, burying the user's own items.
  const [hiddenKinds, setHiddenKinds] = useState<Set<ImportantKind>>(() => new Set<ImportantKind>(['Holiday']));
  const toggleKind = (kind: ImportantKind) => setHiddenKinds(prev => {
    const next = new Set(prev);
    if (next.has(kind)) next.delete(kind); else next.add(kind);
    return next;
  });
  const shownDates = useMemo(
    () => (isMobile ? importantDates.filter(item => !hiddenKinds.has(item.kind)) : importantDates),
    [importantDates, isMobile, hiddenKinds]
  );

  const itemsByDate = useMemo(() => {
    const map = new Map<string, ImportantDate[]>();
    shownDates.forEach(item => {
      const list = map.get(item.date) ?? [];
      list.push(item);
      map.set(item.date, list);
    });
    return map;
  }, [shownDates]);

  const todayIso = toIsoDate(new Date());
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const now = new Date();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth = new Date(year, month + 1, 0);
  const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay());
  const gridEnd = addDays(lastOfMonth, 6 - lastOfMonth.getDay());
  const totalCells = Math.round((gridEnd.getTime() - gridStart.getTime()) / 86400000) + 1;
  const cells: Date[] = [];
  for (let i = 0; i < totalCells; i++) cells.push(addDays(gridStart, i));
  const weeks: Date[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const upcoming = importantDates.filter(item => item.date >= todayIso && item.kind !== 'Holiday').slice(0, 15);

  // Agenda groups everything still ahead by day — on a phone "what's next" is the question being
  // asked. Holidays are part of that answer when their filter chip is on, even though they
  // aren't something you can open or delete.
  const agendaDays = useMemo(() => {
    const byDay = new Map<string, ImportantDate[]>();
    for (const item of shownDates) {
      if (item.date < todayIso) continue;
      if (!byDay.has(item.date)) byDay.set(item.date, []);
      byDay.get(item.date)!.push(item);
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, 60)
      .map(([date, items]) => ({
        date,
        items: items.slice().sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
      }));
  }, [shownDates, todayIso]);
  // Still-open tasks/goals whose date has passed. The agenda only looks forward, so these used to
  // vanish from it entirely the day after they were due — while the Dashboard kept counting them
  // as overdue. Pinned above Today instead, oldest first.
  const overdueItems = useMemo(
    () => shownDates.filter(item => item.date < todayIso && (item.kind === 'Task' || item.kind === 'Goal')),
    [shownDates, todayIso]
  );

  const startAdd = (date?: string) => { setForm(blankEvent(date)); setEditingId(null); setShowForm(true); };
  useFabAction('Calendar', 'New event', () => startAdd(todayIso));
  const startEdit = (event: CalendarEvent) => { setForm({ ...event }); setEditingId(event.id); setShowForm(true); };
  const cancel = () => { setShowForm(false); setEditingId(null); setForm(blankEvent()); };

  const openItem = (item: ImportantDate) => {
    if (item.kind === 'Event') {
      const event = events.find(e => e.id === item.id);
      if (event) startEdit(event);
      return;
    }
    if (item.kind === 'Holiday') return;
    navigate(KIND_PAGE[item.kind], KIND_TAB[item.kind]);
  };

  const deleteItem = async (item: ImportantDate) => {
    if (item.kind === 'Holiday') return;
    await remove(KIND_COLLECTION[item.kind], item.id);
  };

  // Phone agenda row. Swipe replaces the per-row trash icon (25px, and one mistap from deleting
  // something): left deletes, right completes a task. Neither is the only route — tapping opens
  // the event's editor (which has Delete) or the task/goal in Second Brain.
  const renderAgendaRow = (item: ImportantDate, sub: string) => {
    const key = `${item.kind}-${item.id}`;
    const row = (
      <div className="cal-agenda-row" onClick={() => item.kind !== 'Holiday' && openItem(item)}>
        <i className={`cal-dot kind-${item.kind.toLowerCase()}`} />
        <div className="cal-agenda-text">
          <b>{item.title}</b>
          <small>{sub}</small>
        </div>
      </div>
    );
    if (item.kind === 'Holiday') return <Fragment key={key}>{row}</Fragment>;
    const task = item.kind === 'Task' ? data.tasks.find(t => t.id === item.id) : undefined;
    return (
      <SwipeRow
        key={key}
        leading={task ? { label: 'Done', icon: <Check size={16} />, onTrigger: () => void toggleTask(task) } : undefined}
        trailing={{ label: 'Delete', icon: <Trash2 size={16} />, onTrigger: () => void deleteItem(item) }}
      >
        {row}
      </SwipeRow>
    );
  };

  const save = async () => {
    if (editingId) {
      const base = data.events.find(e => e.id === editingId);
      if (!base) return cancel();
      await upsert('events', { ...base, ...form } as CalendarEvent);
    } else {
      await upsert('events', newRecord<CalendarEvent>(form));
    }
    cancel();
  };

  const deleteEvent = async () => {
    if (!editingId) return;
    await remove('events', editingId);
    cancel();
  };

  const setField = <K extends keyof CalendarEvent>(key: K, value: CalendarEvent[K]) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle="Events, appointments, birthdays and deadlines."
        action={isMobile ? undefined : <button className="btn primary" onClick={() => startAdd()}><Plus size={16} /> New event</button>}
      />
      {showForm && (
        <Modal
          eyebrow="Life OS"
          title={editingId ? 'Edit event' : 'New event'}
          onClose={cancel}
          footer={<>
            {editingId && <button type="button" className="btn ghost cal-delete" onClick={() => void deleteEvent()}>Delete</button>}
            <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            <button type="button" className="btn teal" onClick={() => void save()}>Save</button>
          </>}
        >
          <div className="form-grid">
            <label><span>Title</span><input value={form.title ?? ''} onChange={e => setField('title', e.target.value)} /></label>
            <label><span>Date</span><DatePicker value={form.date} onChange={v => setField('date', v)} /></label>
            <label><span>Start time</span><TimeWheelPicker value={form.startTime} onChange={v => setField('startTime', v || undefined)} /></label>
            <label><span>End time</span><TimeWheelPicker value={form.endTime} onChange={v => setField('endTime', v || undefined)} /></label>
            <label><span>Location</span><input value={form.location ?? ''} onChange={e => setField('location', e.target.value)} /></label>
            <label className="inline">
              <input
                type="checkbox"
                checked={Boolean(form.reminderAt)}
                onChange={e => setField('reminderAt', e.target.checked ? `${form.date ?? toIsoDate(new Date())}T${form.startTime ?? '09:00'}` : undefined)}
              />
              <span>Remind me</span>
            </label>
            <label className="field-full"><span>Notes</span><RichTextEditor value={form.notes ?? ''} onChange={v => setField('notes', v)} /></label>
          </div>
        </Modal>
      )}

      {isMobile ? (
        // Doubles as the filter row on a phone — each kind toggles on/off.
        <div className="cal-legend cal-legend-filters" role="group" aria-label="Show on calendar">
          {(['Event', 'Task', 'Goal', 'Holiday'] as const).map(kind => (
            <button
              type="button"
              key={kind}
              className={`cal-legend-chip ${hiddenKinds.has(kind) ? '' : 'on'}`}
              aria-pressed={!hiddenKinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              <i className={`cal-dot kind-${kind.toLowerCase()}`} />{kind}
            </button>
          ))}
        </div>
      ) : (
        <div className="cal-legend">
          <span className="cal-legend-item"><i className="cal-dot kind-event" />Event</span>
          <span className="cal-legend-item"><i className="cal-dot kind-task" />Task</span>
          <span className="cal-legend-item"><i className="cal-dot kind-goal" />Goal</span>
          <span className="cal-legend-item"><i className="cal-dot kind-holiday" />Holiday</span>
        </div>
      )}

      {isMobile && (
        <div className="filter-row">
          <div className="segmented">
            {(['Agenda', 'Month'] as const).map(v => (
              <button type="button" key={v} className={mobileView === v ? 'on' : ''} onClick={() => setMobileView(v)}>{v}</button>
            ))}
          </div>
        </div>
      )}

      {isMobile && mobileView === 'Agenda' ? (
        <div className="cal-agenda">
          {/* This week at a glance: dots per day, tap for that day's sheet. */}
          <div className="cal-week-strip">
            <button type="button" className="cal-week-nav" onClick={() => setStripStart(addDays(stripStart, -7))} aria-label="Previous week"><ChevronLeft size={18} /></button>
            <div className="cal-week-days">
              {Array.from({ length: 7 }, (_, i) => addDays(stripStart, i)).map(day => {
                const iso = toIsoDate(day);
                const dayItems = itemsByDate.get(iso) ?? [];
                return (
                  <button
                    type="button"
                    key={iso}
                    className={`cal-week-day ${iso === todayIso ? 'is-today' : ''}`}
                    onClick={() => setDaySheet(iso)}
                    aria-label={`${formatFullDate(iso)}: ${dayItems.length} item${dayItems.length === 1 ? '' : 's'}`}
                  >
                    <small>{day.toLocaleDateString('en-US', { weekday: 'short' })}</small>
                    <b>{day.getDate()}</b>
                    <span className="cal-week-dots">
                      {dayItems.slice(0, 3).map(item => <i className={`cal-dot kind-${item.kind.toLowerCase()}`} key={`${item.kind}-${item.id}`} />)}
                    </span>
                  </button>
                );
              })}
            </div>
            <button type="button" className="cal-week-nav" onClick={() => setStripStart(addDays(stripStart, 7))} aria-label="Next week"><ChevronRight size={18} /></button>
          </div>

          {overdueItems.length > 0 && (
            <section className="cal-agenda-day">
              <h3 className="is-overdue">Overdue</h3>
              {overdueItems.map(item => renderAgendaRow(item, `Due ${formatDate(item.date)} · ${item.kind}`))}
            </section>
          )}
          {agendaDays.length ? agendaDays.map(({ date, items }) => (
            <section className="cal-agenda-day" key={date}>
              <h3 className={date === todayIso ? 'is-today' : ''}>
                {date === todayIso ? 'Today' : formatDate(date)}
              </h3>
              {items.map(item => renderAgendaRow(item, `${item.time ? `${item.time} · ` : ''}${item.kind}`))}
            </section>
          )) : (
            <div className="cal-upcoming-empty">
              <b>Nothing scheduled</b>
              <span>Add an event or appointment.</span>
            </div>
          )}
          {overdueItems.length + agendaDays.length > 0 && (
            <p className="cal-agenda-hint">Swipe left to delete{shownDates.some(i => i.kind === 'Task') ? ' · right to complete a task' : ''}</p>
          )}
        </div>
      ) : (
      <div className="cal-layout">
        <div className="card cal-main" ref={mainRef}>
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
            {weeks.map((week, wi) => (
              <Fragment key={wi}>
                {week.map(day => {
                  const iso = toIsoDate(day);
                  const inMonth = day.getMonth() === month;
                  const dayItems = itemsByDate.get(iso) ?? [];
                  const isToday = iso === todayIso;
                  return (
                    <div
                      key={iso}
                      className={`cal-cell ${!inMonth ? 'cal-cell-out' : ''}`}
                      // A ~46px cell can't hold a readable title, so on mobile the day opens a
                      // sheet instead of trying to render its events inline.
                      onClick={() => (isMobile ? setDaySheet(iso) : startAdd(iso))}
                      onMouseEnter={e => { if (!isMobile && dayItems.length > 0) openDayPopover(iso, e.currentTarget.getBoundingClientRect()); }}
                      onMouseLeave={isMobile ? undefined : schedulePopoverClose}
                    >
                      <span className={`cal-daynum ${isToday ? 'is-today' : ''}`}>{day.getDate()}</span>
                      {dayItems.length > 0 && isMobile && (
                        <div className="cal-cell-dots">
                          {dayItems.slice(0, 3).map(item => (
                            <i className={`cal-dot kind-${item.kind.toLowerCase()}`} key={`${item.kind}-${item.id}`} />
                          ))}
                        </div>
                      )}
                      {dayItems.length > 0 && !isMobile && (
                        <div className="cal-cell-events" onClick={ev => ev.stopPropagation()}>
                          {dayItems.map(item => (
                            item.kind === 'Holiday' ? (
                              <span className="cal-event-chip kind-holiday" key={`${item.kind}-${item.id}`}>{item.title}</span>
                            ) : (
                              <button
                                type="button"
                                className={`cal-event-chip kind-${item.kind.toLowerCase()}`}
                                key={`${item.kind}-${item.id}`}
                                onClick={() => openItem(item)}
                              >
                                {item.title}
                              </button>
                            )
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </div>

        {/* The month view already carries the agenda on mobile, so this side panel would just
            repeat it below the grid. */}
        {!isMobile && (
        <div className="card cal-upcoming" style={mainHeight ? { maxHeight: mainHeight } : undefined}>
          <div className="cal-upcoming-header"><Clock size={17} /><h2>Upcoming</h2></div>
          {upcoming.length ? (
            <div className="cal-upcoming-list">
              {upcoming.map(item => (
                <div className="cal-upcoming-row" key={`${item.kind}-${item.id}`} onClick={() => openItem(item)}>
                  <i className={`cal-dot kind-${item.kind.toLowerCase()}`} />
                  <div className="cal-upcoming-text">
                    <b>{item.title}</b>
                    <small>{formatDate(item.date)}{item.time ? ` · ${item.time}` : ''} · {item.kind}</small>
                  </div>
                  <button
                    type="button"
                    className="icon-btn danger cal-upcoming-remove"
                    onClick={ev => { ev.stopPropagation(); void deleteItem(item); }}
                    aria-label={`Delete ${item.title}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="cal-upcoming-empty">
              <b>Nothing scheduled</b>
              <span>Add an event or appointment.</span>
            </div>
          )}
        </div>
        )}
      </div>
      )}

      {daySheet && (
        <Sheet title={formatDate(daySheet)} onClose={() => setDaySheet(null)}>
          <div className="cal-day-sheet">
            {(itemsByDate.get(daySheet) ?? []).map(item => (
              <div
                className="cal-agenda-row"
                key={`${item.kind}-${item.id}`}
                onClick={() => { if (item.kind !== 'Holiday') { setDaySheet(null); openItem(item); } }}
              >
                <i className={`cal-dot kind-${item.kind.toLowerCase()}`} />
                <div className="cal-agenda-text">
                  <b>{item.title}</b>
                  <small>{item.time ? `${item.time} · ` : ''}{item.kind}</small>
                </div>
                {item.kind !== 'Holiday' && (
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={ev => { ev.stopPropagation(); void deleteItem(item); }}
                    aria-label={`Delete ${item.title}`}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {!(itemsByDate.get(daySheet) ?? []).length && <p className="muted">Nothing scheduled this day.</p>}
          </div>
          <div className="cal-day-sheet-actions">
            <button type="button" className="btn teal small" onClick={() => { const d = daySheet; setDaySheet(null); startAdd(d); }}>
              <Plus size={14} /> Add event
            </button>
          </div>
        </Sheet>
      )}

      {dayPopover && (itemsByDate.get(dayPopover.date)?.length ?? 0) > 0 && createPortal(
        <div
          className={`cal-day-popover placement-${dayPopover.placement}`}
          style={{
            position: 'fixed',
            left: dayPopover.left,
            width: DAY_POPOVER_WIDTH,
            maxHeight: DAY_POPOVER_MAX_HEIGHT,
            ...(dayPopover.placement === 'below'
              ? { top: dayPopover.top }
              : { bottom: window.innerHeight - dayPopover.top })
          }}
          onMouseEnter={cancelPopoverClose}
          onMouseLeave={schedulePopoverClose}
        >
          <div className="cal-day-popover-title">{formatFullDate(dayPopover.date)}</div>
          <div className="cal-day-popover-list">
            {(itemsByDate.get(dayPopover.date) ?? []).map(item => (
              item.kind === 'Holiday' ? (
                <div className="cal-day-popover-row" key={`${item.kind}-${item.id}`}>
                  <i className={`cal-dot kind-${item.kind.toLowerCase()}`} />
                  <div className="cal-upcoming-text">
                    <b>{item.title}</b>
                    <small>{item.kind}</small>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="cal-day-popover-row cal-day-popover-row-clickable"
                  key={`${item.kind}-${item.id}`}
                  onClick={() => { openItem(item); setDayPopover(null); }}
                >
                  <i className={`cal-dot kind-${item.kind.toLowerCase()}`} />
                  <div className="cal-upcoming-text">
                    <b>{item.title}</b>
                    <small>{item.time ? `${item.time} · ` : ''}{item.kind}</small>
                  </div>
                </button>
              )
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
