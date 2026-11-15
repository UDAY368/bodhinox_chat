import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ShopHomeView } from '@/components/shop-public/shop-home';
import { loadShopHome } from '@/lib/commerce/public-shop';

export const dynamic = 'force-dynamic';

export default async function ShopHomePage({ params }: { params: Promise<{ handle: string }> }) {
  const home = await loadShopHome((await params).handle);
  if (!home) notFound();
  const t = await getTranslations('ShopPublic');
  const template = home.shop.theme.template;
  return <ShopHomeView home={home} locale={await getLocale()} labels={{
    headline: home.shop.theme.headline ?? t(`templates.${template}.headline`),
    subheadline: home.shop.theme.subheadline ?? t(`templates.${template}.subheadline`),
    shopNow: t('shopNow'), categories: t('categories'), featured: t('featured'), viewAll: t('viewAll'), empty: t('noProducts'),
    soldOut: t('soldOut'), from: t('from'),
  }} />;
}
