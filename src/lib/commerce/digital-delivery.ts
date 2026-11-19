/**
 * Digital products (store plan Phase 8, batch 3).
 *
 * A digital product has a file from the media library or an https URL and ships nothing. When a payment
 * credits the order (settle.ts creditOrderTx, the one place a payment is confirmed: the Razorpay webhook and
 * the staff "payment received" action both end there) this module queues the existing order notice job with
 * kind 'digital_delivery' in the same transaction (dedupe ofu:<order>:digital_delivery). The job (order-followup.ts)
 * sends one WhatsApp message through dispatchOnce: free text inside the 24 hour window, else the workspace's
 * approved 'digital_delivery' template. With no template the order's notice ledger shows it as blocked
 * (no_template) and nothing is sent; an uncertain send is recorded as needing a check and never re-sent.
 *
 * The message carries one signed link (selling-tokens.ts) that expires in 14 days. The download route
 * (/api/public/shop/download) checks signature, expiry and that the order is paid and not fully refunded, then
 * sends the buyer to the product's https URL or streams the media file itself: it never reveals a storage
 * path or credential. The buyer's own order page shows the same kind of link, so a buyer is never stuck
 * when the message could not be sent.
 */
import { appOrigin } from '@/lib/auth/csrf';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { downloadQuery, DOWNLOAD_LINK_TTL_MS } from './selling-tokens';

export const DOWNLOAD_PATH = '/api/public/shop/download';
export const DIGITAL_DELIVERY_KIND = 'digital_delivery';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Order statuses whose download works: paid and not given back. */
export const DOWNLOADABLE_STATUSES = ['paid', 'partially_shipped', 'dispatched', 'fulfilled'] as const;

export interface DigitalItem { productId: string; name: string }

/** The order's digital products (one entry per product). */
export async function orderDigitalItemsTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<DigitalItem[]> {
  const rows = await tx.$queryRaw<{ product_id: string; name: string }[]>`
    SELECT DISTINCT ON (p.id) p.id::text AS product_id, p.name FROM order_items i
    JOIN shop_variants v ON v.account_id=i.account_id AND v.id=i.variant_id
    JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id AND p.is_digital
    WHERE i.account_id=${accountId}::uuid AND i.order_id=${orderId}::uuid ORDER BY p.id LIMIT 20`;
  return rows.map((r) => ({ productId: r.product_id, name: r.name }));
}

/**
 * Queue the delivery message for a just-paid order that holds a digital product. Same transaction as the
 * payment; a second call (a replayed webhook) is a no-op by the dedupe key. Returns whether a job exists.
 */
export async function queueDigitalDeliveryTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<boolean> {
  if (!(await orderDigitalItemsTx(tx, accountId, orderId)).length) return false;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES('commerce.order_followup',${accountId}::uuid,${JSON.stringify({ orderId, kind: DIGITAL_DELIVERY_KIND })}::jsonb,${`ofu:${orderId}:${DIGITAL_DELIVERY_KIND}`})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return true;
}

/** A signed download link for the order, valid for 14 days from `now`. */
export function digitalDownloadUrl(accountId: string, orderId: string, now = new Date()): string {
  return `${appOrigin()}${DOWNLOAD_PATH}?${downloadQuery({ accountId, orderId }, new Date(now.getTime() + DOWNLOAD_LINK_TTL_MS))}`;
}

export type DownloadTarget =
  | { kind: 'url'; url: string }
  | { kind: 'media'; mediaId: string; name: string }
  | { kind: 'list'; items: DigitalItem[] };

/**
 * What a valid link leads to, or null (the plain 404): the order must exist, be paid and not fully refunded,
 * and `productId`, when given, must be one of its digital products. With one digital product the link leads
 * straight to it; with several (and no productId) it leads to a list of per-product links.
 */
export async function resolveDownload(accountId: string, orderId: string, productId: string | null): Promise<DownloadTarget | null> {
  if (productId !== null && !UUID.test(productId)) return null;
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [order] = await tx.$queryRaw<{ status: string; paid_at: Date | null; refund_state: string }[]>`
      SELECT status, paid_at, refund_state FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    if (!order || !order.paid_at || order.refund_state === 'full' || !(DOWNLOADABLE_STATUSES as readonly string[]).includes(order.status)) return null;
    const items = await orderDigitalItemsTx(tx, accountId, orderId);
    const chosen = productId ? items.find((i) => i.productId === productId.toLowerCase()) : items.length === 1 ? items[0] : null;
    if (productId && !chosen) return null;
    if (!chosen) return items.length ? { kind: 'list', items } : null;
    const [product] = await tx.$queryRaw<{ digital_url: string | null; media_id: string | null }[]>`
      SELECT digital_url, digital_media_id::text AS media_id FROM shop_products
      WHERE account_id=${accountId}::uuid AND id=${chosen.productId}::uuid AND is_digital`;
    if (product?.digital_url && /^https:\/\//.test(product.digital_url)) return { kind: 'url', url: product.digital_url };
    if (product?.media_id) return { kind: 'media', mediaId: product.media_id, name: chosen.name };
    return null;
  }, getWorkerPrisma());
}
