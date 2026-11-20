import Link from 'next/link';
import type { PublicProduct } from '@/lib/commerce/public-shop';
import { productPath } from '@/lib/commerce/shop-paths';
import type { ShopLayout } from '@/lib/commerce/shop-templates';
import { formatMoney } from '@/lib/commerce/money';
import { Stars } from './product-reviews';
import { QuickAdd } from './quick-add';
import type { ShopT } from './shop-link';

/**
 * Card texts. `sale`, `add` and `added` are optional so older callers keep
 * working; without `add` a card shows no quick add, without `sale` no sale badge.
 */
export interface CardLabels { soldOut: string; from: string; sale?: (percent: number) => string; add?: string; added?: string }

/** Every card text from the shop's translations. */
export const cardLabels = (t: ShopT): Required<CardLabels> => ({
  soldOut: t('soldOut'), from: t('from'), sale: (percent) => t('card.sale', { percent }), add: t('addOne'), added: t('card.added'),
});

/** The one place a card builds its product link. */
const productHref = (handle: string, product: PublicProduct) => productPath(handle, product);

/**
 * One product in a grid, drawn the template's way (layout.card): `plain`
 * (image, name and price below), `bordered` (a bordered card with a quick add
 * button), `overlay` (name and price over the image) or `row` (a compact row
 * with a round + button, for long grocery lists). Lowest price with the
 * compare-at price struck through, a sale badge, sold out, the rating.
 */
export function ProductCard({ handle, product, currency, layout, locale, labels }: {
  handle: string; product: PublicProduct; currency: string | null; layout: ShopLayout; locale: string; labels: CardLabels;
}) {
  const cheapest = [...product.variants].sort((a, b) => a.priceMinor - b.priceMinor)[0];
  const varied = new Set(product.variants.map((v) => v.priceMinor)).size > 1;
  const soldOut = product.variants.every((v) => !v.inStock);
  const money = (minor: number) => (currency ? formatMoney(minor, currency, locale) : '');
  const onSale = !!cheapest && cheapest.compareAtMinor !== null && cheapest.compareAtMinor > cheapest.priceMinor;
  const percent = onSale ? Math.round((1 - cheapest.priceMinor / cheapest.compareAtMinor!) * 100) : 0;
  // Quick add only when there is nothing to choose: one variant, in stock.
  const only = product.variants.length === 1 && product.variants[0].inStock ? product.variants[0] : null;
  const quick = only && labels.add ? { variantId: only.id, label: labels.add, added: labels.added ?? labels.add } : null;
  const href = productHref(handle, product);
  const card = layout.card;

  const badges = (
    <>
      {soldOut && <span className="absolute left-2 top-2 rounded-full bg-black/75 px-2 py-0.5 text-xs font-medium text-white">{labels.soldOut}</span>}
      {!soldOut && onSale && percent > 0 && labels.sale && (
        <span className="absolute left-2 top-2 rounded-full bg-[var(--shop-accent)] px-2 py-0.5 text-xs font-semibold text-[var(--shop-on-accent)]">{labels.sale(percent)}</span>
      )}
    </>
  );
  const picture = (className: string) => (product.images[0]
    // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
    ? <img src={product.images[0]} alt={product.name} loading="lazy" className={className} />
    : <div className="grid size-full place-items-center text-3xl opacity-30" aria-hidden>{product.name.slice(0, 1)}</div>);
  const price = (tone: string) => cheapest && (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className={`font-semibold ${tone}`}>{varied ? `${labels.from} ` : ''}{money(cheapest.priceMinor)}</span>
      {onSale && <s className="text-xs opacity-70">{money(cheapest.compareAtMinor!)}</s>}
    </p>
  );
  const rating = product.rating && (
    <p className="flex items-center gap-1 text-xs @2xl:text-sm">
      <Stars value={product.rating.average} label={`${product.rating.average}/5`} />
      <span className="opacity-70">({product.rating.count})</span>
    </p>
  );
  const aspect = layout.image === 'portrait' ? 'aspect-[3/4]' : 'aspect-square';

  if (card === 'row') return (
    <div className="flex items-center gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-2 ring-1 ring-black/5">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-[var(--shop-radius)] bg-black/5">{picture('size-full object-cover')}</div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="line-clamp-2 text-sm font-medium">{product.name}</h3>
          {price('text-[var(--shop-primary)]')}
          {soldOut ? <span className="text-xs opacity-70">{labels.soldOut}</span>
            : onSale && percent > 0 && labels.sale && <span className="text-xs font-semibold text-[var(--shop-primary)]">{labels.sale(percent)}</span>}
        </div>
      </Link>
      {quick && <QuickAdd handle={handle} variantId={quick.variantId} label={`${quick.label}: ${product.name}`} addedLabel={quick.added} round />}
    </div>
  );

  if (card === 'overlay') return (
    <Link href={href} className={`group relative isolate flex ${aspect} flex-col justify-end overflow-hidden rounded-[var(--shop-radius)] bg-black/5`}>
      <div className="absolute inset-0 -z-10">{picture('size-full object-cover transition group-hover:scale-[1.03]')}</div>
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/75 via-black/20 to-transparent" />
      {badges}
      <div className="flex flex-col gap-0.5 p-3 text-white">
        <h3 className="line-clamp-2 text-sm font-semibold @2xl:text-base">{product.name}</h3>
        {price('text-white')}
      </div>
    </Link>
  );

  const bordered = card === 'bordered';
  return (
    <div className={`group flex flex-col overflow-hidden ${bordered
      ? 'rounded-[var(--shop-radius)] bg-[var(--shop-surface)] ring-1 ring-black/10 transition hover:shadow-md' : ''}`}>
      <Link href={href} className="flex flex-1 flex-col">
        <div className={`relative w-full overflow-hidden bg-black/5 ${aspect} ${bordered ? '' : 'rounded-[var(--shop-radius)]'}`}>
          {picture('size-full object-cover transition group-hover:scale-[1.03]')}
          {badges}
        </div>
        <div className={`flex flex-1 flex-col gap-1 ${bordered ? 'p-3' : 'px-0.5 pt-2'}`}>
          <h3 className="line-clamp-2 text-sm font-medium @2xl:text-base">{product.name}</h3>
          {rating}
          <div className="mt-auto">{price('text-[var(--shop-primary)]')}</div>
        </div>
      </Link>
      {bordered && quick && <div className="px-3 pb-3"><QuickAdd handle={handle} variantId={quick.variantId} label={quick.label} addedLabel={quick.added} /></div>}
    </div>
  );
}

/**
 * The product grid. Phones show two cards a row; a `row` card template (data-card on the shop frame) shows
 * one row a line on phones, two on tablets and three on wide screens.
 */
export function ProductGrid({ children, columns }: { children: React.ReactNode; columns: 3 | 4 }) {
  return (
    <div className={`grid grid-cols-2 gap-3 @2xl:gap-4 ${columns === 4 ? '@3xl:grid-cols-3 @5xl:grid-cols-4' : '@3xl:grid-cols-3'}
      [[data-card=row]_&]:grid-cols-1 @2xl:[[data-card=row]_&]:grid-cols-2 @3xl:[[data-card=row]_&]:grid-cols-2 @5xl:[[data-card=row]_&]:grid-cols-3`}>
      {children}
    </div>
  );
}
