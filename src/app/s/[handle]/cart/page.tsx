import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getShop } from '@/components/shop-public/load';
import { ShopCart } from '@/components/shop-public/shop-cart';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  // The cart is personal: never indexed.
  return { title: (await getTranslations('ShopPublic'))('cart'), robots: { index: false, follow: false } };
}

export default async function ShopCartPage({ params }: { params: Promise<{ handle: string }> }) {
  const shop = await getShop((await params).handle);
  if (!shop) notFound();
  return <ShopCart shop={{ handle: shop.handle, name: shop.name, checkoutOpen: shop.checkoutOpen, ordering: shop.ordering,
    pricesIncludeTax: shop.pricesIncludeTax }} />;
}
