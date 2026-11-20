// /s/<handle>/checkout/<token>/done: where Razorpay returns a buyer of the public shop after paying, inside the shop's
// frame and theme (the callback_url for a shop session of an open, published shop: shop-session-link.ts). Read-only:
// the razorpay_* query parameters are never read; the order status comes from the database. Same guard as the
// checkout page: a token that is not a live session of the workspace owning this handle is the plain 404.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ShopCheckoutDone } from '@/components/shop-public/shop-checkout';
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

export default async function ShopCheckoutDonePage({ params }: Props) {
  const { handle, token } = await params;
  if (!(await checkoutTokenBelongsToShop(handle, token))) notFound();
  return <ShopCheckoutDone handle={handle} token={token} />;
}
