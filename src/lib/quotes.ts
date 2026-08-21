export interface Quote {
  text: string;
  author: string;
}

const QUOTES: Quote[] = [
  { text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Will Durant' },
  { text: 'You do not rise to the level of your goals. You fall to the level of your systems.', author: 'James Clear' },
  { text: 'Motivation is what gets you started. Habit is what keeps you going.', author: 'Jim Ryun' },
  { text: 'Small daily improvements are the key to staggering long-term results.', author: 'Unknown' },
  { text: 'The secret of your future is hidden in your daily routine.', author: 'Mike Murdock' },
  { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' },
  { text: 'Every action you take is a vote for the type of person you wish to become.', author: 'James Clear' },
  { text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
  { text: 'Success is the sum of small efforts, repeated day in and day out.', author: 'Robert Collier' },
  { text: 'You will never change your life until you change something you do daily.', author: 'John C. Maxwell' },
  { text: 'The chains of habit are too weak to be felt until they are too strong to be broken.', author: 'Samuel Johnson' },
  { text: 'First we make our habits, then our habits make us.', author: 'John Dryden' },
  { text: 'Good habits are worth being fanatical about.', author: 'John Irving' },
  { text: 'Consistency is what transforms average into excellence.', author: 'Unknown' },
  { text: 'The future depends on what you do today.', author: 'Mahatma Gandhi' },
  { text: 'Progress, not perfection.', author: 'Unknown' },
  { text: 'Your habits will determine your future.', author: 'Jack Canfield' },
  { text: 'Difficult roads often lead to beautiful destinations.', author: 'Unknown' },
  { text: 'Don’t count the days, make the days count.', author: 'Muhammad Ali' },
  { text: 'A year from now you may wish you had started today.', author: 'Karen Lamb' }
];

const SESSION_KEY = 'life-os-daily-quote';

// Picked once per browser session (sessionStorage, not persisted storage) so it stays
// stable while navigating around the app but refreshes the next time you open it.
export function getSessionQuote(): Quote {
  try {
    const cached = window.sessionStorage.getItem(SESSION_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as Quote;
      if (parsed?.text && parsed?.author) return parsed;
    }
  } catch {
    // sessionStorage unavailable — fall through to picking a fresh quote
  }
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(quote)); } catch { /* ignore */ }
  return quote;
}
