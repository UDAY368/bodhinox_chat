import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { loadShopAll } from '@/lib/commerce/public-shop';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ after?: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('allProducts') };
}

export default async function ShopAllPage({ params, searchParams }: Props) {
  const { handle } = await params;
  const { after } = await searchParams;
  const data = await loadShopAll(handle, typeof after === 'string' ? after : undefined);
  if (!data) notFound();
  const t = await getTranslations('ShopPublic');
  const locale = await getLocale();
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold sm:text-3xl" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('allProducts')}</h1>
      {data.products.length === 0 ? <p className="opacity-70">{t('noProducts')}</p> : (
        <ProductGrid columns={data.shop.theme.layout.columns}>
          {data.products.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={data.shop.currency}
            layout={data.shop.theme.layout} locale={locale} labels={{ soldOut: t('soldOut'), from: t('from') }} />)}
        </ProductGrid>
      )}
      {data.next && (
        <Link href={`/s/${handle}/all?after=${encodeURIComponent(data.next)}`} rel="next"
          className="mx-auto rounded-[var(--shop-radius)] border border-black/15 px-5 py-3 text-sm font-medium">{t('nextPage')}</Link>
      )}
    </div>
  );
}
