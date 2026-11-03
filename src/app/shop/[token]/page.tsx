import { Storefront } from '@/components/storefront/storefront';

export const dynamic = 'force-dynamic';

export default async function ShopPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <Storefront token={token} />;
}
