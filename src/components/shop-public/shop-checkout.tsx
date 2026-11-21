'use client';

/**
 * The public shop's own checkout (/s/<handle>/checkout/<token>), inside the
 * shop's frame and theme: the cart, the address and payment, nothing else (no
 * product grid). It is the ordinary storefront session (checkout-panel.tsx and
 * the /api/public/shop/<token> APIs), so versions, stock holds, payment and
 * placing are unchanged.
 *
 * On opening: the browser cart joins the session once (when the session's cart
 * is empty, or when the cart page's Checkout button asked for it), the pincode
 * and coupon typed on the cart page carry over, and the link is remembered with
 * its expiry so the cart page can come back here without a new code.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { shopApi, type StorefrontProduct, type StorefrontView } from '@/components/storefront/api';
import { CheckoutDone } from '@/components/storefront/checkout-done';
import { CheckoutLoadState, CheckoutPanel, useCheckoutSession } from '@/components/storefront/checkout-panel';
import { readCart, writeCart } from './cart-store';
import { forgetCheckout, rememberCheckout, takeCarry, takeReplaceCart } from './checkout-store';

/** The app's UI components drawn in the shop's colours, radius and type (themeCssVars on the frame). */
const THEMED = {
  '--primary': 'var(--shop-primary)', '--primary-foreground': 'var(--shop-on-primary)', '--ring': 'var(--shop-primary)',
  '--background': 'var(--shop-bg)', '--foreground': 'var(--shop-text)', '--card': 'var(--shop-surface)', '--card-foreground': 'var(--shop-text)',
  '--popover': 'var(--shop-surface)', '--popover-foreground': 'var(--shop-text)',
  '--muted': 'color-mix(in srgb, var(--shop-text) 6%, var(--shop-surface))', '--muted-foreground': 'color-mix(in srgb, var(--shop-text) 65%, transparent)',
  '--border': 'color-mix(in srgb, var(--shop-text) 14%, transparent)', '--input': 'color-mix(in srgb, var(--shop-text) 18%, transparent)',
  '--radius': 'var(--shop-radius)',
} as CSSProperties;

/** Where Razorpay returns a buyer of the public shop (/s/<handle>/checkout/<token>/done): the order's status, in the shop's theme. */
export function ShopCheckoutDone({ handle, token }: { handle: string; token: string }) {
  return (
    <div style={THEMED} className="mx-auto flex w-full max-w-2xl flex-col gap-6 text-[var(--shop-text)]">
      <CheckoutDone token={token} backHref={`/s/${handle}/checkout/${encodeURIComponent(token)}`} />
    </div>
  );
}

export function ShopCheckout({ handle, token }: { handle: string; token: string }) {
  const t = useTranslations('ShopPublic.checkout');
  const [products, setProducts] = useState<StorefrontProduct[]>([]);
  const seeded = useRef(false);
  const session = useCheckoutSession(token, useCallback((next: StorefrontView) => {
    // Only the first view carries products; they name cart lines when the quote cannot.
    if (!seeded.current) { seeded.current = true; setProducts(next.products); }
  }, []));
  const { view, run, setAddress, setCoupon } = session;
  // The browser cart and the cart page's pincode and coupon join the session once, before the page shows.
  const [settled, setSettled] = useState(false);
  const joined = useRef(false);

  useEffect(() => {
    if (!view || joined.current) return;
    joined.current = true;
    const open = view.open && !view.cartLocked;
    const browser = open ? readCart(handle) : [];
    const replace = open && takeReplaceCart(handle);
    const push = browser.length > 0 && (view.cart.length === 0 || replace);
    const carry = open ? takeCarry(handle) : null;
    const coupon = carry?.coupon && !view.couponCode ? carry.coupon : null;
    let couponRefused = false;
    void (async () => {
      if (push || coupon) await run(async () => {
        let current = view;
        if (push) {
          current = await shopApi.cart(token, current.version, browser);
          writeCart(handle, []);
        }
        if (coupon) {
          try {
            current = await shopApi.coupon(token, current.version, coupon);
          } catch {
            couponRefused = true; // left in the box: Apply shows why
          }
        }
        return current;
      });
      if (couponRefused && coupon) setCoupon(coupon);
      if (carry?.pincode) setAddress((a) => (a.postal_code ? a : { ...a, postal_code: carry.pincode! }));
      setSettled(true);
    })();
  }, [view, handle, token, run, setAddress, setCoupon]);

  // Remember the open link (with its expiry) for the cart page; forget it once the order is placed or the link ends.
  useEffect(() => {
    if (!view) return;
    if (view.open && !view.order) rememberCheckout(handle, token, view.expiresAt);
    else forgetCheckout(handle);
  }, [view, handle, token]);
  useEffect(() => {
    if (session.loadState === 'not_found') forgetCheckout(handle);
  }, [session.loadState, handle]);

  const variantInfo = useMemo(() => new Map(products.flatMap((p) =>
    p.variants.map((v) => [v.id, { productName: p.name, options: Object.values(v.options).join(' / ') }] as const))), [products]);

  const browse = (
    <Link href={`/s/${handle}`} className="inline-flex min-h-11 items-center justify-center rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)]">
      {t('browse')}
    </Link>
  );

  return (
    // Phone-sized fields: the app's inputs are 32px (its buttons already grow to 44px on a touch screen, pointer-coarse).
    <div style={THEMED} className="mx-auto flex w-full max-w-2xl flex-col gap-6 text-[var(--shop-text)] [&_[data-slot=input]]:h-11">
      <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('title')}</h1>
      {!view || session.loadState !== 'ready' || !settled
        ? <CheckoutLoadState session={session.loadState === 'ready' && !settled ? { ...session, loadState: 'loading' } : session}
          notFoundAction={<Link href={`/s/${handle}/cart`} className="inline-flex min-h-11 items-center font-medium underline">{t('backToCart')}</Link>} />
        : <CheckoutPanel session={session} variantInfo={variantInfo}
          emptyCart={<div className="flex flex-col items-start gap-3 text-sm"><p>{t('empty')}</p>{browse}</div>} />}
    </div>
  );
}
