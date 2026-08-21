import type { AppData } from './types';

const CHECK_INTERVAL_MS = 30_000;
const shown = new Set<string>();

function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function notify(title: string, body: string): void {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return;
  new Notification(title, { body });
}

interface DueReminder {
  id: string;
  title: string;
  body: string;
}

function dueReminders(data: AppData, now: Date): DueReminder[] {
  const nowIso = now.toISOString();
  const items: DueReminder[] = [];
  for (const task of data.tasks) {
    if (task.reminderAt && task.status !== 'Completed' && task.reminderAt <= nowIso) {
      items.push({ id: `task-${task.id}`, title: 'Task reminder', body: task.title });
    }
  }
  for (const event of data.events) {
    if (event.reminderAt && event.reminderAt <= nowIso) {
      items.push({ id: `event-${event.id}`, title: 'Event reminder', body: event.title });
    }
  }
  for (const bill of data.bills) {
    if (bill.reminderAt && bill.reminderAt <= nowIso) {
      items.push({ id: `bill-${bill.id}`, title: 'Bill reminder', body: `${bill.name} is due ${bill.nextDue}` });
    }

    if ((bill.kind ?? 'Bill') === 'Subscription') {
      // Trial-ending alert — fires once, exactly 3 days out.
      if (bill.isFreeTrial && bill.trialEndDate) {
        const daysLeft = Math.round((new Date(`${bill.trialEndDate}T09:00:00`).getTime() - now.getTime()) / 86_400_000);
        if (daysLeft === 3) {
          items.push({
            id: `trial-${bill.id}-${bill.trialEndDate}`,
            title: 'Trial ending soon',
            body: `${bill.name} trial ends in 3 days — you'll be charged $${bill.amount.toFixed(2)}`
          });
        }
      }
    } else {
      // Variable-bill deviation alert — fires once per changed amount, not once per day.
      if (bill.isVariable && bill.amountHistory?.length) {
        const avg = bill.amountHistory.reduce((s, h) => s + h.amount, 0) / bill.amountHistory.length;
        const deviationPct = avg > 0 ? ((bill.amount - avg) / avg) * 100 : 0;
        const threshold = bill.varianceThresholdPct ?? 20;
        if (Math.abs(deviationPct) >= threshold) {
          items.push({
            id: `variance-${bill.id}-${bill.amount}`,
            title: 'Bill amount changed',
            body: `${bill.name} is ${Math.round(Math.abs(deviationPct))}% ${deviationPct > 0 ? 'higher' : 'lower'} than usual ($${bill.amount.toFixed(2)} vs. ~$${avg.toFixed(2)})`
          });
        }
      }
    }
  }
  return items;
}

export function startBrowserReminderLoop(getData: () => AppData): () => void {
  if (typeof window === 'undefined') return () => {};
  const tick = () => {
    const data = getData();
    if (!data.settings?.notificationsEnabled) return;
    for (const reminder of dueReminders(data, new Date())) {
      if (shown.has(reminder.id)) continue;
      shown.add(reminder.id);
      notify(reminder.title, reminder.body);
    }
  };
  const timer = window.setInterval(tick, CHECK_INTERVAL_MS);
  tick();
  return () => window.clearInterval(timer);
}

export async function syncScheduledNotifications(data: AppData): Promise<void> {
  if (!isNotificationSupported() || !data.settings.notificationsEnabled) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}
