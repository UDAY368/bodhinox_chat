// Razorpay's after-payment redirect lands here. Read-only: the razorpay_*
// query parameters are never read; the order status comes from the database.
import { CheckoutDone } from '@/components/storefront/checkout-done';

export const dynamic = 'force-dynamic';

export default async function ShopDonePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CheckoutDone token={token} />;
}
