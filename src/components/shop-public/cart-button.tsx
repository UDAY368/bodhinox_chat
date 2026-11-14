'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';
import { CART_EVENT, cartCount, readCart } from './cart-store';

/** The header's cart link with the item count from the browser cart. */
export function CartButton({ handle, label }: { handle: string; label: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const update = () => setCount(cartCount(readCart(handle)));
    update();
    window.addEventListener(CART_EVENT, update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener(CART_EVENT, update); window.removeEventListener('storage', update); };
  }, [handle]);
  return (
    <Link href={`/s/${handle}/cart`} aria-label={`${label} (${count})`}
      className="relative grid size-11 place-items-center rounded-full hover:bg-black/5">
      <ShoppingBag className="size-5" aria-hidden />
      {count > 0 && (
        <span className="absolute right-0.5 top-0.5 min-w-5 rounded-full bg-[var(--shop-primary)] px-1 text-center text-[11px] font-semibold leading-5 text-[var(--shop-on-primary)]">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
