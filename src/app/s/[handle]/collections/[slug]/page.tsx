// A collection page: the products an admin picked, or the products that match a smart collection's rules, in the
// shop's own style. Only published collections are shown, and only published products with a priced variant.
// Sort and page are plain links, so it works without JavaScript.

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { COLLECTION_SORTS } from '@/lib/commerce/catalogue/collection-rules';
import { loadShopCollection } from '@/lib/commerce/public-shop';

export const dynamic = 'force-dynamic';

type Search = { sort?: string; page?: string };
type Props = { params: Promise<{ handle: string; slug: string }>; searchParams: Promise<Search> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle, slug } = await params;
  const page = await loadShopCollection(handle, slug);
  if (!page) return { robots: { index: false, follow: false } };
  return {
    title: page.collection.title, description: page.collection.description?.slice(0, 160) ?? undefined,
    alternates: { canonical: `/s/${handle}/collections/${slug}` },
  };
}

export default async function ShopCollectionPage({ params, searchParams }: Props) {
  const { handle, slug } = await params;
  const query = await searchParams;
  const page = await loadShopCollection(handle, slug, query);
  if (!page) notFound();
  const t = await getTranslations('ShopPublic');
  const locale = await getLocale();
  const base = `/s/${handle}/collections/${slug}`;
  const link = (n: number, sort: string) => {
    const qs = new URLSearchParams();
    if (query.sort && sort) qs.set('sort', sort);
    if (n > 1) qs.set('page', String(n));
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  };
  const field = 'h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-sm text-black';
  return (
    <div className="flex flex-col gap-5">
      <nav aria-label={t('breadcrumb')} className="text-sm opacity-70">
        <Link href={`/s/${handle}`} className="hover:underline">{t('home')}</Link>
      </nav>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold @2xl:text-3xl" style={{ fontFamily: 'var(--shop-font-heading)' }}>{page.collection.title}</h1>
        {page.collection.description && <p className="max-w-2xl whitespace-pre-line opacity-80">{page.collection.description}</p>}
      </div>

      <form method="get" action={base} className="flex flex-wrap items-end gap-2 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-3 ring-1 ring-black/5">
        <label className="flex flex-col gap-1 text-xs">
          {t('sortLabel')}
          <select name="sort" defaultValue={page.sort} className={field}>
            {COLLECTION_SORTS.map((s) => <option key={s} value={s}>{t(`sort.${s}`)}</option>)}
          </select>
        </label>
        <button type="submit" className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 text-sm font-semibold text-[var(--shop-on-primary)]">
          {t('apply')}
        </button>
      </form>

      <p className="text-sm opacity-70" role="status">{t('resultCount', { count: page.total })}</p>
      {page.products.length === 0 ? <p className="opacity-70">{t('noMatching')}</p> : (
        <ProductGrid columns={page.shop.theme.layout.columns}>
          {page.products.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={page.shop.currency}
            layout={page.shop.theme.layout} locale={locale} labels={{ soldOut: t('soldOut'), from: t('from') }} />)}
        </ProductGrid>
      )}
      {page.pages > 1 && (
        <nav aria-label={t('pagination')} className="flex items-center justify-center gap-3 text-sm">
          {page.page > 1 && <Link href={link(page.page - 1, page.sort)} rel="prev" className="rounded-[var(--shop-radius)] border border-black/15 px-4 py-2">{t('prevPage')}</Link>}
          <span>{t('pageOf', { page: page.page, pages: page.pages })}</span>
          {page.page < page.pages && <Link href={link(page.page + 1, page.sort)} rel="next" className="rounded-[var(--shop-radius)] border border-black/15 px-4 py-2">{t('nextPage')}</Link>}
        </nav>
      )}
    </div>
  );
}
