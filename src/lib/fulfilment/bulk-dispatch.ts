// Bulk dispatch from the orders list: "Create shipments" and "Print labels" for up to BULK_DISPATCH_MAX
// selected orders, one order at a time, each with its own result. Nothing new talks to a courier here:
// every order goes through the same single-order paths staff already use (requestShipment, labelUrl), so
// the same guards hold per order:
//   - commerce.shipments (admin ceiling), the plan, and the deployment switch;
//   - requestShipment inserts the shipment row and queues the create job in one transaction under the
//     order lock, and refuses an order whose lines are all in a live shipment ('shipment_exists'). The
//     courier call runs in the job, which reconciles an ambiguous create by our reference and never
//     repeats an ambiguous AWB assignment. Running the same selection again therefore never creates a
//     second shipment: the orders already handed over come back as shipment_exists.
//   - an unexpected failure is reported as 'unknown' and is never retried here: staff open the order
//     to see what happened before trying again.
// Logs carry ids and codes only.
import { requirePermission } from '@/lib/auth/permissions';
import { withTenant } from '@/lib/db/tenant';
import { getCourierProvider } from './providers';
import type { CourierProviderId } from './providers/types';
import { labelUrl, requestShipment } from './shipments';
import { ShipmentError, type FulfilmentActor, type ShipmentErrorCode } from './types';

export const BULK_DISPATCH_MAX = 25;

export type BulkCode = ShipmentErrorCode | 'unknown';
export type BulkShipmentResult = { order_id: string; ok: true; shipment_id: string } | { order_id: string; ok: false; code: BulkCode };
export type BulkLabelResult = { order_id: string; ok: true; url: string } | { order_id: string; ok: false; code: BulkCode };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 1 to BULK_DISPATCH_MAX distinct order ids (lower-cased), else null. */
export function parseBulkOrderIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > BULK_DISPATCH_MAX) return null;
  if (!value.every((v) => typeof v === 'string' && UUID.test(v))) return null;
  return [...new Set((value as string[]).map((v) => v.toLowerCase()))];
}

/** The workspace's default parcel (the courier requestShipment will pick: Shiprocket first, then the first connected). */
async function defaultParcel(ctx: FulfilmentActor): Promise<{
  provider: CourierProviderId; length_cm: number; breadth_cm: number; height_cm: number; weight_grams: number | null;
} | null> {
  const rows = await withTenant(ctx, (tx) => tx.$queryRaw<Array<{
    provider: CourierProviderId; length_cm: unknown; breadth_cm: unknown; height_cm: unknown; weight_grams: number | null;
  }>>`SELECT provider, default_length_cm AS length_cm, default_breadth_cm AS breadth_cm, default_height_cm AS height_cm,
      default_weight_grams AS weight_grams
    FROM courier_connections WHERE account_id=${ctx.accountId}::uuid AND status='active'
    ORDER BY (provider='shiprocket') DESC, connected_at`);
  const row = rows.find((r) => !getCourierProvider(r.provider).disabled());
  if (!row) return null;
  const n = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));
  const dims = { length_cm: n(row.length_cm), breadth_cm: n(row.breadth_cm), height_cm: n(row.height_cm) };
  if (!Object.values(dims).every((v) => Number.isFinite(v) && v > 0)) return null;
  return { provider: row.provider, ...dims, weight_grams: row.weight_grams };
}

const codeOf = (error: unknown): BulkCode => (error instanceof ShipmentError ? error.code : 'unknown');

/**
 * Create a courier shipment for each order with the workspace's default parcel size. The weight comes from
 * the catalogue (the order's items), else the default weight. Returns 'no_defaults', touching no order, when
 * no connected courier has a default parcel size (set in the courier settings).
 */
export async function bulkCreateShipments(ctx: FulfilmentActor, orderIds: string[]): Promise<BulkShipmentResult[] | 'no_defaults'> {
  await requirePermission(ctx, 'commerce.shipments');
  const parcel = await defaultParcel(ctx);
  if (!parcel) return 'no_defaults';
  const results: BulkShipmentResult[] = [];
  for (const orderId of orderIds) {
    const dims = { length_cm: parcel.length_cm, breadth_cm: parcel.breadth_cm, height_cm: parcel.height_cm };
    try {
      let created: { shipmentId: string };
      try {
        created = await requestShipment(ctx, orderId, { ...dims, weight_grams: null }, parcel.provider);
      } catch (error) {
        // No catalogue weight for these items (refused before anything was written): use the default weight.
        if (!(error instanceof ShipmentError && error.code === 'invalid' && parcel.weight_grams)) throw error;
        created = await requestShipment(ctx, orderId, { ...dims, weight_grams: parcel.weight_grams }, parcel.provider);
      }
      results.push({ order_id: orderId, ok: true, shipment_id: created.shipmentId });
    } catch (error) {
      if (!(error instanceof ShipmentError)) console.error('[bulk-dispatch] create failed', { orderId, name: (error as Error)?.name });
      results.push({ order_id: orderId, ok: false, code: codeOf(error) });
    }
  }
  return results;
}

/** A short-lived label URL for each order's newest live shipment (only once its AWB is assigned). */
export async function bulkLabelUrls(ctx: FulfilmentActor, orderIds: string[]): Promise<BulkLabelResult[]> {
  await requirePermission(ctx, 'commerce.shipments');
  const results: BulkLabelResult[] = [];
  for (const orderId of orderIds) {
    try {
      results.push({ order_id: orderId, ok: true, url: await labelUrl(ctx, orderId) });
    } catch (error) {
      if (!(error instanceof ShipmentError)) console.error('[bulk-dispatch] label failed', { orderId, name: (error as Error)?.name });
      results.push({ order_id: orderId, ok: false, code: codeOf(error) });
    }
  }
  return results;
}
