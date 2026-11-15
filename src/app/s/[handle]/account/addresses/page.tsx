// /s/<handle>/account/addresses: the signed-in buyer's saved addresses in this
// shop (store plan Phase 5), at most five. Signed out goes back to the sign-in page.
import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AccountAddresses } from '@/components/shop-public/account-addresses';
import { listAddressesTx, readAsCustomer } from '@/lib/commerce/shop-customer';
import { CUSTOMER_COOKIE } from '@/lib/commerce/shop-customer-cookie';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('ShopPublic'))('account.addresses'), robots: { index: false, follow: false } };
}

export default async function ShopAccountAddressesPage({ params }: Props) {
  const { handle } = await params;
  const result = await readAsCustomer(handle, (await cookies()).get(CUSTOMER_COOKIE)?.value, listAddressesTx);
  if (!result) notFound();
  if (!result.customer) redirect(`/s/${handle}/account`);
  const t = await getTranslations('ShopPublic');
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link href={`/s/${handle}/account`} className="inline-flex min-h-11 items-center self-start text-sm underline">{t('account.back')}</Link>
      <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('account.addresses')}</h1>
      <AccountAddresses handle={handle} initial={result.value} />
    </div>
  );
}
