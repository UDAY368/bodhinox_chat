// /s/<handle>/track/<token>: the buyer's order tracking page (store plan Phase 5).
// The token names the workspace and the order; under another shop's handle, or when wrong, it is the plain 404.
// Never indexed, never cached.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { OrderTracking } from '@/components/shop-public/order-tracking';
import { loadOrderTracking } from '@/lib/commerce/order-tracking';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string; token: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('track.title'), robots: { index: false, follow: false } };
}

export default async function ShopTrackPage({ params }: Props) {
  const { handle, token } = await params;
  const view = await loadOrderTracking(handle, token);
  if (!view) notFound();
  return <OrderTracking view={view} locale={await getLocale()} />;
}
