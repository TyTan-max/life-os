import { useMemo, useState } from 'react';
import {
  ArrowRight, Bell, BookOpen, Brain, Check, CheckCircle2, ChevronDown, Clapperboard,
  AlarmClock, CircleCheck, Flame, Gamepad2, HeartPulse, ListTodo, NotebookPen, NotebookText, Plane, Quote as QuoteIcon, Sparkles, TrendingUp, Users, Wallet
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useStore, newRecord } from '../store';
import { requestNoteFocus, useRecentNotes } from './AllNotes';
import type { Habit, Medication, Note, Task } from '../types';
import { DEFAULT_WORKSPACE_ID } from '../storage';
import { actualSpendByCategory } from '../lib/budgetMath';
import { computeDailyBrief } from '../lib/dailyBrief';
import { getSessionVerse } from '../lib/bibleVerses';
import { lastContactedDate, contactStatus } from '../lib/crmCadence';
import { getEffectiveRoutineFilter, loadSavedRoutineFilter, matchesRoutineFilter, sortRoutines } from '../lib/habitRoutines';
import { Badge, Card, ProgressBar, formatCurrency, formatDate } from '../components/UI';
import { useIsMobile } from '../hooks/useIsMobile';
import { useContextMenu } from '../components/ContextMenu';
import type { ContextMenuItem } from '../components/ContextMenu';
import { lastNightOf } from '../lib/sleep';
import { linkedTradingAccount } from '../lib/trading';
import { isBillPaused } from '../lib/cashFlowForecast';
import { missedPaymentDates } from '../lib/billPayments';
import { doseStatus, scheduledTimes, withDoseStatus } from '../lib/medications';
import type { DoseStatus } from '../lib/medications';

type DailyLog = { totalTrades:number; dailyPL:number; dailyFees:number };

function netOf(l: DailyLog): number {
  return l.dailyPL; // fees are display-only
}

function localIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2,'0');
  const day = String(date.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
}

