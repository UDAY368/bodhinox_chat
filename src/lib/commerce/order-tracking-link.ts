/** The buyer's tracking path for an order (store plan Phase 5); kept apart so storefront.ts can use it without an import cycle. */
import type { TenantTransaction } from '@/lib/db/tenant';
import { orderTrackingPath, orderTrackingToken } from './order-tracking-token';

/** '/s/<handle>/track/<token>', or null when the workspace has no published shop. */
export async function orderTrackingPathTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<string | null> {
  const row = await tx.shop_storefronts.findFirst({ where: { account_id: accountId, published: true }, select: { handle: true } });
  return row ? orderTrackingPath(row.handle, orderTrackingToken(accountId, orderId)) : null;
}
