import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ShopT } from '@/components/shop-public/shop-link';
import { ShopSectionsView } from '@/components/shop-public/shop-sections';
import { loadShopHome, themeImageUrl } from '@/lib/commerce/public-shop';

export const dynamic = 'force-dynamic';

export default async function ShopHomePage({ params }: { params: Promise<{ handle: string }> }) {
  const home = await loadShopHome((await params).handle);
  if (!home) notFound();
  const t = await getTranslations('ShopPublic');
  const { shop } = home;
  return <ShopSectionsView sections={home.content.sections} ctx={{
    base: `/s/${shop.handle}`, handle: shop.handle, theme: shop.theme, currency: shop.currency, locale: await getLocale(),
    products: home.products, categories: home.categories, tree: home.tree, collections: home.collections, whatsappPhone: shop.whatsappPhone,
    image: (ref) => themeImageUrl(shop.handle, ref), t: t as unknown as ShopT,
  }} />;
}
