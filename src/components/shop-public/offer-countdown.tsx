'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

const REDUCED = '(prefers-reduced-motion: reduce)';
const reducedMotion = () => window.matchMedia(REDUCED).matches;
const subscribeMotion = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

export interface CountdownLabels { endsIn: string; days: string; hours: string; minutes: string; seconds: string }

/** Whole days, hours, minutes and seconds left until `end` (all 0 once it has passed). */
export function timeLeft(end: number, now: number): { days: number; hours: number; minutes: number; seconds: number; over: boolean } {
  const total = Math.max(0, Math.floor((end - now) / 1000));
  return { days: Math.floor(total / 86400), hours: Math.floor((total % 86400) / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60, over: total === 0 };
}

/**
 * The offer section's countdown. The server leaves out an offer that has
 * already ended; this hides the section the moment it ends while open. The
 * cells have a fixed size and start as "--" (server and first paint agree, so
 * nothing shifts). It ticks once a second only while it is on screen and the
 * tab is visible; with reduced motion it updates once a minute and shows no seconds.
 */
export function OfferCountdown({ endsAt, labels, className, children, after }: { endsAt: string; labels: CountdownLabels; className?: string; children: ReactNode; after?: ReactNode }) {
  const end = Date.parse(endsAt);
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState<number | null>(null);
  const reduced = useSyncExternalStore(subscribeMotion, reducedMotion, () => false);

  useEffect(() => {
    const query = window.matchMedia(REDUCED);
    // The observer reports once right after observe(), which draws the first value and starts the tick.
    let onScreen = false;
    let timer: number | undefined;
    const stop = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined; };
    const start = () => {
      stop();
      if (!onScreen || document.visibilityState !== 'visible') return;
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), query.matches ? 60_000 : 1000);
    };
    const observer = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; start(); });
    if (ref.current) observer.observe(ref.current);
    const onVisibility = () => start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); observer.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const left = now === null ? null : timeLeft(end, now);
  if (left?.over) return null;
  // With reduced motion the seconds cell keeps its place (no shift) but stays empty.
  const cells: Array<[number | undefined, string, boolean]> = [
    [left?.days, labels.days, false], [left?.hours, labels.hours, false], [left?.minutes, labels.minutes, false], [left?.seconds, labels.seconds, reduced],
  ];
  return (
    <div ref={ref} className={className}>
      {children}
      <p className="sr-only">{labels.endsIn}</p>
      <div className="mt-4 flex gap-2" role="timer" aria-live="off">
        {cells.map(([value, unit, blank]) => (
          <span key={unit} aria-hidden={blank || undefined} className={`flex w-16 flex-col items-center rounded-[var(--shop-radius)] bg-black/15 py-2 ${blank ? 'invisible' : ''}`}>
            <span className="text-2xl font-semibold tabular-nums">{value === undefined ? '--' : String(value).padStart(2, '0')}</span>
            <span className="text-xs opacity-90">{unit}</span>
          </span>
        ))}
      </div>
      {after}
    </div>
  );
}
