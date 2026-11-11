'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, kept current as the window changes.
 * The server (and the first client render, during hydration) reads false, so
 * server and client markup agree; React re-renders with the real value right
 * after hydration.
 */
export function useMatchMedia(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
