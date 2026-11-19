import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ProductCard, ProductGrid } from '@/components/shop-public/product-card';
import { loadPublicLinkPage } from '@/lib/commerce/link-page';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await loadPublicLinkPage((await params).handle);
  return { title: (await getTranslations('ShopPublic.linkPage'))('title'), description: page?.bio ?? undefined };
}

/** /s/<handle>/links: the shop's link-in-bio page. Inside the shop layout, so a password or coming-soon shop shows its lock screen instead. */
export default async function ShopLinksPage({ params }: Props) {
  const { handle } = await params;
  const page = await loadPublicLinkPage(handle);
  if (!page) notFound();
  const t = await getTranslations('ShopPublic.linkPage');
  const ts = await getTranslations('ShopPublic');
  const locale = await getLocale();
  const { shop } = page;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 py-4 text-center">
      {shop.logoUrl
        // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
        ? <img src={shop.logoUrl} alt={shop.name} className="h-20 w-auto max-w-[240px] object-contain" />
        : null}
      <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{shop.name}</h1>
      {page.bio && <p className="whitespace-pre-line opacity-80">{page.bio}</p>}
      <ul className="flex w-full flex-col gap-3">
        {page.links.map((link) => (
          <li key={link.url + link.label}>
            <a href={link.url} target="_blank" rel="noopener noreferrer nofollow"
              className="flex min-h-12 w-full items-center justify-center rounded-[var(--shop-radius)] border border-[var(--shop-primary)] px-4 py-3 text-sm font-semibold text-[var(--shop-primary)] hover:bg-[var(--shop-primary)] hover:text-[var(--shop-on-primary)]">
              {link.label}
            </a>
          </li>
        ))}
        <li>
          <Link href={`/s/${handle}`} className="flex min-h-12 w-full items-center justify-center rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-4 py-3 text-sm font-semibold text-[var(--shop-on-primary)]">
            {t('visitShop')}
          </Link>
        </li>
      </ul>
      {page.products.length > 0 && (
        <section className="w-full text-left" aria-labelledby="featured-heading">
          <h2 id="featured-heading" className="mb-3 text-lg font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('featured')}</h2>
          <ProductGrid columns={3}>
            {page.products.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={shop.currency}
              layout={shop.theme.layout} locale={locale} labels={{ soldOut: ts('soldOut'), from: ts('from') }} />)}
          </ProductGrid>
        </section>
      )}
    </div>
  );
}
