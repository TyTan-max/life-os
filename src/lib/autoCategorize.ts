interface CategoryRule {
  pattern: RegExp;
  category: string;
}

const RULES: CategoryRule[] = [
  { pattern: /walmart|target|kroger|safeway|whole foods|trader joe|costco|aldi|publix|grocery/i, category: 'Groceries' },
  { pattern: /restaurant|starbucks|chipotle|mcdonald|wendy|taco bell|doordash|uber eats|grubhub|dining|cafe|coffee/i, category: 'Dining Out' },
  { pattern: /shell|chevron|exxon|bp gas|gas station|circle k|uber|lyft|taxi|parking|transit|metro/i, category: 'Transportation' },
  { pattern: /electric|power company|utility|water dept|gas company|comcast|xfinity|spectrum|internet service/i, category: 'Utilities' },
  { pattern: /^rent$|rent payment|mortgage payment|hoa/i, category: 'Housing' },
  { pattern: /netflix|hulu|disney\+|spotify|apple music|hbo|paramount\+|youtube premium|prime video|patreon/i, category: 'Subscriptions' },
  { pattern: /amazon|ebay|best buy|target\.com|etsy/i, category: 'Shopping' },
  { pattern: /gym|fitness|planet fitness|peloton|yoga/i, category: 'Health & Fitness' },
  { pattern: /pharmacy|cvs|walgreens|doctor|dental|clinic|hospital/i, category: 'Health & Fitness' },
  { pattern: /insurance/i, category: 'Insurance' },
  { pattern: /airline|delta|united|southwest|jetblue|hotel|airbnb|marriott|hilton/i, category: 'Travel' },
  { pattern: /movie theater|amc|cinema|concert|ticketmaster|steam|playstation|xbox/i, category: 'Entertainment' },
  { pattern: /salon|barber|spa|haircut/i, category: 'Personal Care' },
  { pattern: /tuition|university|college|student loan payment/i, category: 'Education' },
  { pattern: /gift|donation|charity|gofundme/i, category: 'Gifts & Donations' },
  { pattern: /payroll|paycheck|salary|direct deposit/i, category: 'Salary' },
  { pattern: /freelance|invoice payment|contract payment/i, category: 'Freelance' },
  { pattern: /dividend|interest earned|capital gain/i, category: 'Investment Income' }
];

export function suggestCategory(merchant: string): string | undefined {
  const text = merchant.trim();
  if (!text) return undefined;
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.category;
  return undefined;
}
