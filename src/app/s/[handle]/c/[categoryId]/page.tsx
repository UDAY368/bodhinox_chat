// A category page: the category's products (and its sub-categories'), with
// sort, a price range and one option filter as a plain GET form, so it works
// without JavaScript and every filtered view has its own link.

import type { Metadata } from 'next';
import Link from 'next/link';
import { permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { CATEGORY_SORTS, loadShopCategory } from '@/lib/commerce/public-shop';
import { notFoundOrRedirect } from '@/lib/commerce/shop-not-found';
import { categoryPath, isUuidShaped } from '@/lib/commerce/shop-paths';
import { absoluteUrl } from '@/lib/commerce/shop-seo';

export const dynamic = 'force-dynamic';

type Search = { sort?: string; min?: string; max?: string; option?: string; page?: string };
// `categoryId` is the address segment: the category's slug, or its id from an old link (answered with a 308 to the slug address).
type Props = { params: Promise<{ handle: string; categoryId: string }>; searchParams: Promise<Search> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle, categoryId } = await params;
  const page = await loadShopCategory(handle, categoryId);
  if (!page) return { robots: { index: false, follow: false } };
  const url = absoluteUrl(categoryPath(handle, page.category));
  return {
    title: page.category.name, alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: page.shop.name, title: page.category.name },
    twitter: { card: 'summary', title: page.category.name },
  };
}

export default async function ShopCategoryPage({ params, searchParams }: Props) {
  const { handle, categoryId } = await params;
  const query = await searchParams;
  const page = await loadShopCategory(handle, categoryId, query);
  if (!page) return notFoundOrRedirect(handle, `/c/${categoryId}`);
  const base = categoryPath(handle, page.category);
  // An old id link moves for good to the readable address (308), keeping its filters.
  if (isUuidShaped(categoryId) && page.category.slug) {
    const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => typeof e[1] === 'string')).toString();
    permanentRedirect(qs ? `${base}?${qs}` : base);
  }
  const t = await getTranslations('ShopPublic');
  const locale = await getLocale();
  const pageLink = (n: number) => {
    const qs = new URLSearchParams();
    for (const key of ['sort', 'min', 'max', 'option'] as const) if (typeof query[key] === 'string' && query[key]) qs.set(key, query[key]!);
    if (n > 1) qs.set('page', String(n));
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  };
  const field = 'h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-sm text-black';
  return (
    <div className="flex flex-col gap-5">
      <nav aria-label={t('breadcrumb')} className="text-sm opacity-70">
        <Link href={`/s/${handle}`} className="hover:underline">{t('home')}</Link>
        {page.category.parentId && <> {' / '}<Link href={categoryPath(handle, { id: page.category.parentId, slug: page.category.parentSlug })} className="hover:underline">{t('up')}</Link></>}
      </nav>
      <h1 className="text-2xl font-semibold @2xl:text-3xl" style={{ fontFamily: 'var(--shop-font-heading)' }}>{page.category.name}</h1>
      {page.children.length > 0 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4">
          {page.children.map((c) => (
            <Link key={c.id} href={categoryPath(handle, c)}
              className="inline-flex h-11 shrink-0 items-center rounded-full border border-black/15 bg-[var(--shop-surface)] px-4 text-sm">{c.name}</Link>
          ))}
        </div>
      )}

      <form method="get" action={base} className="flex flex-wrap items-end gap-2 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-3 ring-1 ring-black/5">
        <label className="flex flex-col gap-1 text-xs">
          {t('sortLabel')}
          <select name="sort" defaultValue={page.sort} className={field}>
            {CATEGORY_SORTS.map((s) => <option key={s} value={s}>{t(`sort.${s}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t('minPrice')}
          <input name="min" inputMode="numeric" pattern="[0-9]*" defaultValue={query.min ?? ''} className={`${field} w-24`} />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t('maxPrice')}
          <input name="max" inputMode="numeric" pattern="[0-9]*" defaultValue={query.max ?? ''} className={`${field} w-24`} />
        </label>
        {Object.keys(page.options).length > 0 && (
          <label className="flex flex-col gap-1 text-xs">
            {t('optionLabel')}
            <select name="option" defaultValue={query.option ?? ''} className={field}>
              <option value="">{t('anyOption')}</option>
              {Object.entries(page.options).map(([name, values]) => (
                <optgroup key={name} label={name}>
                  {values.map((v) => <option key={`${name}:${v}`} value={`${name}:${v}`}>{v}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
        )}
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
          {page.page > 1 && <Link href={pageLink(page.page - 1)} rel="prev" className="rounded-[var(--shop-radius)] border border-black/15 px-4 py-2">{t('prevPage')}</Link>}
          <span>{t('pageOf', { page: page.page, pages: page.pages })}</span>
          {page.page < page.pages && <Link href={pageLink(page.page + 1)} rel="next" className="rounded-[var(--shop-radius)] border border-black/15 px-4 py-2">{t('nextPage')}</Link>}
        </nav>
      )}
    </div>
  );
}
