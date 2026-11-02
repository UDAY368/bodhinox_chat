/** The URL a WooCommerce webhook posts to for one store connection. */
export function wooDeliveryUrl(storeId: string): string {
  const base = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${new URL(base).origin}/api/integrations/woocommerce/webhook/${encodeURIComponent(storeId)}`;
}
