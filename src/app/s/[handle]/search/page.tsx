import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { getShop } from '@/components/shop-public/load';
import { searchShop } from '@/lib/commerce/shop-search';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ q?: string }> };

// A results page is never indexed: its content is whatever was typed.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('search.title'), robots: { index: false, follow: true } };
}

export default async function ShopSearchPage({ params, searchParams }: Props) {
  const { handle } = await params;
  const { q } = await searchParams;
  const [shop, result] = await Promise.all([getShop(handle), searchShop(handle, typeof q === 'string' ? q : '')]);
  if (!shop || !result) notFound();
  const t = await getTranslations('ShopPublic');
  const locale = await getLocale();
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold @2xl:text-3xl" style={{ fontFamily: 'var(--shop-font-heading)' }}>
        {result.query ? t('search.resultsFor', { query: result.query }) : t('search.title')}
      </h1>
      {!result.query ? <p className="opacity-80">{t('search.prompt')}</p>
        : result.products.length === 0 ? <p role="status" className="opacity-80">{t('search.noResults')}</p> : (
          <ProductGrid columns={shop.theme.layout.columns}>
            {result.products.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={shop.currency}
              layout={shop.theme.layout} locale={locale} labels={{ soldOut: t('soldOut'), from: t('from') }} />)}
          </ProductGrid>
        )}
    </div>
  );
}
