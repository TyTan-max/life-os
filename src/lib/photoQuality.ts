import type { PhotoQuality } from '../types';

// Longest-side pixel cap and JPEG quality for photos pasted/uploaded into notes. Text-heavy
// screenshots are what suffer from aggressive shrinking (a 2400px-wide capture cut to 1200px
// loses thin strokes, and JPEG smears what's left), so the higher tiers trade storage for
// legibility. Stored photos are never re-processed — a change only applies to new ones.
export const PHOTO_QUALITY_PRESETS: Record<PhotoQuality, { label: string; hint: string; maxDim: number; quality: number }> = {
  compact: { label: 'Compact', hint: 'Smallest files — fine for photos, text may look soft', maxDim: 1200, quality: 0.82 },
  balanced: { label: 'Balanced', hint: 'Good middle ground for most screenshots', maxDim: 1800, quality: 0.88 },
  high: { label: 'High', hint: 'Sharpest — best for screenshots with small text, uses the most space', maxDim: 2400, quality: 0.92 }
};

export const DEFAULT_PHOTO_QUALITY: PhotoQuality = 'high';

export function photoQualityPreset(setting: PhotoQuality | undefined) {
  return PHOTO_QUALITY_PRESETS[setting ?? DEFAULT_PHOTO_QUALITY];
}
