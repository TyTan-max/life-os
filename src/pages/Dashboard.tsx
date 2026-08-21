import { useMemo, useState } from 'react';
import {
  ArrowRight, Bell, BookOpen, Brain, Check, CheckCircle2, ChevronDown, Clapperboard,
  Flame, Gamepad2, HeartPulse, ListTodo, NotebookPen, Plane, Quote as QuoteIcon, Sparkles, TrendingUp, Users, Video, Wallet
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useStore, newRecord } from '../store';
import type { Habit, Note } from '../types';
import { isLiabilityAccount } from './FinanceAccounts';
import { actualSpendByCategory } from '../lib/budgetMath';
import { getSessionVerse } from '../lib/bibleVerses';
import { lastContactedDate, contactStatus } from '../lib/crmCadence';
import { Badge, Card, Kpi, ProgressBar, formatCurrency, formatDate } from '../components/UI';
import { useIsMobile } from '../hooks/useIsMobile';

type DailyLog = { totalTrades:number; dailyPL:number; dailyFees:number };
type VideoSnapshot = { views:number; subscribersDelta:number };

function netOf(l: DailyLog): number {
  return l.dailyPL - l.dailyFees;
}

function loadLocalArray<T>(key: string): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function localIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2,'0');
  const day = String(date.getDate()).padStart(2,'0');
  return `${year}-${month}-${day}`;
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
  className, orderStyle, icon, title, quiet, isMobile, expanded, onToggle, summary, action, children
}: {
  className?: string; orderStyle?: React.CSSProperties; icon?: ReactNode; title: ReactNode;
  quiet: boolean; isMobile: boolean; expanded: boolean; onToggle: () => void;
  summary: ReactNode; action?: ReactNode; children: ReactNode;
}) {
  const collapsible = isMobile && quiet;
  return (
    <Card className={className} style={orderStyle}>
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
  const { data, upsert } = useStore();
  const isMobile = useIsMobile();
  const [verse] = useState(getSessionVerse);
  const [captureText, setCaptureText] = useState('');
  const today = localIso();
  const openTasks = data.tasks.filter(t=>t.status!=='Completed');
  const overdue = openTasks.filter(t=>t.dueDate<today);
  const dueToday = openTasks.filter(t=>t.dueDate===today);
  const activeHabits = data.habits.filter(h=>h.active !== false);
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
  const totalAssets = activeAccounts.filter(a=>!isLiabilityAccount(a.type)).reduce((s,a)=>s+a.balance,0);
  const totalLiabilities = activeAccounts.filter(a=>isLiabilityAccount(a.type)).reduce((s,a)=>s+a.balance,0);
  const netWorth = totalAssets - totalLiabilities;
  const monthBudgets = data.budgets.filter(b=>b.month===month);
  const spendByCategory = actualSpendByCategory(data.transactions, month);
  const overBudgetCount = monthBudgets.filter(b=>(spendByCategory.get(b.categoryId) ?? 0) > b.limit).length;
  const in7 = new Date(); in7.setDate(in7.getDate()+7);
  const in7Iso = localIso(in7);
  const upcomingBills = data.bills.filter(b=>(b.kind ?? 'Bill') === 'Bill' && b.nextDue>=today && b.nextDue<=in7Iso);
  const upcomingBillsTotal = upcomingBills.reduce((s,b)=>s+b.amount,0);
  const tradingLogs = loadLocalArray<DailyLog>('life-os-trading-journal-daily-v1');
  const youtubeSnapshots = loadLocalArray<VideoSnapshot>('life-os-youtube-analytics-v1');
  const tradingPnl = tradingLogs.reduce((sum, log) => sum + netOf(log), 0);
  const tradingWinRate = tradingLogs.length ? Math.round((tradingLogs.filter(log => netOf(log) > 0).length / tradingLogs.length) * 100) : 0;
  const tradingTotalTrades = tradingLogs.reduce((sum, log) => sum + (log.totalTrades || 0), 0);
  const youtubeViews = youtubeSnapshots.reduce((sum, item) => sum + Number(item.views || 0), 0);
  const youtubeSubs = youtubeSnapshots.reduce((sum, item) => sum + Number(item.subscribersDelta || 0), 0);
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
  const latestWeight = data.weightEntries.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
  const latestSleep = data.sleepEntries.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
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
      ...data.bills.filter(b=>b.nextDue>=today).map(b=>({type:'Bill',title:`${b.name} (${formatCurrency(b.amount)})`,at:b.reminderAt||`${b.nextDue}T09:00`}))
    ];
    return rows.sort((a,b)=>a.at.localeCompare(b.at));
  },[data,openTasks,today]);
  const annualGoals = data.goals.filter(g=>g.horizon==='Annual');
  const avgGoal = Math.round(annualGoals.reduce((s,g)=>s+g.progress,0)/Math.max(1,annualGoals.length));
  const focus = [...[...overdue].sort((a,b)=>a.dueDate.localeCompare(b.dueDate)),...dueToday,...openTasks.filter(t=>t.dueDate>today).sort((a,b)=>a.dueDate.localeCompare(b.dueDate))];
  const brief = [
    overdue.length ? `${overdue.length} overdue task${overdue.length===1?'':'s'} need attention.` : 'No overdue tasks.',
    habitsDueToday.length ? `${todayDone} of ${habitsDueToday.length} scheduled habits are complete today.` : 'No habits are scheduled today.',
    overBudgetCount ? `${overBudgetCount} budget categor${overBudgetCount===1?'y is':'ies are'} over their limit this month.` : upcomingBills.length ? `${upcomingBills.length} bill${upcomingBills.length===1?'':'s'} due in the next 7 days (${formatCurrency(upcomingBillsTotal)}).` : 'Budgets and bills are on track.',
    backlogNeedsReview ? `${backlogNeedsReview} backlog item${backlogNeedsReview===1?'':'s'} in Movies/Games/Books need info.` : tradingLogs.length ? `${tradingLogs.length} trading day${tradingLogs.length===1?'':'s'} logged (${tradingTotalTrades} trades) with ${tradingWinRate}% green days.` : 'Start logging trading days to build your scalping data.'
  ];
  const toggleHabitToday=async(habit:Habit)=>{
    const completed=habit.checkins.includes(today);
    await upsert('habits',{...habit,checkins:completed?habit.checkins.filter(date=>date!==today):[...habit.checkins,today]});
  };
  // Same untyped-note capture as Second Brain's own Quick Capture — lands in its Inbox tab.
  const capture=async()=>{
    const text=captureText.trim();
    if(!text) return;
    const record=newRecord<Note>({title:'',body:text,tags:[],pinned:false});
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
  const toggleCard = (id: string) => setExpandedCards(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return <>
    <div className="welcome-row"><div><span className="eyebrow">{new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase()}</span><h1>Good {new Date().getHours()<12?'morning':new Date().getHours()<18?'afternoon':'evening'}, {data.settings.userName} 👋</h1><p>Your local command center is ready.</p><p className="dashboard-verse"><QuoteIcon size={14}/> "{verse.text}" <span>— {verse.reference}</span></p></div><Badge tone="success">Local-first</Badge></div>
    <div className="kpi-grid five">
      <Kpi label="Overdue" value={overdue.length} caption="tasks past due" tone={overdue.length>0?'red':'green'}/>
      <Kpi label="Due today" value={dueToday.length} caption="scheduled today" tone={dueToday.length>0?'amber':'green'}/>
      <button type="button" className={`card kpi tone-${habitPct>=50?'green':'amber'} dashboard-kpi-link`} onClick={()=>navigate('Habits')} aria-label="Open Habit tracker"><span>Habits today</span><strong>{habitPct}%</strong><small>{todayDone}/{habitsDueToday.length} scheduled habits completed</small></button>
      <button type="button" className={`card kpi tone-${netWorth>=0?'green':'red'} dashboard-kpi-link`} onClick={()=>navigate('Finance')} aria-label="Open Finance"><span>Net worth</span><strong>{formatCurrency(netWorth)}</strong><small>{activeAccounts.length} active account{activeAccounts.length===1?'':'s'}</small></button>
      <button type="button" className={`card kpi tone-${contactsNeedingAttention>0?'red':'green'} dashboard-kpi-link`} onClick={()=>navigate('Personal CRM')} aria-label="Open Personal CRM"><span>Reach out</span><strong>{contactsNeedingAttention}</strong><small>contact{contactsNeedingAttention===1?'':'s'} overdue or never contacted</small></button>
    </div>
    <div className="dashboard-grid">
      {/* The centre FAB owns capture on mobile — this card would be a second door to the same
          room, costing ~180px at the top of the scroll. */}
      {!isMobile && (
      <Card className="dashboard-quick-capture"><div className="card-title"><div><NotebookPen size={19}/><h2>Quick capture</h2></div></div>
        <textarea
          rows={6}
          placeholder="Quick capture — dump a thought, link, or task…"
          value={captureText}
          onChange={e=>setCaptureText(e.target.value)}
          onKeyDown={e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); void capture(); } }}
        />
        <button type="button" className="btn primary small full" onClick={()=>void capture()} disabled={!captureText.trim()}>Capture to Second Brain</button>
      </Card>
      )}
      <Card className="span-2 smart-brief" style={isMobile ? { order: -200 } : undefined}><div className="card-title"><div><Sparkles size={19}/><h2>Smart daily brief</h2></div><Badge>Rule-based v0.4</Badge></div><div className="brief-list">{brief.map((line,i)=><div key={line}><span>{i+1}</span><p>{line}</p></div>)}</div></Card>
      <Card style={slot(2, nextReminders.length)}><div className="card-title"><div><Bell size={19}/><h2>Next reminders</h2></div></div>{nextReminders.length?<div className="scroll-list">{nextReminders.map(r=><div className="list-row" key={`${r.type}-${r.at}-${r.title}`}><div><b>{r.title}</b><small>{r.type}</small></div><span>{new Date(r.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</span></div>)}</div>:<p className="muted">No upcoming reminders yet.</p>}</Card>
      <Card className="span-2" style={slot(3, overdue.length + dueToday.length)}><div className="card-title"><div><CheckCircle2 size={19}/><h2>Today's focus</h2></div><button className="text-btn" onClick={()=>navigate('Second Brain','Tasks')}>Open tasks <ArrowRight size={15}/></button></div>{focus.length?<div className="scroll-list">{focus.map(task=><div className="task-focus" key={task.id}><span className={`priority-dot ${task.priority.toLowerCase()}`}/><div><b>{task.title}</b><small>{task.project||task.category}</small></div><div className="focus-date"><Badge tone={task.dueDate<today?'danger':task.dueDate===today?'warning':''}>{task.dueDate<today?'Overdue':task.dueDate===today?'Today':formatDate(task.dueDate)}</Badge></div></div>)}</div>:<p className="muted">Nothing urgent. Add a task or plan ahead.</p>}</Card>
      <Card className="span-2 dashboard-habit-card" style={slot(4, habitsDueToday.length - todayDone)}><div className="card-title"><div><Flame size={19}/><h2>Habit tracker</h2></div><button className="text-btn" onClick={()=>navigate('Habits')}>Open habits <ArrowRight size={15}/></button></div><div className="dashboard-habit-summary"><div><span>Today</span><b>{todayDone}/{habitsDueToday.length}</b></div><div><span>This week</span><b>{weekHabitPct}%</b></div></div><ProgressBar value={habitPct}/>{habitsDueToday.length?<div className="dashboard-habit-list scroll-list">{habitsDueToday.map(habit=>{const done=habit.checkins.includes(today);return <button type="button" className={`dashboard-habit-row ${done?'done':''}`} key={habit.id} onClick={()=>void toggleHabitToday(habit)}><span className="dashboard-habit-check"><Check size={13}/></span><span><b>{habit.name}</b><small>{habit.reminderAt||'Any time'}</small></span></button>})}</div>:<p className="muted dashboard-habit-empty">No active habits are scheduled today. Open Habits to adjust your schedule.</p>}</Card>
      <DashCard
        icon={<HeartPulse size={19}/>} title="Health" isMobile={isMobile}
        quiet={lowMeds === 0} expanded={expandedCards.has('health')} onToggle={()=>toggleCard('health')}
        summary={`${latestSleep?`${latestSleep.durationHours.toFixed(1)}h sleep`:'No sleep logged'} · ${lowMeds?`${lowMeds} refill${lowMeds===1?'':'s'} needed`:'meds on track'}`}
        action={<button className="text-btn" onClick={()=>navigate('Health')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(5, lowMeds)}
      >
        <div className="metric-pair"><span>Latest weight</span><b>{latestWeight?`${latestWeight.weight} ${data.settings.weightUnit ?? 'lb'}`:'—'}</b></div>
        <div className="metric-pair"><span>Last night's sleep</span><b>{latestSleep?`${latestSleep.durationHours.toFixed(1)}h`:'—'}</b></div>
        <div className="metric-pair"><span>Refills needed</span><b className={lowMeds?'negative':'positive'}>{lowMeds}</b></div>
      </DashCard>
      <DashCard
        icon={<Users size={19}/>} title="Personal CRM" isMobile={isMobile}
        quiet={contactsNeedingAttention + upcomingCheckups === 0} expanded={expandedCards.has('crm')} onToggle={()=>toggleCard('crm')}
        summary={`${activeContacts.length} active · ${contactsNeedingAttention?`${contactsNeedingAttention} need reach-out`:'all caught up'}`}
        action={<button className="text-btn" onClick={()=>navigate('Personal CRM')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(6, contactsNeedingAttention + upcomingCheckups)}
      >
        <div className="metric-pair"><span>Active contacts</span><b>{activeContacts.length}</b></div>
        <div className="metric-pair"><span>Need reach-out</span><b className={contactsNeedingAttention?'negative':'positive'}>{contactsNeedingAttention}</b></div>
        <div className="metric-pair"><span>Check-ups this week</span><b>{upcomingCheckups}</b></div>
      </DashCard>
      <DashCard
        icon={<TrendingUp size={19}/>} title="Trading journal" isMobile={isMobile}
        quiet expanded={expandedCards.has('trading')} onToggle={()=>toggleCard('trading')}
        summary={`${tradingLogs.length} days logged · Net ${tradingPnl>=0?'+':''}${tradingPnl.toFixed(2)}`}
        action={<button className="text-btn" onClick={()=>navigate('Trading Journal')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(7)}
      >
        <div className="metric-pair"><span>Days logged</span><b>{tradingLogs.length}</b></div>
        <div className="metric-pair"><span>Green days</span><b>{tradingWinRate}%</b></div>
        <div className="metric-pair"><span>Net P/L</span><b className={tradingPnl >= 0 ? 'positive' : 'negative'}>{tradingPnl >= 0 ? '+' : ''}{tradingPnl.toFixed(2)}</b></div>
      </DashCard>
      <DashCard
        icon={<Video size={19}/>} title="YouTube analytics" isMobile={isMobile}
        quiet expanded={expandedCards.has('youtube')} onToggle={()=>toggleCard('youtube')}
        summary={`${youtubeSnapshots.length} tracked upload${youtubeSnapshots.length===1?'':'s'}`}
        action={<button className="text-btn" onClick={()=>navigate('YouTube Analytics')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(8)}
      >
        <div className="metric-pair"><span>Tracked uploads</span><b>{youtubeSnapshots.length}</b></div>
        <div className="metric-pair"><span>Total views</span><b>{youtubeViews.toLocaleString('en-US')}</b></div>
        <div className="metric-pair"><span>Subscriber delta</span><b>{youtubeSubs >= 0 ? '+' : ''}{youtubeSubs}</b></div>
      </DashCard>
      <DashCard
        className="span-2" icon={<Wallet size={19}/>} title="Finance overview" isMobile={isMobile}
        quiet={overBudgetCount + upcomingBills.length === 0} expanded={expandedCards.has('finance')} onToggle={()=>toggleCard('finance')}
        summary={`${formatCurrency(netWorth)} net worth · ${overBudgetCount?`${overBudgetCount} over budget`:'on track'}`}
        action={<button className="text-btn" onClick={()=>navigate('Finance')}>Open Finance <ArrowRight size={15}/></button>}
        orderStyle={slot(9, overBudgetCount + upcomingBills.length)}
      >
        <div className="metric-pair"><span>Net worth</span><b className={netWorth>=0?'positive':'negative'}>{formatCurrency(netWorth)}</b></div>
        <div className="metric-pair"><span>This month's income</span><b className="positive">{formatCurrency(income)}</b></div>
        <div className="metric-pair"><span>This month's expenses</span><b className="negative">{formatCurrency(expenses)}</b></div>
        <div className="metric-pair total"><span>Net cash flow</span><b>{formatCurrency(income-expenses)}</b></div>
        <div className="finance-overview-flags">
          <Badge tone={overBudgetCount?'danger':'success'}>{overBudgetCount ? `${overBudgetCount} over budget` : 'Budgets on track'}</Badge>
          <Badge tone={upcomingBills.length?'warning':'success'}>{upcomingBills.length ? `${upcomingBills.length} bill${upcomingBills.length===1?'':'s'} due soon` : 'No bills due soon'}</Badge>
        </div>
      </DashCard>
      <DashCard
        className="span-2" icon={<ListTodo size={19}/>} title="Backlog" isMobile={isMobile}
        quiet={backlogNeedsReview === 0} expanded={expandedCards.has('backlog')} onToggle={()=>toggleCard('backlog')}
        summary={`${movies.filter(m=>m.status==='To Watch').length} to watch · ${books.filter(b=>b.status==='To Read').length} to read`}
        action={backlogNeedsReview>0 ? <button className="text-btn" onClick={()=>navigate('Movies')}>{backlogNeedsReview} need info <ArrowRight size={15}/></button> : undefined}
        orderStyle={slot(10, backlogNeedsReview)}
      >
        <button type="button" className="backlog-row" onClick={()=>navigate('Movies')}>
          <span className="backlog-row-label"><Clapperboard size={16}/> Movies &amp; TV</span>
          <span className="backlog-row-counts"><b>{movies.filter(m=>m.status==='To Watch').length}</b> to watch<span className="backlog-row-sep">·</span><b>{movies.filter(m=>m.status==='Watching').length}</b> watching</span>
        </button>
        <button type="button" className="backlog-row" onClick={()=>navigate('Videogames')}>
          <span className="backlog-row-label"><Gamepad2 size={16}/> Games</span>
          <span className="backlog-row-counts"><b>{videogames.filter(g=>g.status==='To Play').length}</b> to play<span className="backlog-row-sep">·</span><b>{videogames.filter(g=>g.status==='Playing').length}</b> playing</span>
        </button>
        <button type="button" className="backlog-row" onClick={()=>navigate('Books')}>
          <span className="backlog-row-label"><BookOpen size={16}/> Books</span>
          <span className="backlog-row-counts"><b>{books.filter(b=>b.status==='To Read').length}</b> to read<span className="backlog-row-sep">·</span><b>{books.filter(b=>b.status==='Reading').length}</b> reading</span>
        </button>
      </DashCard>
      <DashCard
        icon={<Plane size={19}/>} title="Travel & Bucket List" isMobile={isMobile}
        quiet expanded={expandedCards.has('travel')} onToggle={()=>toggleCard('travel')}
        summary={`${achievedThisYear} achieved this year`}
        action={<button className="text-btn" onClick={()=>navigate('Travel & Bucket List')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(11)}
      >
        <div className="metric-pair"><span>Achieved this year</span><b>{achievedThisYear}</b></div>
        {nextTrip ? <div className="metric-pair"><span>Next up</span><b>{nextTrip.title}</b></div> : <p className="muted">No trips planned yet.</p>}
      </DashCard>
      <DashCard
        className="span-2" icon={<Brain size={19}/>} title="Second Brain" isMobile={isMobile}
        quiet={sbDueProjects.length === 0} expanded={expandedCards.has('secondbrain')} onToggle={()=>toggleCard('secondbrain')}
        summary={sbDueProjects.length ? `${sbDueProjects.length} project${sbDueProjects.length===1?'':'s'} due` : 'Nothing due right now'}
        action={<button className="text-btn" onClick={()=>navigate('Second Brain')}>Open <ArrowRight size={15}/></button>}
        orderStyle={slot(12, sbDueProjects.length)}
      >
        {sbDueProjects.length?<div className="scroll-list">{sbDueProjects.map(p=><div className="list-row" key={p.id}><div><b>{p.title||'Untitled'}</b>{p.nextAction && <small>{p.nextAction}</small>}</div><Badge tone={(p.dueDate ?? '')<today?'danger':'warning'}>{(p.dueDate ?? '')<today?'Overdue':'Today'}</Badge></div>)}</div>:<p className="muted">No projects due right now.</p>}
        <div className="sb-dash-area">
          <span>Area to review</span>
          {sbSpotlightArea?<><b>{sbSpotlightArea.title||'Untitled'}</b><small>{sbSpotlightArea.standard||'No standard set yet.'}</small></>:<small>No areas yet — create one in Second Brain.</small>}
        </div>
      </DashCard>
      <DashCard
        icon={undefined} title="Goal progress" isMobile={isMobile}
        quiet expanded={expandedCards.has('goals')} onToggle={()=>toggleCard('goals')}
        summary={`${avgGoal}% avg · ${annualGoals.length} tracked`}
        action={<b>{avgGoal}%</b>}
        orderStyle={slot(13)}
      >
        <ProgressBar value={avgGoal}/><div className="metric-pair"><span>Annual goals tracked</span><b>{annualGoals.length}</b></div>
      </DashCard>
    </div>
  </>;
}
