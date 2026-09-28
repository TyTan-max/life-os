import type { FinanceAccount, Transaction } from '../types';

// A credit card's statement payment: what's due and when (typed in from the statement), and
// whether the imported transactions show it paid. The payment itself is a transfer — the
// purchases were already counted as spending — so this is a reminder, never spending.

const DAY = 86_400_000;
const PAID_BEFORE_DAYS = 14;  // paying early counts
const PAID_AFTER_DAYS = 7;    // …as does a payment that posts a few days late
const POST_LAG_DAYS = 3;
const CARD_PAYMENT_PATTERN = /crcardpmt|credit card payment|card pmt|autopay payment/i;

export type CardPaymentState = 'upcoming' | 'paid' | 'missed' | 'pending';

export interface CardPayment {
  account: FinanceAccount;
  amount: number;
  due: string;
  state: CardPaymentState;
}

const toTime = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

function isPaymentTo(card: FinanceAccount, t: Transaction): boolean {
  if (t.type === 'Transfer' && t.transferAccountId === card.id) return true;
  if (t.accountId === card.id && t.type !== 'Expense') return true;
  return t.type === 'Transfer' && !t.transferAccountId && CARD_PAYMENT_PATTERN.test(t.merchant);
}

export function cardPayment(card: FinanceAccount, transactions: Transaction[], todayIso: string): CardPayment | null {
  if (card.type !== 'Credit Card' || card.status === 'Closed') return null;
  if (!card.paymentDueDate || !card.statementBalance || card.statementBalance <= 0) return null;
  const due = card.paymentDueDate;
  const dueAt = toTime(due);
  const paid = transactions.some(t => {
    const at = toTime(t.date);
    return at >= dueAt - PAID_BEFORE_DAYS * DAY && at <= dueAt + PAID_AFTER_DAYS * DAY && isPaymentTo(card, t);
  });
  let state: CardPaymentState;
  if (paid) state = 'paid';
  else if (due >= todayIso) state = 'upcoming';
  else {
    const newest = transactions.reduce((max, t) => (t.date > max ? t.date : max), '');
    state = newest && toTime(newest) >= dueAt + POST_LAG_DAYS * DAY ? 'missed' : 'pending';
  }
  return { account: card, amount: card.statementBalance, due, state };
}

export function cardPayments(accounts: FinanceAccount[], transactions: Transaction[], todayIso: string): CardPayment[] {
  return accounts.map(a => cardPayment(a, transactions, todayIso)).filter((p): p is CardPayment => p !== null);
}
