// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas/newlines, and "" escapes.
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { pushField(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') {
      // Skip fully blank lines rather than emitting empty rows.
      if (field.length || row.length) pushRow();
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) pushRow();
  return rows.filter(r => r.some(cell => cell.trim().length));
}

// Normalizes a variety of common date formats (MM/DD/YYYY, M/D/YY, YYYY-MM-DD, etc.) to YYYY-MM-DD.
// Falls back to the original string if it can't confidently parse it, so bad input is visible
// rather than silently dropped.
export function normalizeCsvDate(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const slashMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slashMatch) {
    let [, m, d, y] = slashMatch;
    if (y.length === 2) y = Number(y) < 70 ? `20${y}` : `19${y}`;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return value;
}

// Matches bank/card CSV descriptions for "you paid your credit card bill" — both the bank's side
// (CRCARDPMT, CARDMEMBER SERV) and the card issuer's own side (e.g. Capital One's "AUTOPAY PYMT",
// "AUTOMATIC PAYMENT - THANK YOU"). Deliberately narrow so it doesn't also catch an ordinary
// purchase whose description happens to contain the word "payment" (e.g. a Microsoft Xbox
// "payment") or a subscription's own "autopay" mention (e.g. "NETFLIX AUTOPAY") — the patterns
// here specifically combine payment-confirmation wording (PYMT, THANK YOU) rather than matching
// "autopay" or "payment" alone.
export function isCreditCardPaymentMerchant(merchant: string): boolean {
  return /crcardpmt|cr\s*card\s*pmt|credit\s*card\s*(payment|pmt)|cardmember\s*serv|\bcc\s*payment\b|autopay\s*pymt|auto\s*pay\s*pymt|automatic\s*payment|payment.*thank\s*you|thank\s*you.*payment/i.test(merchant);
}

// Bank/card issuers export their own spending category alongside each transaction (Capital One's
// "Dining", "Merchandise", "Gas/Automotive", etc.) but use their own vocabulary, which rarely
// matches this app's category names exactly. This maps common issuer category text to the closest
// canonical name here — used only as a fallback when no exact (case-insensitive) match exists.
const CSV_CATEGORY_ALIASES: Record<string, string> = {
  dining: 'Dining Out',
  restaurants: 'Dining Out',
  restaurant: 'Dining Out',
  grocery: 'Groceries',
  groceries: 'Groceries',
  supermarkets: 'Groceries',
  'gas/automotive': 'Transportation',
  gas: 'Transportation',
  automotive: 'Transportation',
  transportation: 'Transportation',
  'airfare': 'Travel',
  merchandise: 'Shopping',
  shopping: 'Shopping',
  'general merchandise': 'Shopping',
  entertainment: 'Entertainment',
  recreation: 'Entertainment',
  travel: 'Travel',
  lodging: 'Travel',
  'rental car': 'Travel',
  hotels: 'Travel',
  'health care': 'Health & Fitness',
  healthcare: 'Health & Fitness',
  medical: 'Health & Fitness',
  insurance: 'Insurance',
  utilities: 'Utilities',
  'phone/cable': 'Utilities',
  'internet & cable': 'Utilities',
  'home improvement': 'Housing',
  rent: 'Housing',
  mortgage: 'Housing',
  personal: 'Personal Care',
  'professional services': 'Miscellaneous',
  'other services': 'Miscellaneous',
  other: 'Miscellaneous',
  education: 'Education',
  gifts: 'Gifts & Donations',
  donations: 'Gifts & Donations',
  subscriptions: 'Subscriptions',
  streaming: 'Subscriptions'
};

// Resolves a bank/card CSV's own category text to a categoryId in this app: an exact
// (case-insensitive) name match first, then the alias table above, restricted to categories of
// the given kind (income/expense) so a card's expense categories can't get assigned to an income row.
export function matchCsvCategoryId(
  csvCategory: string,
  categories: { id: string; name: string; kind?: string }[],
  kind: 'income' | 'expense'
): string | undefined {
  const text = csvCategory.trim();
  if (!text) return undefined;
  const kindCategories = categories.filter(c => c.kind === kind);
  const exact = kindCategories.find(c => c.name.toLowerCase() === text.toLowerCase());
  if (exact) return exact.id;
  const alias = CSV_CATEGORY_ALIASES[text.toLowerCase()];
  if (!alias) return undefined;
  return kindCategories.find(c => c.name.toLowerCase() === alias.toLowerCase())?.id;
}

// Parses a money string that may include "$", thousands separators, or parenthesized negatives
// (an accounting-style negative, e.g. "$(45.00)").
export function parseCsvAmount(raw: string): number {
  const value = raw.trim();
  if (!value) return 0;
  const negativeParens = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/[()$,]/g, '').trim();
  const num = Number(cleaned);
  if (Number.isNaN(num)) return 0;
  return negativeParens ? -Math.abs(num) : num;
}
