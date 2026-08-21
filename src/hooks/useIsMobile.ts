import { useEffect, useState } from 'react';

// "Mobile" is classified by SHORT EDGE, not raw width — `min(innerWidth, innerHeight) <= 500`,
// expressed as the OR of two single-axis checks since that's exactly equivalent (the smaller of
// two numbers is <=X iff at least one of them is). A phone's short edge doesn't change when it
// rotates: 375x812 and 812x375 are the same physical device and both match here. A width-only
// check (the old `max-width: 640px`) got this wrong — every mainstream phone's LANDSCAPE width
// clears 640px, so rotating silently dropped the device out of the mobile tier into unstyled
// desktop/tablet chrome. 500 clears the largest phone short edge (~430px) with room to spare,
// while sitting well under the smallest real tablet's short edge (~744px on an iPad mini), so
// tablets in either orientation are never misclassified as phones.
// Kept in step with the matching `@media (max-width: 500px), (max-height: 500px)` tier in
// index.css. Components that swap markup wholesale (a table for a card list) gate on this
// rather than CSS `display:none`, so only one of the two is ever in the DOM — no duplicate
// focus targets, no hidden inputs collecting form state.
export const MOBILE_QUERY = '(max-width: 500px), (max-height: 500px)';

function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches);

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', onChange);
    setMatches(mq.matches);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

export function useIsMobile(): boolean {
  return useMatchMedia(MOBILE_QUERY);
}

// A landscape phone is exactly "orientation: landscape AND short edge <= 500" — and since the
// short edge in landscape is always the height (width >= height by definition of the
// orientation), that collapses to just `max-height: 500px`, no OR needed here. This is
// deliberately narrower than "isMobile and width > height": a portrait phone momentarily wider
// than tall mid-rotation-animation shouldn't flicker into the landscape layout, and pairing the
// height cap with the orientation feature avoids exactly that.
export const MOBILE_LANDSCAPE_QUERY = '(max-height: 500px) and (orientation: landscape)';

export function useIsMobileLandscape(): boolean {
  return useMatchMedia(MOBILE_LANDSCAPE_QUERY);
}
