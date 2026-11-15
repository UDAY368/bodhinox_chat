// /s/<handle>: a workspace's public shop (store plan Phase 1). Anyone can open
// it and search engines may index it; it shows only the shop's settings and
// published products. An unknown, unpublished, suspended or downgraded shop is
// the plain 404.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ShopFrame } from '@/components/shop-public/shop-frame';
import { getShop } from '@/components/shop-public/load';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await getShop((await params).handle);
  if (!shop) return { robots: { index: false, follow: false } };
  const description = shop.theme.subheadline ?? shop.theme.headline ?? undefined;
  return {
    // absolute: a seller's shop never carries the app's own name in the tab.
    title: { absolute: shop.name, template: `%s | ${shop.name}` },
    description,
    robots: { index: true, follow: true },
    icons: shop.logoUrl ? { icon: shop.logoUrl } : undefined,
    openGraph: { title: shop.name, description, type: 'website', images: shop.bannerUrl ?? shop.logoUrl ?? undefined },
  };
}

export default async function ShopLayout({ children, params }: Props & { children: ReactNode }) {
  const shop = await getShop((await params).handle);
  if (!shop) notFound();
  return <ShopFrame shop={shop}>{children}</ShopFrame>;
}
