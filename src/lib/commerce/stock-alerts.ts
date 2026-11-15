/**
 * Store plan Phase 3, package 3: the pure rules and the queueing for back-in-stock
 * alerts. No provider calls and no heavy imports, so stock.ts can queue a restock
 * without a cycle (the public route is in public-shop.ts, the inbound claim and the
 * job are in stock-alert-jobs.ts).
 *
 * Consent-safe flow, like "Order on WhatsApp": the buyer messages first. The shop page
 * saves a code for a sold-out variant; the buyer sends "NOTIFY <CODE>" to the shop's
 * number, which claims it. Only claimed alerts are ever messaged.
 */
import type { TenantTransaction } from '@/lib/db/tenant';

export const BACK_IN_STOCK_JOB = 'commerce.back_in_stock';
/** An unclaimed code lives 48 hours; a claimed alert waits 90 days for the restock. */
export const STOCK_ALERT_CODE_HOURS = 48;
export const STOCK_ALERT_CLAIM_DAYS = 90;
/** Alerts one job run messages; the rest are queued as the next run. */
export const BACK_IN_STOCK_BATCH = 200;

/** The code in an inbound "... NOTIFY <CODE>" text (the code ends the message), or null. */
export function parseStockAlertMessage(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length > 2000) return null;
  const match = /(?:^|\s)NOTIFY ([A-HJ-NP-Z2-9]{6})$/.exec(text.trim().toUpperCase().replace(/[ \t]+/g, ' '));
  return match ? match[1] : null;
}

/** The message the buyer sends: what they wait for, then the code. */
export function stockAlertMessage(intro: string, code: string): string {
  return `${intro.slice(0, 1800)} NOTIFY ${code}`;
}

/**
 * Queue the notifications for a variant whose available stock went from nothing to
 * something, when anyone waits for it. Same transaction as the stock change; the
 * dedupe key names the movement, so a repeat is a no-op.
 */
export async function queueBackInStockTx(tx: TenantTransaction, accountId: string, variantId: string, source: string): Promise<boolean> {
  const [waiting] = await tx.$queryRaw<{ n: number }[]>`
    SELECT 1 AS n FROM shop_stock_alerts WHERE account_id=${accountId}::uuid AND variant_id=${variantId}::uuid
      AND claimed_at IS NOT NULL AND closed_at IS NULL LIMIT 1`;
  if (!waiting) return false;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES(${BACK_IN_STOCK_JOB},${accountId}::uuid,${JSON.stringify({ variantId })}::jsonb,${`bis:${variantId}:${source}`})
    ON CONFLICT(dedupe_key) DO NOTHING`;
  return true;
}
