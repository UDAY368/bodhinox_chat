// /s/<handle>/account/orders/<orderId>: one of the signed-in buyer's own orders
// (store plan Phase 5). Anyone else's order id, or another shop's, is the plain
// 404; signed out goes back to the sign-in page.
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AccountOrder } from '@/components/shop-public/account-orders';
import { loadOrderDetailTx, readAsCustomer } from '@/lib/commerce/shop-customer';
import { CUSTOMER_COOKIE } from '@/lib/commerce/shop-customer-cookie';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string; orderId: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('account.orders'), robots: { index: false, follow: false } };
}

export default async function ShopAccountOrderPage({ params }: Props) {
  const { handle, orderId } = await params;
  const result = await readAsCustomer(handle, (await cookies()).get(CUSTOMER_COOKIE)?.value, (tx, customer) => loadOrderDetailTx(tx, customer, orderId));
  if (!result) notFound();
  if (!result.customer) redirect(`/s/${handle}/account`);
  if (!result.value) notFound();
  return <AccountOrder handle={handle} detail={result.value} locale={await getLocale()} />;
}
