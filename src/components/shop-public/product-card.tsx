import Link from 'next/link';
import type { PublicProduct } from '@/lib/commerce/public-shop';
import type { ShopLayout } from '@/lib/commerce/shop-templates';
import { formatMoney } from '@/lib/commerce/money';
import { Stars } from './product-reviews';

export interface CardLabels { soldOut: string; from: string }

/** One product in a grid: image, name, lowest price (with the compare-at price struck through). */
export function ProductCard({ handle, product, currency, layout, locale, labels }: {
  handle: string; product: PublicProduct; currency: string | null; layout: ShopLayout; locale: string; labels: CardLabels;
}) {
  const cheapest = [...product.variants].sort((a, b) => a.priceMinor - b.priceMinor)[0];
  const varied = new Set(product.variants.map((v) => v.priceMinor)).size > 1;
  const soldOut = product.variants.every((v) => !v.inStock);
  const money = (minor: number) => (currency ? formatMoney(minor, currency, locale) : '');
  return (
    <Link href={`/s/${handle}/p/${product.id}`}
      className="group flex flex-col overflow-hidden rounded-[var(--shop-radius)] bg-[var(--shop-surface)] shadow-sm ring-1 ring-black/5 transition hover:shadow-md">
      <div className={`relative w-full overflow-hidden bg-black/5 ${layout.image === 'portrait' ? 'aspect-[3/4]' : 'aspect-square'}`}>
        {product.images[0]
          // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
          ? <img src={product.images[0]} alt={product.name} loading="lazy" className="size-full object-cover transition group-hover:scale-[1.03]" />
          : <div className="grid size-full place-items-center text-3xl opacity-30" aria-hidden>{product.name.slice(0, 1)}</div>}
        {soldOut && <span className="absolute left-2 top-2 rounded-full bg-black/75 px-2 py-0.5 text-xs font-medium text-white">{labels.soldOut}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm font-medium @2xl:text-base">{product.name}</h3>
        {product.rating && (
          <p className="flex items-center gap-1 text-xs @2xl:text-sm">
            <Stars value={product.rating.average} label={`${product.rating.average}/5`} />
            <span className="opacity-70">({product.rating.count})</span>
          </p>
        )}
        {cheapest && (
          <p className="mt-auto flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-semibold text-[var(--shop-primary)]">{varied ? `${labels.from} ` : ''}{money(cheapest.priceMinor)}</span>
            {cheapest.compareAtMinor !== null && cheapest.compareAtMinor > cheapest.priceMinor && (
              <s className="text-xs opacity-60">{money(cheapest.compareAtMinor)}</s>
            )}
          </p>
        )}
      </div>
    </Link>
  );
}

export function ProductGrid({ children, columns }: { children: React.ReactNode; columns: 3 | 4 }) {
  return <div className={`grid grid-cols-2 gap-3 @2xl:gap-4 ${columns === 4 ? '@3xl:grid-cols-3 @5xl:grid-cols-4' : '@3xl:grid-cols-3'}`}>{children}</div>;
}
