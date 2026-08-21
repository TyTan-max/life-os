export interface Verse {
  text: string;
  reference: string;
}

const VERSES: Verse[] = [
  { text: 'I can do all things through Christ who strengthens me.', reference: 'Philippians 4:13' },
  { text: 'Trust in the Lord with all your heart, and do not lean on your own understanding.', reference: 'Proverbs 3:5' },
  { text: 'For I know the plans I have for you, declares the Lord, plans to prosper you and not to harm you.', reference: 'Jeremiah 29:11' },
  { text: 'Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.', reference: 'Joshua 1:9' },
  { text: 'And we know that in all things God works for the good of those who love him.', reference: 'Romans 8:28' },
  { text: 'The Lord is my shepherd; I shall not want.', reference: 'Psalm 23:1' },
  { text: 'Cast all your anxiety on him because he cares for you.', reference: '1 Peter 5:7' },
  { text: 'This is the day that the Lord has made; let us rejoice and be glad in it.', reference: 'Psalm 118:24' },
  { text: 'But those who hope in the Lord will renew their strength. They will soar on wings like eagles.', reference: 'Isaiah 40:31' },
  { text: 'Commit to the Lord whatever you do, and he will establish your plans.', reference: 'Proverbs 16:3' },
  { text: 'Do not be anxious about anything, but in every situation, by prayer and petition, present your requests to God.', reference: 'Philippians 4:6' },
  { text: 'The Lord is my light and my salvation—whom shall I fear?', reference: 'Psalm 27:1' },
  { text: 'Let all that you do be done in love.', reference: '1 Corinthians 16:14' },
  { text: 'Come to me, all who labor and are heavy laden, and I will give you rest.', reference: 'Matthew 11:28' },
  { text: 'She is clothed with strength and dignity, and she laughs without fear of the future.', reference: 'Proverbs 31:25' },
  { text: 'In their hearts humans plan their course, but the Lord establishes their steps.', reference: 'Proverbs 16:9' },
  { text: 'Give thanks in all circumstances; for this is God’s will for you.', reference: '1 Thessalonians 5:18' },
  { text: 'Whatever you do, work at it with all your heart, as working for the Lord.', reference: 'Colossians 3:23' },
  { text: 'Delight yourself in the Lord, and he will give you the desires of your heart.', reference: 'Psalm 37:4' },
  { text: 'Be still, and know that I am God.', reference: 'Psalm 46:10' }
];

const SESSION_KEY = 'life-os-daily-verse';

// Picked once per browser session (sessionStorage, not persisted storage) so it stays
// stable while navigating around the app but refreshes the next time you open it.
export function getSessionVerse(): Verse {
  try {
    const cached = window.sessionStorage.getItem(SESSION_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as Verse;
      if (parsed?.text && parsed?.reference) return parsed;
    }
  } catch {
    // sessionStorage unavailable — fall through to picking a fresh verse
  }
  const verse = VERSES[Math.floor(Math.random() * VERSES.length)];
  try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(verse)); } catch { /* ignore */ }
  return verse;
}
