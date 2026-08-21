import type { BillFrequency, RecurringKind } from '../types';

const SUBSCRIPTION_KEYWORDS = /netflix|spotify|hulu|disney\+?|hbo|paramount\+?|apple (music|tv|arcade|one)|prime video|youtube premium|patreon|adobe|icloud|dropbox|notion|chatgpt|openai|xbox|playstation|nintendo|planet fitness|peloton|subscription|membership|premium\b|plan\b/i;
const BILL_KEYWORDS = /electric|water (dept|bill)|utility|utilities|gas (co|company)|insurance|^rent$|rent payment|mortgage|hoa\b|loan payment|internet service|phone bill|comcast|xfinity|spectrum|pg&e|pge\b/i;

export interface RecurringClassification {
  kind: RecurringKind;
  confidence: 'high' | 'low';
}

// Mirrors the blueprint's classifier: known-merchant lookup first (high confidence),
// then a lightweight heuristic score for anything unrecognized (low confidence).
export function classifyRecurringKind(name: string, amount: number, frequency?: BillFrequency): RecurringClassification {
  const trimmed = name.trim();
  if (!trimmed) return { kind: 'Bill', confidence: 'low' };

  if (SUBSCRIPTION_KEYWORDS.test(trimmed)) return { kind: 'Subscription', confidence: 'high' };
  if (BILL_KEYWORDS.test(trimmed)) return { kind: 'Bill', confidence: 'high' };

  let score = 0;
  if (frequency === 'Yearly') score += 2;
  if (frequency === 'Monthly') score += 1;
  if (frequency === 'Once') score -= 1;

  if (Number.isFinite(amount) && amount > 0) {
    const cents = Math.round(amount * 100) % 100;
    if (cents === 99 || cents === 95) score += 1; // classic SaaS pricing endings ($x.99 / $x.95)
  }

  return { kind: score > 0 ? 'Subscription' : 'Bill', confidence: 'low' };
}
