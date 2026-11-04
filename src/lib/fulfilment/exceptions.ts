// Shipment exceptions (Phase 9, design §2 and D11 "Accept correction"). Owner: T5.
//
// The worker opens them (tracking contradictions, return to origin, lost or
// damaged parcels, a courier claim the order disagrees with; T4 opens the
// ambiguous-create, ambiguous-AWB and stale-tracking ones). Admins with
// commerce.shipments resolve them:
//   - accept_correction (contradiction only): the shipment takes the observed
//     status; the order's status never changes (no backward edge), the admin
//     uses Returns; an order event and an audit row record it;
//   - recreate (ambiguous create or AWB, or a lost parcel): the shipment is marked failed
//     so a new one can be requested (the admin checked Shiprocket first);
//   - dismiss / manual: handled outside the app.
// Lock order: order → shipment → exception (D16). Ids and codes only in audit.
import { ForbiddenError } from '@/lib/auth/errors';
import { requirePermission } from '@/lib/auth/permissions';
import { hasMinRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { auditTx, orderEventTx } from '@/lib/payments/ledger';
import { isTrackingStatus, resolutionsFor, TRACKING_RANK } from './status-map';
import {
  SHIPMENT_EXCEPTION_RESOLUTIONS, ShipmentError, type FulfilmentActor, type ShipmentExceptionKind,
  type ShipmentExceptionResolution, type TrackingStatus,
} from './types';

export interface ShipmentExceptionView {
  id: string;
  shipment_id: string;
  order_id: string;
  kind: ShipmentExceptionKind;
  observed_status: TrackingStatus | null;
  status: 'open' | 'resolved';
  resolution: ShipmentExceptionResolution | null;
  created_at: string;
  resolved_at: string | null;
  /** The shipment's AWB and our reference (no customer data). */
  awb: string | null;
  reference: string;
  tracking_status: TrackingStatus | null;
}

export { isTrackingStatus, resolutionsFor };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Opens an exception once (ON CONFLICT DO NOTHING on the open partial unique,
 * keyed by kind and observed status, so a second contradiction with another
 * observed status opens its own row while the first is still open);
 * worker transaction. `once`: also skip when one of this kind and observed
 * status was already resolved for the shipment, so a re-fetch never reopens
 * what an admin closed (tracking-job uses it; a recurring condition such as
 * stale tracking omits it).
 */
export async function openShipmentException(
  tx: TenantTransaction, accountId: string, shipmentId: string, kind: ShipmentExceptionKind, observed?: TrackingStatus | null,
  options: { once?: boolean } = {},
): Promise<void> {
  const status = observed ?? null;
  if (options.once) {
    const [seen] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shipment_exceptions
      WHERE account_id=${accountId}::uuid AND shipment_id=${shipmentId}::uuid AND kind=${kind}
        AND observed_status IS NOT DISTINCT FROM ${status}::text`;
    if ((seen?.n ?? 0) > 0) return;
  }
  await tx.$executeRaw`INSERT INTO shipment_exceptions(account_id, shipment_id, kind, observed_status)
    VALUES(${accountId}::uuid, ${shipmentId}::uuid, ${kind}, ${status})
    ON CONFLICT (account_id, shipment_id, kind, (COALESCE(observed_status, ''))) WHERE status = 'open' DO NOTHING`;
}

interface ExceptionRow {
  id: string; shipment_id: string; order_id: string; kind: ShipmentExceptionKind; observed_status: string | null;
  status: 'open' | 'resolved'; resolution: ShipmentExceptionResolution | null; created_at: Date; resolved_at: Date | null;
  awb: string | null; reference: string; tracking_status: string | null;
}

function view(row: ExceptionRow): ShipmentExceptionView {
  return {
    id: row.id, shipment_id: row.shipment_id, order_id: row.order_id, kind: row.kind,
    observed_status: isTrackingStatus(row.observed_status) ? row.observed_status : null,
    status: row.status, resolution: row.resolution, created_at: row.created_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null, awb: row.awb, reference: row.reference,
    tracking_status: isTrackingStatus(row.tracking_status) ? row.tracking_status : null,
  };
}

/** Newest first; open by default. The caller's session (app role; agents and above by RLS, admin by the route). */
export async function listShipmentExceptions(
  tx: TenantTransaction, accountId: string, filter: { status?: 'open' | 'resolved'; limit?: number } = {},
): Promise<ShipmentExceptionView[]> {
  const status = filter.status ?? 'open';
  const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 200);
  const rows = await tx.$queryRaw<ExceptionRow[]>`
    SELECT e.id::text AS id, e.shipment_id::text AS shipment_id, s.order_id::text AS order_id, e.kind, e.observed_status,
      e.status, e.resolution, e.created_at, e.resolved_at, s.awb, s.reference, s.tracking_status
    FROM shipment_exceptions e
    JOIN order_shipments s ON s.account_id=e.account_id AND s.id=e.shipment_id
    WHERE e.account_id=${accountId}::uuid AND e.status=${status}
    ORDER BY e.created_at DESC, e.id LIMIT ${limit}`;
  return rows.map(view);
}

/** Admin resolution; accept_correction moves the shipment to the observed status (order status unchanged), with an event and an audit row. */
export async function resolveShipmentException(
  ctx: FulfilmentActor, exceptionId: string, resolution: ShipmentExceptionResolution,
): Promise<ShipmentExceptionView> {
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
  await requirePermission(ctx, 'commerce.shipments');
  if (!(SHIPMENT_EXCEPTION_RESOLUTIONS as readonly string[]).includes(resolution)) throw new ShipmentError('invalid');
  if (!UUID.test(exceptionId)) throw new ShipmentError('not_found');
  return withTenant({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, async (tx) => {
    const [found] = await tx.$queryRaw<{ shipment_id: string; order_id: string }[]>`
      SELECT e.shipment_id::text AS shipment_id, s.order_id::text AS order_id FROM shipment_exceptions e
      JOIN order_shipments s ON s.account_id=e.account_id AND s.id=e.shipment_id
      WHERE e.account_id=${ctx.accountId}::uuid AND e.id=${exceptionId}::uuid`;
    if (!found) throw new ShipmentError('not_found');
    await tx.$queryRaw`SELECT id FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${found.order_id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM order_shipments WHERE account_id=${ctx.accountId}::uuid AND id=${found.shipment_id}::uuid FOR UPDATE`;
    const [row] = await tx.$queryRaw<{ kind: ShipmentExceptionKind; observed_status: string | null; status: string }[]>`
      SELECT kind, observed_status, status FROM shipment_exceptions
      WHERE account_id=${ctx.accountId}::uuid AND id=${exceptionId}::uuid FOR UPDATE`;
    if (!row) throw new ShipmentError('not_found');
    if (row.status !== 'open') throw new ShipmentError('conflict');
    if (!resolutionsFor(row.kind).includes(resolution)) throw new ShipmentError('invalid');

    if (resolution === 'accept_correction') {
      if (!isTrackingStatus(row.observed_status)) throw new ShipmentError('invalid');
      await tx.$executeRaw`UPDATE order_shipments SET tracking_status=${row.observed_status},
          tracking_rank=${TRACKING_RANK[row.observed_status]}
        WHERE account_id=${ctx.accountId}::uuid AND id=${found.shipment_id}::uuid`;
      await orderEventTx(tx, ctx.accountId, found.order_id, 'shipment_correction_accepted', {
        actorUserId: ctx.userId, detail: row.observed_status,
      });
    } else if (resolution === 'recreate') {
      // Frees the one-live-shipment slot; the AWB (if any) stays as evidence. The
      // admin confirmed in Shiprocket that nothing was created or charged.
      await tx.$executeRaw`UPDATE order_shipments SET create_state='failed', claim_token=NULL, claimed_until=NULL,
          last_error_code='recreate_allowed'
        WHERE account_id=${ctx.accountId}::uuid AND id=${found.shipment_id}::uuid`;
    }
    await tx.$executeRaw`UPDATE shipment_exceptions SET status='resolved', resolution=${resolution},
        resolved_by=${ctx.userId}::uuid, resolved_at=now()
      WHERE account_id=${ctx.accountId}::uuid AND id=${exceptionId}::uuid`;
    await auditTx(tx, ctx.accountId, ctx.userId, 'shipment.exception_resolved', exceptionId, {
      shipment_id: found.shipment_id, order_id: found.order_id, kind: row.kind, resolution,
      observed_status: isTrackingStatus(row.observed_status) ? row.observed_status : null,
    });
    const [updated] = await tx.$queryRaw<ExceptionRow[]>`
      SELECT e.id::text AS id, e.shipment_id::text AS shipment_id, s.order_id::text AS order_id, e.kind, e.observed_status,
        e.status, e.resolution, e.created_at, e.resolved_at, s.awb, s.reference, s.tracking_status
      FROM shipment_exceptions e JOIN order_shipments s ON s.account_id=e.account_id AND s.id=e.shipment_id
      WHERE e.account_id=${ctx.accountId}::uuid AND e.id=${exceptionId}::uuid`;
    return view(updated);
  }, getWorkerPrisma());
}
