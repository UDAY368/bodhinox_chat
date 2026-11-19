// /s/<handle>: a workspace's public shop (store plan Phase 1). Anyone can open
// it and search engines may index it; it shows only the shop's settings and
// published products. An unknown, unpublished, suspended or downgraded shop is
// the plain 404.

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { ShopFrame } from '@/components/shop-public/shop-frame';
import { getShopGate } from '@/components/shop-public/load';
import { ShopLock } from '@/components/shop-public/shop-lock';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const gate = await getShopGate((await params).handle);
  if (!gate) return { robots: { index: false, follow: false } };
  const shop = gate.shop;
  // A locked shop shows only its name and is never indexed.
  if (gate.state !== 'open') return { title: { absolute: shop.name }, robots: { index: false, follow: false } };
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
  const gate = await getShopGate((await params).handle);
  if (!gate) notFound();
  if (gate.state !== 'open') return <ShopLock shop={gate.shop} mode={gate.state} message={gate.message} />;
  return <ShopFrame shop={gate.shop}>{children}</ShopFrame>;
}
