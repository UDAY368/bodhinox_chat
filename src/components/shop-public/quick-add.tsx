'use client';

import { useEffect, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { addToCart } from './cart-store';

/**
 * A product card's quick add: one tap puts one of the product's only variant
 * in the browser cart (names and prices still come from the server at the
 * cart). Shown only for an in-stock product without options to choose.
 */
export function QuickAdd({ handle, variantId, available, label, addedLabel, round = false }: {
  handle: string; variantId: string;
  /** Stock left for the variant (null = not tracked): the cart never holds more, as on the product page. */
  available: number | null;
  label: string; addedLabel: string; round?: boolean;
}) {
  const [added, setAdded] = useState(false);
  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(false), 1500);
    return () => window.clearTimeout(timer);
  }, [added]);
  const Icon = added ? Check : Plus;
  return (
    <button type="button" onClick={() => { addToCart(handle, variantId, 1, available); setAdded(true); }}
      aria-label={added ? addedLabel : label}
      className={round
        ? 'grid size-11 shrink-0 place-items-center rounded-full bg-[var(--shop-primary)] text-[var(--shop-on-primary)]'
        : 'flex h-11 w-full items-center justify-center gap-1 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-3 text-sm font-semibold text-[var(--shop-on-primary)]'}>
      <Icon className="size-4" aria-hidden />
      {!round && <span aria-hidden>{added ? addedLabel : label}</span>}
      <span className="sr-only" aria-live="polite">{added ? addedLabel : ''}</span>
    </button>
  );
}
