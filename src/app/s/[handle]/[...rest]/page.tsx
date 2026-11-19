// Any shop path no page answers (an old address): follow the admin's redirect rule for it, otherwise the plain 404.
// Real pages are matched first; this only sees paths with nothing behind them.

import type { Metadata } from 'next';
import { notFoundOrRedirect } from '@/lib/commerce/shop-not-found';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string; rest: string[] }> };

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ShopUnknownPath({ params }: Props) {
  const { handle, rest } = await params;
  return notFoundOrRedirect(handle, `/${rest.join('/')}`);
}
