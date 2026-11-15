// /s/<handle>/account: the buyer's account on the public shop (store plan Phase 5).
// Signed out: phone and WhatsApp code. Signed in: this buyer's own orders in
// this shop, newest first. Personal, so never indexed and never cached.
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AccountHome } from '@/components/shop-public/account-orders';
import { AccountSignIn } from '@/components/shop-public/account-sign-in';
import { getShop } from '@/components/shop-public/load';
import { listOrdersTx, readAsCustomer } from '@/lib/commerce/shop-customer';
import { accountPage, CUSTOMER_COOKIE } from '@/lib/commerce/shop-customer-cookie';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ page?: string | string[] }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('account.title'), robots: { index: false, follow: false } };
}

export default async function ShopAccountPage({ params, searchParams }: Props) {
  const { handle } = await params;
  const shop = await getShop(handle);
  if (!shop) notFound();
  const page = accountPage((await searchParams).page);
  const result = await readAsCustomer(handle, (await cookies()).get(CUSTOMER_COOKIE)?.value, (tx, customer) => listOrdersTx(tx, customer, page));
  if (!result) notFound();
  if (!result.customer) return <AccountSignIn handle={shop.handle} available={shop.ordering.otp} />;
  return <AccountHome handle={shop.handle} phoneMasked={result.customer.phoneMasked} data={result.value} locale={await getLocale()} />;
}