// "06:00" → "6:00 AM", matching how reminders and events show times elsewhere on the page.
function fmtClock(hhmm?: string): string {
  if (!hhmm) return 'Any time';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function daysLate(due: string, today: string): number {
  return Math.round((new Date(`${today}T00:00:00`).getTime() - new Date(`${due}T00:00:00`).getTime()) / 86400000);
}

// Every top-row stat opens the page it summarizes.
function KpiLink({ label, value, caption, tone, onClick }: { label: string; value: ReactNode; caption: string; tone: string; onClick: () => void }) {
  return (
    // A zero is good news but not news — it stays grey so only live numbers draw the eye.
    <button type="button" className={`card kpi tone-${value === 0 ? 'muted' : tone} dashboard-kpi-link`} onClick={onClick} aria-label={`${label}: ${value} — open`}>
      <span>{label}</span><strong>{value}</strong><small>{caption}</small>
    </button>
  );
}

function scheduledDays(habit:Habit):number[] {
  if (Array.isArray(habit.scheduledDays) && habit.scheduledDays.length) return habit.scheduledDays;
  if (habit.frequency === 'Weekdays') return [1,2,3,4,5];
  if (habit.frequency === 'Weekly') return [0];
  return [0,1,2,3,4,5,6];
}

function currentWeekDates(date = new Date()) {
  const start = new Date(date.getFullYear(),date.getMonth(),date.getDate(),12);
  start.setDate(start.getDate()-start.getDay());
  return Array.from({length:7},(_,index)=>{
    const day=new Date(start);
    day.setDate(start.getDate()+index);
    return {date:localIso(day),dayIndex:day.getDay()};
  });
}

// A card with nothing demanding attention collapses to one summary line on mobile — the same
// "nothing here" content that used to cost ~150px of scroll for its own sake. `quiet` is the
// exact number already driving the urgency sort (0 = nothing to flag), so a card that floats to
// the top for having a live count also automatically stays expanded rather than hiding the
// thing that made it urgent in the first place.
function DashCard({
  className, orderStyle, icon, title, quiet, isMobile, expanded, onToggle, summary, action, children, empty
}: {
  className?: string; orderStyle?: React.CSSProperties; icon?: ReactNode; title: ReactNode;
  quiet: boolean; isMobile: boolean; expanded: boolean; onToggle: () => void;
  summary: ReactNode; action?: ReactNode; children: ReactNode;
  /** Desktop: when set, the card has nothing to show and collapses to this one line. */
  empty?: string | false;
}) {
  if (!isMobile && empty) {
    return (
      <Card className={`${className ?? ''} dash-card-empty`.trim()} style={orderStyle}>
        <div className="card-title"><div>{icon}<h2>{title}</h2></div>{action}</div>
        <p className="dash-empty-line">{empty}</p>
      </Card>
    );
  }
  const collapsible = isMobile && quiet;
  // Collapsed quiet cards render as half-width tiles on a phone (see .dash-tile) — two per row
  // instead of one full-width strip each; expanding one widens it back to full width.
  const tile = collapsible && !expanded;
  return (
    <Card className={`${className ?? ''} ${tile ? 'dash-tile' : ''}`.trim() || undefined} style={orderStyle}>
      <div
        className={`card-title ${collapsible ? 'dash-card-title-tap' : ''}`}
        onClick={collapsible ? onToggle : undefined}
        role={collapsible ? 'button' : undefined}
        aria-expanded={collapsible ? expanded : undefined}
      >
        <div>{icon}<h2>{title}</h2></div>
        {collapsible ? (
          <div className="dash-card-summary">
            <span>{summary}</span>
            <ChevronDown size={16} className={expanded ? 'dash-chevron on' : 'dash-chevron'} />
          </div>
        ) : action}
      </div>
      {(!collapsible || expanded) && children}
    </Card>
  );
}

export function Dashboard({navigate}:{navigate:(page:string, tab?: string)=>void}) {
  const { data, upsert, toggleTask } = useStore();
  const isMobile = useIsMobile();
  const [verse] = useState(getSessionVerse);
  const [captureText, setCaptureText] = useState('');
  const [captureFocused, setCaptureFocused] = useState(false);
  const today = localIso();
  const openTasks = data.tasks.filter(t=>t.status!=='Completed');
  const overdue = openTasks.filter(t=>t.dueDate<today);
  const dueToday = openTasks.filter(t=>t.dueDate===today);
  // Mirrors the Habits page's own routine scoping exactly (same saved selection, same fallback
  // to the first routine, same "show everything" baseline when no routines exist yet) — so the
  // Dashboard's snapshot never disagrees with whichever routine is actually selected there.
  const routines = sortRoutines(data.habitRoutines);
  const effectiveRoutineFilter = getEffectiveRoutineFilter(routines, loadSavedRoutineFilter());
  const habitsInRoutine = routines.length === 0 ? data.habits : data.habits.filter(h => matchesRoutineFilter(h, effectiveRoutineFilter));
  const activeHabits = habitsInRoutine.filter(h=>h.active !== false);
  const currentRoutineName = routines.find(r => r.id === effectiveRoutineFilter)?.name;
  const todayDayIndex = new Date().getDay();
  const habitsDueToday = activeHabits.filter(h=>scheduledDays(h).includes(todayDayIndex)).sort((a,b)=>(a.reminderAt||'99:99').localeCompare(b.reminderAt||'99:99'));
  const todayDone = habitsDueToday.filter(h=>h.checkins.includes(today)).length;
  const habitPct = Math.round(todayDone/Math.max(1,habitsDueToday.length)*100);
  const weekDates = currentWeekDates();
  const weekScheduled = weekDates.reduce((sum,day)=>sum+activeHabits.filter(h=>scheduledDays(h).includes(day.dayIndex)).length,0);
  const weekDone = activeHabits.reduce((sum,habit)=>sum+weekDates.filter(day=>scheduledDays(habit).includes(day.dayIndex)&&habit.checkins.includes(day.date)).length,0);
  const weekHabitPct = Math.round(weekDone/Math.max(1,weekScheduled)*100);
  const month = today.slice(0,7);
  const monthlyTransactions = data.transactions.filter(t=>t.date.startsWith(month));
  const income = monthlyTransactions.filter(t=>t.type==='Income').reduce((s,t)=>s+t.amount,0);
  const expenses = monthlyTransactions.filter(t=>t.type==='Expense').reduce((s,t)=>s+t.amount,0);
  const activeAccounts = data.financeAccounts.filter(a=>a.status==='Active');
  // Spendable today: bank + cash, minus what's on credit cards. Loans and investment/retirement
  // accounts are left out — that money isn't available to use right now.
  const LIQUID_TYPES = ['Checking', 'Savings', 'Cash'];
  const availableCash = activeAccounts.filter(a=>LIQUID_TYPES.includes(a.type)).reduce((s,a)=>s+a.balance,0)
    - activeAccounts.filter(a=>a.type==='Credit Card').reduce((s,a)=>s+a.balance,0);
  const lockedInvestments = activeAccounts.filter(a=>a.type==='Investment' || a.type==='Retirement').reduce((s,a)=>s+a.balance,0);
  const tradingAccount = linkedTradingAccount(activeAccounts);
  const excludedNote = [
    lockedInvestments ? `${formatCurrency(lockedInvestments)} in investments & retirement` : null,
    tradingAccount ? `${formatCurrency(tradingAccount.balance)} in trading` : null
  ].filter(Boolean).join(' · ');
  const monthBudgets = data.budgets.filter(b=>b.month===month);
  const spendByCategory = actualSpendByCategory(data.transactions, month);
  const overBudgetCount = monthBudgets.filter(b=>(spendByCategory.get(b.categoryId) ?? 0) > b.limit).length;
  const in7 = new Date(); in7.setDate(in7.getDate()+7);
  const in7Iso = localIso(in7);
  const upcomingBills = data.bills.filter(b=>(b.kind ?? 'Bill') === 'Bill' && b.nextDue>=today && b.nextDue<=in7Iso && !isBillPaused(b, b.nextDue));
  // Trading Journal moved to the real IndexedDB-backed store a while back — this card was never
  // updated off the old localStorage key it used to read, so it's been silently showing 0 days
  // logged / $0.00 regardless of actual data ever since.
  const tradingLogs = data.dailyLogs;
  const tradingPnl = tradingLogs.reduce((sum, log) => sum + netOf(log), 0);
  // Same formula as the Trading Journal page's own Current Balance: a configurable starting
  // balance plus all-time net (not scoped to any period, since this card has no date filter).
  const tradingCurrentBalance = (data.settings.tradingStartBalance ?? 50000) + tradingPnl;
  const tradingWinRate = tradingLogs.length ? Math.round((tradingLogs.filter(log => netOf(log) > 0).length / tradingLogs.length) * 100) : 0;
  const movies = data.movies.filter(m=>!m.needsReview);
  const videogames = data.videogames.filter(g=>!g.needsReview);
  const books = data.books.filter(b=>!b.needsReview);
  const backlogNeedsReview = data.movies.filter(m=>m.needsReview).length + data.videogames.filter(g=>g.needsReview).length + data.books.filter(b=>b.needsReview).length;
  const activeContacts = data.contacts.filter(c=>!c.archived);
  const contactsNeedingAttention = activeContacts.filter(c=>{
    const status = contactStatus(c, lastContactedDate(c.id, data.contactInteractions), today);
    return status==='Overdue' || status==='Never contacted';
  }).length;
  const upcomingCheckups = activeContacts.filter(c=>c.nextCheckup && c.nextCheckup>=today && c.nextCheckup<=in7Iso).length;
  const latestWeight = data.weightEntries.filter(e=>e.weight>0).sort((a,b)=>b.date.localeCompare(a.date))[0];
  const latestSleep = lastNightOf(data.sleepEntries);
  // Today's scheduled medication doses — the one Health item you act on every day.
  const doseRows = data.medications.flatMap(m => scheduledTimes(m, today).map(time => ({ med: m, time, status: doseStatus(m, today, time) })));
  const dosesLeft = doseRows.filter(d => d.status === 'pending').length;
  const toggleDose = (med: Medication, time: string, status: DoseStatus) =>
    void upsert('medications', withDoseStatus(med, today, time, status === 'taken' ? 'pending' : 'taken'));
  const billsTotal = upcomingBills.reduce((s, b) => s + b.amount, 0);
  // Bills that were due, are covered by imported data, and have no matching charge.
  const possiblyUnpaid = data.bills.map(b => ({ bill: b, dates: missedPaymentDates(b, data.transactions) })).filter(x => x.dates.length);
  const lowMeds = data.medications.filter(m=>m.active && m.pillsRemaining!=null && m.refillThreshold!=null && m.pillsRemaining<=m.refillThreshold).length;
  const thisYear = today.slice(0,4);
  const achievedThisYear = data.bucketList.filter(b=>b.status==='Achieved' && b.achievedAt?.startsWith(thisYear)).length;
  const nextTrip = data.bucketList
    .filter(b=>b.status==='Planning' && b.targetDate)
    .slice().sort((a,b)=>(a.targetDate ?? '').localeCompare(b.targetDate ?? ''))[0];
  const sbDueProjects = data.notes
    .filter(n=>n.paraType==='Project' && !n.archived && n.status!=='Completed' && n.dueDate && n.dueDate<=today)
    .sort((a,b)=>(a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
  const sbAreas = data.notes.filter(n=>n.paraType==='Area' && !n.archived);
  const sbSpotlightArea = sbAreas.slice().sort((a,b)=>(a.lastReviewedAt ?? '').localeCompare(b.lastReviewedAt ?? ''))[0];
  const nextReminders = useMemo(()=>{
    const rows = [
      ...openTasks.filter(t=>t.reminderAt).map(t=>({type:'Task',title:t.title,at:t.reminderAt!})),
      ...data.events.filter(e=>e.reminderAt||e.date>=today).map(e=>({type:'Event',title:e.title,at:e.reminderAt||`${e.date}T${e.startTime||'09:00'}`})),
      ...data.bills.filter(b=>b.nextDue>=today && !b.autopay && !isBillPaused(b, b.nextDue)).map(b=>({type:'Bill',title:`${b.name} (${formatCurrency(b.amount)})`,at:b.reminderAt||`${b.nextDue}T09:00`}))
    ];
    return rows.sort((a,b)=>a.at.localeCompare(b.at));
  },[data,openTasks,today]);
  const currentGoals = data.goals.filter(g=>g.status!=='Completed');
  const currentProjects = data.notes.filter(n=>n.paraType==='Project' && !n.archived && n.status!=='Completed');
  const overdueSorted = [...overdue].sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const upcomingTasks = openTasks.filter(t=>t.dueDate>today).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const focus = [...overdueSorted,...dueToday,...upcomingTasks];
  const focusGroups = ([
    ['Overdue', overdueSorted], ['Today', dueToday], ['Upcoming', upcomingTasks]
  ] as const).filter(([, items]) => items.length);
  // Shared with the scheduled notification (notifications.ts) via computeDailyBrief, so the card
  // and the notification you get at your chosen time can never say different things.
  const brief = computeDailyBrief(data, today);
  const toggleHabitToday=async(habit:Habit)=>{
    const completed=habit.checkins.includes(today);
    await upsert('habits',{...habit,checkins:completed?habit.checkins.filter(date=>date!==today):[...habit.checkins,today]});
  };
  // Same untyped-note capture as Second Brain's own Quick Capture — lands in its Inbox tab.
  const capture=async()=>{
    const text=captureText.trim();
    if(!text) return;
    const record=newRecord<Note>({title:'',body:text,tags:[],pinned:false,workspaceId:data.settings.activeSecondBrainWorkspaceId??DEFAULT_WORKSPACE_ID});
    await upsert('notes',record);
    setCaptureText('');
  };
  // The desktop grid works because peripheral vision does the triage — twelve cards are visible
  // at once and the eye finds the red one. On a phone they arrive one at a time, so that has to
  // be rebuilt in sequence: anything with a live count floats above the quiet cards, and within
  // each group the authored order holds. CSS `order` does this without restructuring the JSX.
  const slot = (base: number, attention = 0) =>
    (isMobile ? { order: attention > 0 ? base - 100 : base } : undefined);

  // Not persisted between visits, by design — per the earlier spec: reopening the dashboard
  // should read as "what's true right now," not restore whatever was left expanded last time.
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const { recent: recentNotes, total: notesTotal } = useRecentNotes(3);
  // The phone "Now" card's tab — a per-device convenience, so localStorage (guarded: private
  // windows and blocked storage throw) rather than synced settings.
  const [nowTab, setNowTab] = useState<'Habits' | 'Tasks' | 'Brief'>(() => {
    try {
      const saved = window.localStorage.getItem('lifeos.dashNowTab');
      return saved === 'Tasks' || saved === 'Brief' ? saved : 'Habits';
    } catch { return 'Habits'; }
  });
  const chooseNowTab = (tab: 'Habits' | 'Tasks' | 'Brief') => {
    setNowTab(tab);
    try { window.localStorage.setItem('lifeos.dashNowTab', tab); } catch { /* storage unavailable — just don't remember */ }
  };
  const toggleCard = (id: string) => setExpandedCards(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Right-click a task in Today's focus (desktop): complete, snooze, open.
  const { menu: contextMenu, openMenu } = useContextMenu();
  const snooze = (task: Task, days: number) => {
    const d = new Date(`${task.dueDate > today ? task.dueDate : today}T00:00:00`);
    d.setDate(d.getDate() + days);
    void upsert('tasks', { ...task, dueDate: localIso(d) });
  };
  const taskMenu = (task: Task): ContextMenuItem[] => [
    { label: 'Mark complete', icon: CircleCheck, onSelect: () => void toggleTask(task) },
    { label: 'Snooze to tomorrow', icon: AlarmClock, onSelect: () => snooze(task, 1) },
    { label: 'Snooze 1 week', icon: AlarmClock, onSelect: () => snooze(task, 7) },
    'separator',
    { label: 'Open in Second Brain', icon: ArrowRight, onSelect: () => navigate('Second Brain', 'Tasks') }
  ];

  // How late / when, instead of the same red "Overdue" pill on every row.
  const focusRow = (task: Task) => (
    <div className="task-focus" key={task.id} onContextMenu={e=>openMenu(e, taskMenu(task))}>
      <span className={`priority-dot ${task.priority.toLowerCase()}`}/>
      <div><b>{task.title}</b><small>{task.project||task.category}</small></div>
      <div className="focus-date">
        {task.dueDate < today ? <span className="dash-late">{daysLate(task.dueDate, today)}d late</span>
          : task.dueDate === today ? <Badge tone="warning">Today</Badge>
          : <span className="dash-due">{formatDate(task.dueDate)}</span>}
      </div>
    </div>
  );

  // Each card is built once and placed twice: a single urgency-ordered stack on a phone, three
  // columns on desktop (act now · today · pulse) so the whole dashboard fits one widescreen view.
  // One line until used; grows while focused or holding text, and the button appears once there's text.
  const captureOpen = captureFocused || Boolean(captureText);
  const headerCapture = (
  <div className={`dash-header-capture ${captureOpen ? 'open' : 'compact'}`}>
    <div className="dash-capture-row">
      <NotebookPen size={16}/>
      <textarea
        rows={captureOpen ? 4 : 1}
        placeholder="Quick capture to Second Brain…"
        value={captureText}
        onChange={e=>setCaptureText(e.target.value)}
        onFocus={()=>setCaptureFocused(true)}
        onBlur={()=>setCaptureFocused(false)}
        onKeyDown={e=>{
          if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); void capture(); }
          if(e.key==='Escape'){ (e.target as HTMLTextAreaElement).blur(); }
        }}
      />
    </div>
    {captureText.trim() && <button type="button" className="btn primary small full" onMouseDown={e=>e.preventDefault()} onClick={()=>void capture()}>Capture to Second Brain <kbd className="sb-kbd">Ctrl Enter</kbd></button>}
  </div>
  );
  const nowCard = (
  <Card className="dash-now" style={{ order: -200 }}>
    <div className="segmented dash-now-tabs" role="tablist" aria-label="Now">
      {/* Same icons the three desktop cards use, so the tabs read as those cards. */}
      {([
        ['Habits', 'Habits', Flame],
        ['Tasks', "Today's Focus", CheckCircle2],
        ['Brief', 'Brief', Sparkles]
      ] as const).map(([key, label, Icon]) => (
        <button type="button" key={key} role="tab" aria-selected={nowTab === key} className={nowTab === key ? 'on' : ''} onClick={() => chooseNowTab(key)}>
          <Icon size={14} aria-hidden="true" />{label}
        </button>
      ))}
    </div>
    {nowTab === 'Habits' && <>
      <div className="dash-now-meta"><span>{habitPct}% today · {weekHabitPct}% this week{currentRoutineName ? ` · ${currentRoutineName}` : ''}</span><button className="text-btn" onClick={()=>navigate('Habits')}>Open <ArrowRight size={15}/></button></div>
      <ProgressBar value={habitPct}/>
      {habitsDueToday.length ? <div className="dashboard-habit-list dash-now-habits">{habitsDueToday.map(habit=>{const done=habit.checkins.includes(today);return <button type="button" className={`dashboard-habit-row ${done?'done':''}`} key={habit.id} onClick={()=>void toggleHabitToday(habit)} aria-pressed={done}><span className="dashboard-habit-check"><Check size={13}/></span><span><b>{habit.name}</b><small>{fmtClock(habit.reminderAt)}</small></span></button>})}</div> : <p className="muted dashboard-habit-empty">No active habits are scheduled today.</p>}
    </>}
    {nowTab === 'Tasks' && <>
      <div className="dash-now-meta"><span>{overdue.length} overdue · {dueToday.length} due today</span><button className="text-btn" onClick={()=>navigate('Second Brain','Tasks')}>Open <ArrowRight size={15}/></button></div>
      {focus.length ? <div className="dash-now-tasks">{focus.slice(0, 6).map(focusRow)}</div> : <p className="muted">Nothing urgent. Add a task or plan ahead.</p>}
      {focus.length > 6 && <button className="text-btn dash-now-more" onClick={()=>navigate('Second Brain','Tasks')}>+{focus.length - 6} more <ArrowRight size={15}/></button>}
    </>}
    {nowTab === 'Brief' && <div className="brief-list">{brief.map((line,i)=><div key={line}><span>{i+1}</span><p>{line}</p></div>)}</div>}
  </Card>
  );
  const remindersCard = <Card style={slot(2, nextReminders.length)}><div className="card-title"><div><Bell size={19}/><h2>Coming up</h2></div><button className="text-btn" onClick={()=>navigate('Calendar')}>Open <ArrowRight size={15}/></button></div>{nextReminders.length?<div className="scroll-list">{nextReminders.map(r=><div className="list-row" key={`${r.type}-${r.at}-${r.title}`}><div><b>{r.title}</b><small>{r.type}</small></div><span>{new Date(r.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span></div>)}</div>:<p className="muted">No upcoming reminders yet.</p>}</Card>;
  const focusCard = (
    <Card className="span-2" style={slot(3, overdue.length + dueToday.length)}>
      <div className="card-title"><div><CheckCircle2 size={19}/><h2>Today's focus</h2></div><button className="text-btn" onClick={()=>navigate('Second Brain','Tasks')}>Open <ArrowRight size={15}/></button></div>
      {focus.length ? (
        <div className="scroll-list dash-focus-list">
          {focusGroups.map(([label, items]) => (
            <section key={label} className={`dash-focus-group ${label.toLowerCase()}`}>
              <h3>{label} <span>{items.length}</span></h3>
              {items.map(focusRow)}
            </section>
          ))}
        </div>
      ) : <p className="muted">Nothing urgent. Add a task or plan ahead.</p>}
    </Card>
  );
  const habitCard = <Card className="span-2 dashboard-habit-card" style={slot(4, habitsDueToday.length - todayDone)}><div className="card-title"><div><Flame size={19}/><h2>Habit tracker</h2>{currentRoutineName && <Badge>{currentRoutineName}</Badge>}</div><button className="text-btn" onClick={()=>navigate('Habits')}>Open <ArrowRight size={15}/></button></div><div className="dashboard-habit-summary"><div><span>Today</span><b>{todayDone}/{habitsDueToday.length}</b></div><div><span>This week</span><b>{weekHabitPct}%</b></div></div><ProgressBar value={habitPct}/>{habitsDueToday.length?<div className="dashboard-habit-list scroll-list">{habitsDueToday.map(habit=>{const done=habit.checkins.includes(today);return <button type="button" className={`dashboard-habit-row ${done?'done':''}`} key={habit.id} onClick={()=>void toggleHabitToday(habit)}><span className="dashboard-habit-check"><Check size={13}/></span><span><b>{habit.name}</b><small>{fmtClock(habit.reminderAt)}</small></span></button>})}</div>:<p className="muted dashboard-habit-empty">No active habits are scheduled today. Open Habits to adjust your schedule.</p>}</Card>;
  const healthCard = (
      <DashCard
        icon={<HeartPulse size={19}/>} title="Health" isMobile={isMobile}
        quiet={lowMeds === 0 && dosesLeft === 0} expanded={expandedCards.has('health')} onToggle={()=>toggleCard('health')}
        summary={`${dosesLeft ? `${dosesLeft} dose${dosesLeft===1?'':'s'} left` : 'Doses done'} · ${latestSleep?`${latestSleep.hours.toFixed(1)}h sleep`:'No sleep logged'}${lowMeds?` · ${lowMeds} refill${lowMeds===1?'':'s'}`:''}`}
        action={<button className="text-btn" onClick={()=>navigate('Health')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(5, lowMeds + dosesLeft)}
        empty={!doseRows.length && !latestWeight && !latestSleep && !lowMeds && 'No doses today · no weight or sleep logged'}
      >
        {doseRows.length ? (
          <div className="dash-doses">
            {doseRows.map(d => (
              <button
                type="button"
                key={`${d.med.id}-${d.time}`}
                className={`dashboard-habit-row dash-dose ${d.status === 'taken' ? 'done' : ''} ${d.status === 'skipped' ? 'skipped' : ''}`}
                onClick={() => toggleDose(d.med, d.time, d.status)}
                aria-pressed={d.status === 'taken'}
                title={d.status === 'taken' ? 'Taken — click to undo' : 'Mark as taken'}
              >
                <span className="dashboard-habit-check"><Check size={13}/></span>
                <span><b>{d.med.name}</b><small>{fmtClock(d.time)}{d.status === 'skipped' ? ' · skipped' : d.med.dosage ? ` · ${d.med.dosage}` : ''}</small></span>
              </button>
            ))}
          </div>
        ) : <p className="muted dash-doses-empty">No doses scheduled today.</p>}
        <div className="dash-health-line">
          <span>{latestWeight?`${latestWeight.weight} ${data.settings.weightUnit ?? 'lb'}`:'No weight'}</span>
          <span>{latestSleep?`${latestSleep.hours.toFixed(1)}h sleep`:'No sleep logged'}</span>
          <span className={lowMeds?'negative':''}>{lowMeds?`${lowMeds} refill${lowMeds===1?'':'s'} needed`:'Refills OK'}</span>
        </div>
      </DashCard>
  );
  const crmCard = (
      <DashCard
        icon={<Users size={19}/>} title="Personal CRM" isMobile={isMobile}
        quiet={contactsNeedingAttention + upcomingCheckups === 0} expanded={expandedCards.has('crm')} onToggle={()=>toggleCard('crm')}
        summary={`${activeContacts.length} active · ${contactsNeedingAttention?`${contactsNeedingAttention} need reach-out`:'all caught up'}`}
        action={<button className="text-btn" onClick={()=>navigate('Personal CRM')}>Open <ArrowRight size={15}/></button>}
        empty={!activeContacts.length && 'No contacts yet'}
        orderStyle={slot(6, contactsNeedingAttention + upcomingCheckups)}
      >
        <div className="metric-pair"><span>Active contacts</span><b>{activeContacts.length}</b></div>
        <div className="metric-pair"><span>Need reach-out</span><b className={contactsNeedingAttention?'negative':'positive'}>{contactsNeedingAttention}</b></div>
        <div className="metric-pair"><span>Check-ups this week</span><b>{upcomingCheckups}</b></div>
      </DashCard>
  );
  const notesCard = (
      <DashCard
        icon={<NotebookText size={19}/>} title="Recent notes" isMobile={isMobile}
        quiet expanded={expandedCards.has('notes')} onToggle={()=>toggleCard('notes')}
        summary={`${notesTotal} note${notesTotal===1?'':'s'} across the app`}
        action={<button className="text-btn" onClick={()=>navigate('All Notes')}>Open <ArrowRight size={15}/></button>}
        empty={!recentNotes.length && 'No notes written yet'}
        orderStyle={slot(9)}
      >
        <div className="dash-notes">
          {recentNotes.map(n => (
            <button type="button" key={n.id} className="dash-note" onClick={()=>{ requestNoteFocus(n.id); navigate('All Notes'); }}>
              <span><b>{n.source}</b> · {formatDate(n.date)}{n.context ? ` · ${n.context}` : ''}</span>
              <small>{n.parts[0].label ? `${n.parts[0].label.split(' · ')[0]}: ` : ''}{n.parts[0].text}</small>
            </button>
          ))}
        </div>
      </DashCard>
  );
  const tradingCard = (
      <DashCard
        icon={<TrendingUp size={19}/>} title="Trading journal" isMobile={isMobile}
        quiet expanded={expandedCards.has('trading')} onToggle={()=>toggleCard('trading')}
        summary={`${tradingLogs.length} days logged · Net ${tradingPnl>=0?'+':''}${tradingPnl.toFixed(2)}`}
        action={<button className="text-btn" onClick={()=>navigate('Trading Journal')}>Open <ArrowRight size={15}/></button>}
        empty={!tradingLogs.length && 'No trading days logged yet'}
        orderStyle={slot(7)}
      >
        <div className="metric-pair"><span>Current balance</span><b>{formatCurrency(tradingCurrentBalance)}</b></div>
        <div className="metric-pair"><span>Deposited</span><b>{formatCurrency(data.settings.tradingStartBalance ?? 50000)}</b></div>
        <div className="metric-pair"><span>Win rate</span><b>{tradingWinRate}%</b></div>
        <div className="metric-pair"><span>Net P/L</span><b className={tradingPnl >= 0 ? 'positive' : 'negative'}>{tradingPnl >= 0 ? '+' : ''}{tradingPnl.toFixed(2)}</b></div>
      </DashCard>
  );
  const travelCard = (
      <DashCard
        icon={<Plane size={19}/>} title="Travel & Bucket List" isMobile={isMobile}
        quiet expanded={expandedCards.has('travel')} onToggle={()=>toggleCard('travel')}
        summary={`${achievedThisYear} achieved this year`}
        action={<button className="text-btn" onClick={()=>navigate('Travel & Bucket List')}>Open <ArrowRight size={15}/></button>}
        empty={!data.bucketList.length && 'No goals yet'}
        orderStyle={slot(8)}
      >
        <div className="metric-pair"><span>Achieved this year</span><b>{achievedThisYear}</b></div>
        {nextTrip ? <div className="metric-pair"><span>Next up</span><b>{nextTrip.title}</b></div> : <p className="muted">No trips planned yet.</p>}
      </DashCard>
  );
  const financeCard = (
      <DashCard
        className="span-2" icon={<Wallet size={19}/>} title="Finance overview" isMobile={isMobile}
        quiet={overBudgetCount + upcomingBills.length + possiblyUnpaid.length === 0} expanded={expandedCards.has('finance')} onToggle={()=>toggleCard('finance')}
        summary={`${formatCurrency(availableCash)} available · ${overBudgetCount?`${overBudgetCount} over budget`:'on track'}`}
        action={<button className="text-btn" onClick={()=>navigate('Finance')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(9, overBudgetCount + upcomingBills.length)}
      >
        {possiblyUnpaid.length > 0 && (
          <button type="button" className="dash-unpaid-alert" onClick={()=>navigate('Finance')}>
            ⚠ {possiblyUnpaid.length} bill{possiblyUnpaid.length === 1 ? '' : 's'} may be unpaid — {possiblyUnpaid.slice(0, 2).map(x => `${x.bill.name} (${formatDate(x.dates[0])})`).join(', ')}
          </button>
        )}
        <div className="metric-pair dash-networth" title="Checking + Savings + Cash, minus credit card balances"><span>Available cash{excludedNote ? <small>Excl. {excludedNote}</small> : null}</span><b className={availableCash>=0?'positive':'negative'}>{formatCurrency(availableCash)}</b></div>
        <div className="metric-pair"><span>This month's income</span><b className="positive">{formatCurrency(income)}</b></div>
        <div className="metric-pair"><span>This month's expenses</span><b className="negative">{formatCurrency(expenses)}</b></div>
        <div className="metric-pair total"><span>Net cash flow</span><b>{formatCurrency(income-expenses)}</b></div>
        <div className="finance-overview-flags">
          <Badge tone={overBudgetCount?'danger':'success'}>{overBudgetCount ? `${overBudgetCount} over budget` : 'Budgets on track'}</Badge>
          <Badge tone={upcomingBills.length?'warning':'success'}>{upcomingBills.length ? `${upcomingBills.length} bill${upcomingBills.length===1?'':'s'} due soon` : 'No bills due soon'}</Badge>
        </div>
      </DashCard>
  );
  const backlogCard = (
      <DashCard
        icon={<ListTodo size={19}/>} title="Backlog" isMobile={isMobile}
        quiet={backlogNeedsReview === 0} expanded={expandedCards.has('backlog')} onToggle={()=>toggleCard('backlog')}
        summary={`${movies.filter(m=>m.status==='To Watch').length} to watch · ${books.filter(b=>b.status==='To Read').length} to read`}
        action={<button className="text-btn" onClick={()=>navigate('Movies')}>{backlogNeedsReview>0 ? `${backlogNeedsReview} need info` : 'Open'} <ArrowRight size={15}/></button>}
        orderStyle={slot(10, backlogNeedsReview)}
      >
        {/* Each count gets its own little column (number over label) so a row never runs past a narrow card. */}
        {([
          { key: 'Movies', label: 'Movies & TV', icon: <Clapperboard size={16}/>, counts: [
            [movies.filter(m=>m.status==='To Watch').length, 'to watch'], [movies.filter(m=>m.status==='Watching').length, 'watching'], [movies.filter(m=>m.status==='Watched').length, 'watched']] },
          { key: 'Videogames', label: 'Games', icon: <Gamepad2 size={16}/>, counts: [
            [videogames.filter(g=>g.status==='To Play').length, 'to play'], [videogames.filter(g=>g.status==='Playing').length, 'playing'], [videogames.filter(g=>g.status==='Completed').length, 'completed']] },
          { key: 'Books', label: 'Books', icon: <BookOpen size={16}/>, counts: [
            [books.filter(b=>b.status==='To Read').length, 'to read'], [books.filter(b=>b.status==='Reading').length, 'reading'], [books.filter(b=>b.status==='Read').length, 'read']] }
        ] as { key: string; label: string; icon: ReactNode; counts: [number, string][] }[]).map(row => (
          <button type="button" key={row.key} className="backlog-row" onClick={()=>navigate(row.key)}>
            <span className="backlog-row-label">{row.icon} {row.label}</span>
            <span className="backlog-row-counts">
              {row.counts.map(([n, label]) => <span key={label} className={n === 0 ? 'zero' : ''}><b>{n}</b><small>{label}</small></span>)}
            </span>
          </button>
        ))}
      </DashCard>
  );
  const secondBrainCard = (
      <DashCard
        className="span-2" icon={<Brain size={19}/>} title="Second Brain" isMobile={isMobile}
        quiet={sbDueProjects.length === 0} expanded={expandedCards.has('secondbrain')} onToggle={()=>toggleCard('secondbrain')}
        summary={`${sbDueProjects.length ? `${sbDueProjects.length} project${sbDueProjects.length===1?'':'s'} due` : 'Nothing due'} · ${openTasks.length} tasks · ${currentGoals.length} goals`}
        action={<button className="text-btn" onClick={()=>navigate('Second Brain')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(12, sbDueProjects.length)}
      >
        {sbDueProjects.length?<div className="scroll-list">{sbDueProjects.map(p=><div className="list-row" key={p.id}><div><b>{p.title||'Untitled'}</b>{p.nextAction && <small>{p.nextAction}</small>}</div><Badge tone={(p.dueDate ?? '')<today?'danger':'warning'}>{(p.dueDate ?? '')<today?'Overdue':'Today'}</Badge></div>)}</div>:<p className="muted">No projects due right now.</p>}
        <div className="sb-dash-area">
          <span>Area to review</span>
          {sbSpotlightArea?<><b>{sbSpotlightArea.title||'Untitled'}</b><small>{sbSpotlightArea.standard||'No standard set yet.'}</small></>:<small>No areas yet — create one in Second Brain.</small>}
        </div>
        <div className="sb-dash-counts">
          <button type="button" onClick={()=>navigate('Second Brain','Tasks')}><b>{openTasks.length}</b> open tasks</button>
          <button type="button" onClick={()=>navigate('Second Brain','Goals')}><b>{currentGoals.length}</b> goals</button>
          <button type="button" onClick={()=>navigate('Second Brain','Projects')}><b>{currentProjects.length}</b> projects</button>
        </div>
      </DashCard>
  );

  return <>
    <div className="welcome-row"><div><span className="eyebrow">{new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase()}</span><h1>Good {new Date().getHours()<12?'morning':new Date().getHours()<18?'afternoon':'evening'}, {data.settings.userName} 👋</h1><p className="dashboard-verse"><QuoteIcon size={14}/> "{verse.text}" <span>— {verse.reference}</span></p></div>{!isMobile && headerCapture}</div>
    <div className={`kpi-grid five ${isMobile ? "" : "dash-kpis"}`}>
      {/* Today only — longer-running numbers (net worth, reach-outs) live in their own cards below. */}
      <KpiLink label="Overdue" value={overdue.length} caption={overdue.length ? 'tasks past due' : 'nothing late'} tone={overdue.length ? 'red' : 'green'} onClick={()=>navigate('Second Brain','Tasks')}/>
      <KpiLink label="Due today" value={dueToday.length} caption="tasks scheduled today" tone={dueToday.length ? 'amber' : 'green'} onClick={()=>navigate('Second Brain','Tasks')}/>
      <KpiLink label="Habits left" value={habitsDueToday.length - todayDone} caption={`of ${habitsDueToday.length} scheduled today`} tone={habitsDueToday.length - todayDone ? 'amber' : 'green'} onClick={()=>navigate('Habits')}/>
      <KpiLink label="Meds due" value={dosesLeft} caption={doseRows.length ? `of ${doseRows.length} doses today` : 'none scheduled today'} tone={dosesLeft ? 'amber' : 'green'} onClick={()=>navigate('Health')}/>
      <KpiLink label="Bills this week" value={upcomingBills.length} caption={upcomingBills.length ? `${formatCurrency(billsTotal)} due in 7 days` : 'nothing due in 7 days'} tone={upcomingBills.length ? 'amber' : 'green'} onClick={()=>navigate('Finance')}/>
    </div>
    {contextMenu}
    {isMobile ? (
      <div className="dashboard-grid">
        {nowCard}{remindersCard}{healthCard}{crmCard}{tradingCard}{travelCard}{financeCard}{backlogCard}{secondBrainCard}{notesCard}
      </div>
    ) : (
      <div className="dash-cols">
        <div className="dash-col dash-col-act"><h3 className="dash-col-label">Today</h3>{focusCard}{remindersCard}</div>
        <div className="dash-col dash-col-today"><h3 className="dash-col-label">Routines &amp; plans</h3>{habitCard}{healthCard}{secondBrainCard}</div>
        <div className="dash-col dash-pulse">
          <h3 className="dash-col-label">Money &amp; life</h3>
          {financeCard}{tradingCard}{crmCard}{travelCard}{backlogCard}{notesCard}
        </div>
      </div>
    )}
  </>;
}
