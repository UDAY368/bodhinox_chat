import type { Metadata, ResolvingMetadata } from 'next';
import { notFound } from 'next/navigation';
import { absoluteUrl } from '@/lib/commerce/shop-seo';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ShopT } from '@/components/shop-public/shop-link';
import { ShopSectionsView } from '@/components/shop-public/shop-sections';
import { isShopHandleFormat, loadShopHome } from '@/lib/commerce/public-shop';
import { themeImageUrl } from '@/lib/commerce/shop-images';

export const dynamic = 'force-dynamic';

// Store Batch 6: the home page's own canonical and og:url (the layout sets the rest; it cannot set these without every page inheriting them).
export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }, parent: ResolvingMetadata): Promise<Metadata> {
  const { handle } = await params;
  if (!isShopHandleFormat(handle)) return {};
  const url = absoluteUrl(`/s/${handle}`);
  // openGraph replaces the layout's whole object, so the layout's title, description and image are carried over.
  const { openGraph } = await parent;
  return { alternates: { canonical: url }, openGraph: { ...(openGraph as Metadata['openGraph']), url } };
}

export default async function ShopHomePage({ params }: { params: Promise<{ handle: string }> }) {
  const home = await loadShopHome((await params).handle);
  if (!home) notFound();
  const t = await getTranslations('ShopPublic');
  const { shop } = home;
  return <ShopSectionsView sections={home.content.sections} ctx={{
    base: `/s/${shop.handle}`, handle: shop.handle, theme: shop.theme, currency: shop.currency, locale: await getLocale(),
    products: home.products, categories: home.categories, tree: home.tree, collections: home.collections, bestSellers: home.bestSellers, whatsappPhone: shop.whatsappPhone,
    image: (ref) => themeImageUrl(shop.handle, ref), t: t as unknown as ShopT,
  }} />;
}
