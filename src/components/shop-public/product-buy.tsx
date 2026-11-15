'use client';

/**
 * The product page's interactive part: image gallery, one picker per option
 * (size, color…), quantity and "Add to cart" into the browser cart. Prices
 * shown here are the variant prices; tax, shipping and coupons are worked out
 * on the server at checkout. A sold-out variant of a shop with a WhatsApp number
 * offers "Notify me on WhatsApp": the buyer's own message claims the alert.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bell, Check, Loader2, Minus, Plus } from 'lucide-react';
import type { PublicProduct } from '@/lib/commerce/public-shop';
import { formatMoney } from '@/lib/commerce/money';
import { addToCart, MAX_QTY } from './cart-store';
import { PincodeCheck } from './pincode-check';

export function ProductBuy({ handle, product, currency, canNotify }: { handle: string; product: PublicProduct; currency: string | null; canNotify: boolean }) {
  const t = useTranslations('ShopPublic');
  const locale = useLocale();
  const optionNames = useMemo(() => [...new Set(product.variants.flatMap((v) => Object.keys(v.options)))], [product.variants]);
  const first = product.variants.find((v) => v.inStock) ?? product.variants[0];
  const [picked, setPicked] = useState<Record<string, string>>(first?.options ?? {});
  const [qty, setQty] = useState(1);
  // A variant with its own picture shows it in the gallery (imageIndex is its place among `product.images`).
  const [image, setImage] = useState(first?.imageIndex ?? 0);
  const [added, setAdded] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  const variantFor = (choice: Record<string, string>) => product.variants.find((v) => optionNames.every((n) => v.options[n] === choice[n])) ?? null;
  const variant = variantFor(picked);
  const money = (minor: number) => (currency ? formatMoney(minor, currency, locale) : '');
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
  const valuesOf = (name: string) => [...new Set(product.variants.map((v) => v.options[name]).filter(Boolean))];

  return (
    <div className="grid gap-6 @3xl:grid-cols-2 @3xl:gap-10">
      <div className="flex flex-col gap-3">
        <div className="aspect-square overflow-hidden rounded-[var(--shop-radius)] bg-black/5">
          {product.images[image]
            // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
            ? <img src={product.images[image]} alt={product.name} className="size-full object-cover" />
            : <div className="grid size-full place-items-center text-6xl opacity-30" aria-hidden>{product.name.slice(0, 1)}</div>}
        </div>
        {product.images.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {product.images.map((src, i) => (
              <button key={src} type="button" onClick={() => setImage(i)} aria-label={t('imageN', { n: i + 1 })} aria-pressed={i === image}
                className={`size-16 shrink-0 overflow-hidden rounded-[var(--shop-radius)] ring-2 ${i === image ? 'ring-[var(--shop-primary)]' : 'ring-transparent'}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                <img src={src} alt="" className="size-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-5">
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
                return (
                  <button key={value} type="button" aria-pressed={on} onClick={() => {
                    const next = { ...picked, [name]: value };
                    setPicked(next);
                    setAdded(false);
                    const shows = variantFor(next)?.imageIndex;
                    if (shows !== null && shows !== undefined) setImage(shows);
                  }}
                    className={`min-h-11 rounded-[var(--shop-radius)] border px-4 text-sm ${on
                      ? 'border-[var(--shop-primary)] bg-[var(--shop-primary)] text-[var(--shop-on-primary)]'
                      : 'border-black/15 bg-[var(--shop-surface)] hover:border-black/40'}`}>
                    {value}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <p className="text-sm" role="status">
          {!variant ? t('pickOptions') : variant.inStock ? t('inStock') : t('soldOut')}
        </p>

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-[var(--shop-radius)] border border-black/15 bg-[var(--shop-surface)]">
            <button type="button" className="grid size-11 place-items-center" aria-label={t('decrease')} onClick={() => setQty(Math.max(1, qty - 1))}>
              <Minus className="size-4" aria-hidden />
            </button>
            <span className="w-8 text-center tabular-nums" aria-live="polite">{qty}</span>
            <button type="button" className="grid size-11 place-items-center" aria-label={t('increase')} onClick={() => setQty(Math.min(MAX_QTY, qty + 1))}>
              <Plus className="size-4" aria-hidden />
            </button>
          </div>
          <button type="button" disabled={!variant || !variant.inStock}
            onClick={() => { if (variant) { addToCart(handle, variant.id, qty); setAdded(true); } }}
            className="h-11 flex-1 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
            {t('addToCart')}
          </button>
        </div>
        <PincodeCheck handle={handle} variantId={variant?.id ?? null} quantity={qty} />
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
    </div>
  );
}
