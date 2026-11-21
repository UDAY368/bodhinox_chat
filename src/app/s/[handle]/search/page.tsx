import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { getShop } from '@/components/shop-public/load';
import { SEARCH_SORTS, searchShop } from '@/lib/commerce/shop-search';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ q?: string; sort?: string; after?: string }> };

// A results page is never indexed: its content is whatever was typed.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('search.title'), robots: { index: false, follow: true } };
}

export default async function ShopSearchPage({ params, searchParams }: Props) {
  const { handle } = await params;
  const { q, sort, after } = await searchParams;
  const [shop, result] = await Promise.all([getShop(handle), searchShop(handle, typeof q === 'string' ? q : '', { sort, after })]);
  if (!shop || !result) notFound();
  const t = await getTranslations('ShopPublic');
  const locale = await getLocale();
  const base = `/s/${handle}/search`;
  // Keyset paging (store Batch 6): the next page is ?after=<cursor> with the same words and sort.
  const link = (cursor: string | null) => {
    const qs = new URLSearchParams({ q: result.query });
    if (result.sort !== 'relevance') qs.set('sort', result.sort);
    if (cursor) qs.set('after', cursor);
    return `${base}?${qs.toString()}`;
  };
  const later = typeof after === 'string' && after.length > 0;
  const field = 'h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-sm text-black';
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold @2xl:text-3xl" style={{ fontFamily: 'var(--shop-font-heading)' }}>
        {result.query ? t('search.resultsFor', { query: result.query }) : t('search.title')}
      </h1>
      {!result.query ? <p className="opacity-80">{t('search.prompt')}</p>
        : result.products.length === 0 ? <p role="status" className="opacity-80">{t('search.noResults')}</p> : (
          <>
            <form method="get" action={base} className="flex flex-wrap items-end gap-2 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-3 ring-1 ring-black/5">
              <input type="hidden" name="q" value={result.query} />
              <label className="flex flex-col gap-1 text-xs">
                {t('sortLabel')}
                <select name="sort" defaultValue={result.sort} className={field}>
                  {SEARCH_SORTS.map((s) => <option key={s} value={s}>{t(`sort.${s}`)}</option>)}
                </select>
              </label>
              <button type="submit" className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 text-sm font-semibold text-[var(--shop-on-primary)]">
                {t('apply')}
              </button>
            </form>
            <p className="text-sm opacity-70" role="status">{t('resultCount', { count: result.total })}</p>
            <ProductGrid columns={shop.theme.layout.columns}>
              {result.products.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={shop.currency}
                layout={shop.theme.layout} locale={locale} labels={{ soldOut: t('soldOut'), from: t('from') }} />)}
            </ProductGrid>
          </>
        )}
      {result.query && (later || result.next) && (
        <nav aria-label={t('pagination')} className="flex items-center justify-center gap-3 text-sm">
          {later && <Link href={link(null)} className="inline-flex h-11 items-center rounded-[var(--shop-radius)] border border-black/15 px-4">{t('firstPage')}</Link>}
          {result.next && <Link href={link(result.next)} rel="next" className="inline-flex h-11 items-center rounded-[var(--shop-radius)] border border-black/15 px-4">{t('nextPage')}</Link>}
        </nav>
      )}
    </div>
  );
}
