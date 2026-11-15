import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getShop } from '@/components/shop-public/load';
import { ShopCart } from '@/components/shop-public/shop-cart';
import { listAddressesTx, readAsCustomer } from '@/lib/commerce/shop-customer';
import { CUSTOMER_COOKIE } from '@/lib/commerce/shop-customer-cookie';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  // The cart is personal: never indexed.
  return { title: (await getTranslations('ShopPublic'))('cart'), robots: { index: false, follow: false } };
}

export default async function ShopCartPage({ params }: { params: Promise<{ handle: string }> }) {
  const shop = await getShop((await params).handle);
  if (!shop) notFound();
  // A signed-in buyer (store plan Phase 5) can check out without a new code and pick a saved address.
  const token = (await cookies()).get(CUSTOMER_COOKIE)?.value;
  const signedIn = token ? await readAsCustomer(shop.handle, token, listAddressesTx) : null;
  const buyer = signedIn?.customer ? {
    phoneMasked: signedIn.customer.phoneMasked,
    addresses: signedIn.value.map((a) => ({ id: a.id, label: [a.name, a.line1, a.city, a.postal_code].filter(Boolean).join(', ') })),
  } : null;
  return <ShopCart shop={{ handle: shop.handle, name: shop.name, checkoutOpen: shop.checkoutOpen, ordering: shop.ordering,
    pricesIncludeTax: shop.pricesIncludeTax }} buyer={buyer} />;
}
