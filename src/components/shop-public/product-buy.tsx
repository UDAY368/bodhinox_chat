'use client';

/**
 * The product page's interactive part: image gallery, one picker per option
 * (size, color…), quantity and "Add to cart" into the browser cart. Prices
 * shown here are the variant prices; tax, shipping and coupons are worked out
 * on the server at checkout. A sold-out variant of a shop with a WhatsApp number
 * offers "Notify me on WhatsApp": the buyer's own message claims the alert.
 *
 * Option values with nothing in stock (given the other picks) are greyed out,
 * the quantity stops at the stock left, a share button and an "Ask on
 * WhatsApp" link sit under the buy button, and on phones a buy bar sticks to
 * the bottom once the main button has scrolled away (IntersectionObserver).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, Check, Heart, Loader2, MessageCircle, Minus, Plus, Share2 } from 'lucide-react';
import type { PublicProduct } from '@/lib/commerce/public-shop';
import type { ShopLayout } from '@/lib/commerce/shop-templates';
import { formatMoney } from '@/lib/commerce/money';
import { formatShipDate } from '@/lib/commerce/selling-rules';
import { addToCart } from './cart-store';
import { PincodeCheck } from './pincode-check';
import { PRODUCT_LAYOUT_CLASSES } from './product-layout';
import { clampQty, pickValue, qtyCap, valueState, variantFor } from './product-options';
import { imageSrcSet } from '@/lib/commerce/shop-images';
import { subscribeWishlist, toggleWishlist, wishlistSnapshot } from './wishlist-store';

export function ProductBuy({ handle, product, currency, canNotify, layout, whatsappPhone = null }: {
  handle: string; product: PublicProduct; currency: string | null; canNotify: boolean;
  /** The template's layout: the page arrangement (layout.product) and the image shape (layout.image). */
  layout: Pick<ShopLayout, 'product' | 'image'>;
  /** The shop's WhatsApp number (wa.me digits) for "Ask about this product"; null hides it. */
  whatsappPhone?: string | null;
}) {
  const t = useTranslations('ShopPublic');
  const locale = useLocale();
  const optionNames = useMemo(() => [...new Set(product.variants.flatMap((v) => Object.keys(v.options)))], [product.variants]);
  const first = product.variants.find((v) => v.inStock) ?? product.variants[0];
  const [picked, setPicked] = useState<Record<string, string>>(first?.options ?? {});
  const [wantedQty, setQty] = useState(1);
  // A variant with its own picture shows it in the gallery (imageIndex is its place among `product.images`).
  const [image, setImage] = useState(first?.imageIndex ?? 0);
  const [added, setAdded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const variant = variantFor(product.variants, optionNames, picked);
  const cap = variant?.inStock ? qtyCap(variant.available) : 0;
  const qty = clampQty(wantedQty, variant?.inStock ? variant.available : 0) || 1;
  const canAdd = !!variant && variant.inStock && cap > 0;
  // "Save for later": kept in this browser until the visitor comes in through a shop session, which saves it to their contact.
  const savedIds = useSyncExternalStore(subscribeWishlist, wishlistSnapshot, () => '');
  const saved = variant ? savedIds.split(',').includes(variant.id) : false;
  const money = (minor: number) => (currency ? formatMoney(minor, currency, locale) : '');

  // The phone's buy bar: shown once the main button has scrolled up out of view (no scroll polling).
  const buyButton = useRef<HTMLButtonElement>(null);
  const [barShown, setBarShown] = useState(false);
  useEffect(() => {
    const node = buyButton.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setBarShown(!entry.isIntersecting && entry.boundingClientRect.top < 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const add = () => {
    if (!variant || !canAdd) return;
    addToCart(handle, variant.id, qty, variant.available);
    setAdded(true);
  };
  const pageUrl = () => `${window.location.origin}${window.location.pathname}`;
  const share = async () => {
    const url = pageUrl();
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ title: product.name, url }); } catch { /* the buyer closed the sheet */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch { /* no clipboard: nothing to do */ }
  };
  const notify = async () => {
    if (!variant) return;
    setNotifying(true); setNotifyError(null);
    try {
      const res = await fetch(`/api/public/store/${handle}/notify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variantId: variant.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && typeof data.whatsappUrl === 'string') { window.location.assign(data.whatsappUrl); return; }
      const code = typeof data?.code === 'string' ? data.code : 'generic';
      setNotifyError(t(`errors.${['in_stock', 'variant_unavailable', 'whatsapp_order_unavailable', 'too_many', 'not_found'].includes(code) ? code : 'generic'}`));
    } catch {
      setNotifyError(t('errors.network'));
    }
    setNotifying(false);
  };
  const arrangement = PRODUCT_LAYOUT_CLASSES[layout.product];
  const valuesOf = (name: string) => [...new Set(product.variants.map((v) => v.options[name]).filter(Boolean))];

  return (
    <div className={arrangement.grid} data-product-layout={layout.product}>
      <div className={`flex flex-col gap-3 ${arrangement.gallery}`}>
        <div className={`${layout.image === 'portrait' ? 'aspect-[3/4]' : 'aspect-square'} overflow-hidden rounded-[var(--shop-radius)] bg-black/5`}>
          {product.images[image]
            // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
            ? <img src={product.images[image]} srcSet={imageSrcSet(product.images[image])} sizes={layout.product === 'stacked' ? '(min-width: 896px) 896px, 100vw' : '(min-width: 768px) 50vw, 100vw'} alt={product.name} className="size-full object-cover" />
            : <div className="grid size-full place-items-center text-6xl opacity-30" aria-hidden>{product.name.slice(0, 1)}</div>}
        </div>
        {product.images.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {product.images.map((src, i) => (
              <button key={src} type="button" onClick={() => setImage(i)} aria-label={t('imageN', { n: i + 1 })} aria-pressed={i === image}
                className={`size-16 shrink-0 overflow-hidden rounded-[var(--shop-radius)] ring-2 ${i === image ? 'ring-[var(--shop-primary)]' : 'ring-transparent'}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                <img src={imageSrcSet(src) ? `${src}?w=320` : src} alt="" loading="lazy" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={`flex flex-col gap-5 ${arrangement.details}`}>
        <div>
          {product.categoryName && <p className="text-xs uppercase tracking-wide opacity-60">{product.categoryName}</p>}
          <h1 className="mt-1 text-2xl font-semibold @2xl:text-3xl" style={{ fontFamily: 'var(--shop-font-heading)' }}>{product.name}</h1>
          {variant && (
            <p className="mt-3 flex flex-wrap items-baseline gap-x-3">
              <span className="text-xl font-semibold text-[var(--shop-primary)]">{money(variant.priceMinor)}</span>
              {variant.compareAtMinor !== null && variant.compareAtMinor > variant.priceMinor && (
                <s className="opacity-60">{money(variant.compareAtMinor)}</s>
              )}
            </p>
          )}
        </div>

        {optionNames.map((name) => (
          <fieldset key={name} className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{name}</legend>
            <div className="flex flex-wrap gap-2">
              {valuesOf(name).map((value) => {
                const on = picked[name] === value;
                // Sold out stays tappable (so "Notify me" can be reached) but reads as unavailable; a combination that does not exist cannot be picked.
                const state = valueState(product.variants, optionNames, picked, name, value);
                return (
                  <button key={value} type="button" aria-pressed={on} disabled={state === 'none' && !on}
                    aria-disabled={state !== 'in_stock' || undefined} aria-label={state === 'sold_out' ? t('buy.soldOutOption', { value }) : undefined}
                    onClick={() => {
                      const next = pickValue(product.variants, optionNames, picked, name, value);
                      setPicked(next);
                      setAdded(false);
                      const shows = variantFor(product.variants, optionNames, next)?.imageIndex;
                      if (shows !== null && shows !== undefined) setImage(shows);
                    }}
                    className={`min-h-11 rounded-[var(--shop-radius)] border px-4 text-sm disabled:cursor-not-allowed disabled:opacity-30 ${on
                      ? 'border-[var(--shop-primary)] bg-[var(--shop-primary)] text-[var(--shop-on-primary)]'
                      : 'border-black/15 bg-[var(--shop-surface)] hover:border-black/40'} ${state === 'in_stock' ? '' : 'line-through opacity-50'}`}>
                    {value}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <p className="text-sm" role="status">
          {!variant ? t('pickOptions') : !variant.inStock ? t('soldOut')
            : variant.available !== null && variant.available <= 5 ? t('onlyLeft', { count: variant.available }) : t('inStock')}
        </p>
        {variant?.shipsBy && variant.inStock && (
          <p className="text-sm font-medium" data-testid="ships-by">{t('shipsBy', { date: formatShipDate(variant.shipsBy, locale) })}</p>
        )}
        {product.digital && <p className="text-sm opacity-80">{t('digitalNote')}</p>}

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-[var(--shop-radius)] border border-black/15 bg-[var(--shop-surface)]">
            <button type="button" className="grid size-11 place-items-center disabled:opacity-30" aria-label={t('decrease')} disabled={qty <= 1}
              onClick={() => setQty(Math.max(1, qty - 1))}>
              <Minus className="size-4" aria-hidden />
            </button>
            <span className="w-8 text-center tabular-nums" aria-live="polite">{qty}</span>
            <button type="button" className="grid size-11 place-items-center disabled:opacity-30" aria-label={t('increase')} disabled={qty >= cap}
              onClick={() => setQty(Math.min(cap, qty + 1))}>
              <Plus className="size-4" aria-hidden />
            </button>
          </div>
          <button ref={buyButton} type="button" disabled={!canAdd} onClick={add}
            className="h-11 flex-1 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
            {t('addToCart')}
          </button>
        </div>
        {variant?.inStock && cap > 0 && qty >= cap && cap < 99 && <p className="text-xs opacity-70">{t('buy.maxReached', { count: cap })}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void share()}
            className="flex h-11 items-center gap-2 rounded-[var(--shop-radius)] border border-black/15 px-4 text-sm font-medium">
            <Share2 className="size-4" aria-hidden />{copied ? t('buy.linkCopied') : t('buy.share')}
          </button>
          {whatsappPhone && (
            <a href={`https://wa.me/${whatsappPhone}`} target="_blank" rel="noopener noreferrer"
              onClick={(e) => { e.currentTarget.href = `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(t('buy.askText', { product: product.name, url: pageUrl() }))}`; }}
              className="flex min-h-11 items-center gap-2 rounded-[var(--shop-radius)] border border-black/15 px-4 text-sm font-medium">
              <MessageCircle className="size-4" aria-hidden />{t('buy.ask')}
            </a>
          )}
        </div>
        <PincodeCheck handle={handle} variantId={variant?.id ?? null} quantity={qty} />
        {variant && (
          <div className="flex flex-col gap-1">
            <button type="button" aria-pressed={saved} onClick={() => toggleWishlist(variant.id)}
              className="flex h-11 items-center justify-center gap-2 rounded-[var(--shop-radius)] border border-black/15 px-5 text-sm font-medium">
              <Heart className={`size-5 ${saved ? 'fill-current text-[var(--shop-primary)]' : ''}`} aria-hidden />{t(saved ? 'wishlist.saved' : 'wishlist.save')}
            </button>
            {saved && <p className="text-xs opacity-70">{t('wishlist.hint')}</p>}
          </div>
        )}
        {canNotify && variant && !variant.inStock && (
          <div className="flex flex-col gap-2">
            <button type="button" disabled={notifying} onClick={() => void notify()}
              className="flex h-11 items-center justify-center gap-2 rounded-[var(--shop-radius)] border border-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-primary)] disabled:opacity-40">
              {notifying ? <Loader2 className="size-5 animate-spin" aria-label={t('stockAlert.sending')} /> : <><Bell className="size-5" aria-hidden />{t('stockAlert.button')}</>}
            </button>
            <p className="text-xs opacity-70">{t('stockAlert.hint')}</p>
            {notifyError && <p className="text-sm text-red-700" role="alert">{notifyError}</p>}
          </div>
        )}
        {added && (
          <p className="flex items-center gap-2 text-sm" role="status">
            <Check className="size-4" aria-hidden /> {t('added')}
            <Link href={`/s/${handle}/cart`} className="font-semibold underline">{t('viewCart')}</Link>
          </p>
        )}

        {product.description && <div className="whitespace-pre-line text-sm leading-relaxed opacity-90">{product.description}</div>}
        {product.details.length > 0 && (
          <section aria-labelledby="shop-product-details" className="flex flex-col gap-2">
            <h2 id="shop-product-details" className="text-sm font-semibold">{t('productDetails')}</h2>
            <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1.5 text-sm">
              {product.details.map((d, i) => (
                <div key={i} className="contents">
                  <dt className="opacity-60">{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
        {product.disclosure && <p className="text-xs opacity-60">{product.disclosure}</p>}
      </div>

      {barShown && variant && (
        <div role="region" aria-label={t('buy.buyBar')} data-shop-buy-bar
          className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-black/10 bg-[var(--shop-surface)] px-4 pt-2 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] motion-safe:animate-in motion-safe:slide-in-from-bottom md:hidden"
          style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{product.name}</p>
            <p className="font-semibold text-[var(--shop-primary)]">{money(variant.priceMinor)}</p>
          </div>
          <button type="button" disabled={!canAdd} onClick={add}
            className="h-11 shrink-0 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
            {canAdd ? t('addToCart') : t('soldOut')}
          </button>
        </div>
      )}
    </div>
  );
}
