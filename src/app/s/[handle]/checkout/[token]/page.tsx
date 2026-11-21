// /s/<handle>/checkout/<token>: the public shop's own checkout, inside the shop's frame and theme. The token is in
// the path, so no-referrer and never indexed. A token that is not a live session of the workspace that owns this
// handle (another shop's link, an unknown or ended one) is the plain 404. The page has no side effects: the client
// loads the session through /api/public/shop/<token>.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ShopCheckout } from '@/components/shop-public/shop-checkout';
import { checkoutTokenBelongsToShop } from '@/lib/commerce/public-shop';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string; token: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations('ShopPublic.checkout'))('title'),
    referrer: 'no-referrer',
    robots: { index: false, follow: false },
  };
}

export default async function ShopCheckoutPage({ params }: Props) {
  const { handle, token } = await params;
  if (!(await checkoutTokenBelongsToShop(handle, token))) notFound();
  return <ShopCheckout handle={handle} token={token} />;
}
