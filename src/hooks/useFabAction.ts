import { useEffect, useRef } from 'react';
import { registerFabAction } from '../lib/fabRegistry';

// Lets a page claim the center FAB while it's mounted. `onTrigger` is read through a ref so
// registration only churns on page/label changes, not on every render of the host page.
// A null page skips registration, for shared components that only sometimes own the page.
export function useFabAction(page: string | null, label: string, onTrigger: () => void) {
  const handlerRef = useRef(onTrigger);
  handlerRef.current = onTrigger;

  useEffect(() => {
    if (!page) return;
    return registerFabAction(page, { label, onTrigger: () => handlerRef.current() });
  }, [page, label]);
}
