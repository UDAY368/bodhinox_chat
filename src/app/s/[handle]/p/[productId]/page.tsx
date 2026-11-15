import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductBuy } from '@/components/shop-public/product-buy';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { ProductReviewsSection } from '@/components/shop-public/product-reviews';
import { loadShopProduct } from '@/lib/commerce/public-shop';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string; productId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle, productId } = await params;
  const page = await loadShopProduct(handle, productId);
  if (!page) return { robots: { index: false, follow: false } };
  const description = page.product.description?.slice(0, 160) ?? undefined;
  return {
    title: page.product.name, description,
    alternates: { canonical: `/s/${handle}/p/${productId}` },
    openGraph: { title: page.product.name, description, images: page.product.images[0] },
  };
}

export default async function ShopProductPage({ params }: Props) {
  const { handle, productId } = await params;
  const page = await loadShopProduct(handle, productId);
  if (!page) notFound();
  const t = await getTranslations('ShopPublic');
  const locale = await getLocale();
  const { product, reviews } = page;
  const summary = reviews.summary;
  return (
    <div className="flex flex-col gap-10">
      <nav aria-label={t('breadcrumb')} className="text-sm opacity-70">
        <Link href={`/s/${handle}`} className="hover:underline">{t('home')}</Link>
        {product.categoryId && product.categoryName && (
          <>
            {' / '}
            <Link href={`/s/${handle}/c/${product.categoryId}`} className="hover:underline">{product.categoryName}</Link>
          </>
        )}
      </nav>
      <ProductBuy handle={handle} product={product} currency={page.shop.currency} canNotify={page.shop.ordering.whatsapp} />
      <ProductReviewsSection reviews={reviews} locale={locale} labels={{
        title: t('reviews.title'), customer: t('reviews.customer'), stars: (rating) => t('reviews.stars', { rating }),
        average: summary ? t('reviews.average', { average: summary.average }) : '', count: summary ? t('reviews.count', { count: summary.count }) : '',
      }} />
      {page.boughtTogether.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t(page.togetherIsRelated ? 'related' : 'boughtTogether')}</h2>
          <ProductGrid columns={page.shop.theme.layout.columns}>
            {page.boughtTogether.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={page.shop.currency}
              layout={page.shop.theme.layout} locale={locale} labels={{ soldOut: t('soldOut'), from: t('from') }} />)}
          </ProductGrid>
        </section>
      )}
    </div>
  );
}
