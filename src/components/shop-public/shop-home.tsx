/**
 * The shop's home page: a banner in the template's style (image beside the
 * text, image behind it, or a color band), the categories as chips or tiles,
 * and the featured products. Every value comes from the shop's validated
 * settings; text is rendered by React (escaped).
 */
import Link from 'next/link';
import type { ShopHome } from '@/lib/commerce/public-shop';
import { ProductCard, ProductGrid } from './product-card';

export interface HomeLabels {
  headline: string; subheadline: string; shopNow: string; categories: string; featured: string; viewAll: string; empty: string;
  soldOut: string; from: string;
}

const heading = { fontFamily: 'var(--shop-font-heading)' } as const;

function Hero({ home, labels }: { home: ShopHome; labels: HomeLabels }) {
  const { shop } = home;
  const base = `/s/${shop.handle}`;
  const cta = (
    <Link href={`${base}/all`} className="inline-flex h-12 items-center rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-6 font-semibold text-[var(--shop-on-primary)]">
      {labels.shopNow}
    </Link>
  );
  const text = (
    <>
      <h1 className="text-3xl font-semibold leading-tight sm:text-5xl" style={heading}>{labels.headline}</h1>
      <p className="max-w-xl text-base opacity-80 sm:text-lg">{labels.subheadline}</p>
    </>
  );
  if (shop.theme.layout.hero === 'full' && shop.bannerUrl) return (
    <section className="relative isolate overflow-hidden rounded-[var(--shop-radius)]">
      {/* eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL */}
      <img src={shop.bannerUrl} alt="" className="absolute inset-0 -z-10 size-full object-cover" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
      <div className="flex min-h-[340px] flex-col justify-end gap-4 p-6 text-white sm:min-h-[460px] sm:p-10">{text}<div>{cta}</div></div>
    </section>
  );
  if (shop.theme.layout.hero === 'split' && shop.bannerUrl) return (
    <section className="grid items-center gap-6 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-5 ring-1 ring-black/5 sm:p-8 md:grid-cols-2">
      <div className="order-2 flex flex-col gap-4 md:order-1">{text}<div>{cta}</div></div>
      {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
      <img src={shop.bannerUrl} alt="" className="order-1 aspect-[4/3] w-full rounded-[var(--shop-radius)] object-cover md:order-2" />
    </section>
  );
  return (
    <section className="flex flex-col gap-4 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] p-6 text-[var(--shop-on-primary)] sm:p-10">
      {text}
      <div>
        <Link href={`${base}/all`} className="inline-flex h-12 items-center rounded-[var(--shop-radius)] bg-[var(--shop-accent)] px-6 font-semibold text-[var(--shop-on-accent)]">
          {labels.shopNow}
        </Link>
      </div>
    </section>
  );
}

export function ShopHomeView({ home, locale, labels }: { home: ShopHome; locale: string; labels: HomeLabels }) {
  const { shop } = home;
  const base = `/s/${shop.handle}`;
  return (
    <div className="flex flex-col gap-8 sm:gap-12">
      <Hero home={home} labels={labels} />

      {home.categories.length > 0 && (
        <section aria-labelledby="shop-categories" className="flex flex-col gap-3">
          <h2 id="shop-categories" className="text-xl font-semibold sm:text-2xl" style={heading}>{labels.categories}</h2>
          {shop.theme.layout.categories === 'tiles' ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {home.categories.map((c) => (
                <Link key={c.id} href={`${base}/c/${c.id}`}
                  className="flex min-h-20 items-end rounded-[var(--shop-radius)] bg-[var(--shop-accent)] p-4 font-semibold text-[var(--shop-on-accent)] hover:opacity-90">
                  {c.name}
                </Link>
              ))}
            </div>
          ) : (
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {home.categories.map((c) => (
                <Link key={c.id} href={`${base}/c/${c.id}`}
                  className="inline-flex h-11 shrink-0 items-center rounded-full border border-black/15 bg-[var(--shop-surface)] px-4 text-sm hover:border-black/40">
                  {c.name}
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="shop-featured" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="shop-featured" className="text-xl font-semibold sm:text-2xl" style={heading}>{labels.featured}</h2>
          <Link href={`${base}/all`} className="text-sm font-medium underline">{labels.viewAll}</Link>
        </div>
        {home.featured.length === 0 ? <p className="opacity-70">{labels.empty}</p> : (
          <ProductGrid columns={shop.theme.layout.columns}>
            {home.featured.map((p) => <ProductCard key={p.id} handle={shop.handle} product={p} currency={shop.currency}
              layout={shop.theme.layout} locale={locale} labels={{ soldOut: labels.soldOut, from: labels.from }} />)}
          </ProductGrid>
        )}
      </section>
    </div>
  );
}
