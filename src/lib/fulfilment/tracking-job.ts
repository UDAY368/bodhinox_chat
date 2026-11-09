// Tracking re-fetch job and order effects (Phase 9, design §2 handleShipmentTrackJob, D3, D10, D11, D16). Owner: T5.
//
// A push is a hint only: the job re-fetches tracking with the workspace's own
// token and only re-fetched data changes state. Then, in one worker
// transaction (no app.user_id, so the order history records `system`): lock
// the order, then the shipment (D16); store the new scans (normalised status
// and provider code only); fold the whole stored history (deriveTracking, so
// arrival order never matters); write the shipment; open exceptions once; and
// apply the order effects (systemDispatch / systemDeliver), whose notices are
// deduplicated per order and kind (D10).
//
// No external call unless the deployment allows Shiprocket (SHIPROCKET_DISABLED
// unset) and the workspace has an active connection.
//
// ASSUMPTION (Shiprocket docs, not confirmed for every account type): GET
// /courier/track/awb/{awb} answers { tracking_data: { shipment_status,
// shipment_track: [{ current_status, delivered_date }], shipment_track_activities:
// [{ date, status, "sr-status", "sr-status-label" }] } }, sometimes keyed by the
// AWB ({ "<awb>": { tracking_data } }, or inside an array). All three are read;
// anything else yields no events (nothing changes).
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { lockOrder, systemDeliver, systemDispatch } from '@/lib/commerce/order-lifecycle';
import { orderEventTx } from '@/lib/payments/ledger';
import { deriveTracking, type TrackingEvent } from './derive-tracking';
import { openShipmentException, isTrackingStatus } from './exceptions';
import { shiprocketCall, shiprocketDisabled, ShiprocketError } from './shiprocket-client';
import { normalizeShiprocket, parseShiprocketTime } from './status-map';
import { SHIPMENT_TRACK_JOB, ShipmentError, type ShipmentJobPayload, type TrackingEventSource, type TrackingStatus } from './types';

/** Re-fetches are coalesced: pushes within this window share one job run. */
export const TRACK_COALESCE_MS = 30_000;
const MAX_SCANS = 500;
const AWB = /^[A-Za-z0-9-]{4,40}$/;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function trackingData(body: unknown, awb: string): Json | null {
  if (Array.isArray(body)) {
    for (const item of body.slice(0, 5)) {
      const found = trackingData(item, awb);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(body)) return null;
  if (isObject(body.tracking_data)) return body.tracking_data;
  const keyed = body[awb];
  if (isObject(keyed) && isObject(keyed.tracking_data)) return keyed.tracking_data;
  return null;
}

function providerCode(code: unknown, label: unknown): string | null {
  if (typeof code === 'number' && Number.isSafeInteger(code)) return String(code);
  if (typeof code === 'string' && /^\d{1,4}$/.test(code.trim())) return code.trim();
  if (typeof label === 'string') {
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (slug) return `label_${slug}`.slice(0, 40);
  }
  return null;
}

function scan(code: unknown, label: unknown, at: unknown): TrackingEvent | null {
  const status = normalizeShiprocket(typeof code === 'number' || typeof code === 'string' ? code : null, typeof label === 'string' ? label : null);
  if (status === 'unrecognised') return null;
  const eventAt = parseShiprocketTime(typeof at === 'string' ? at : null);
  const pc = providerCode(code, label);
  return eventAt && pc ? { status, providerCode: pc, eventAt } : null;
}

/**
 * The normalised scans in a Shiprocket tracking response (status, provider
 * code, time only: no location, activity text or customer field survives).
 * Unmapped ("NA") and undated scans are dropped.
 */
export function parseTrackingResponse(body: unknown, awb: string): TrackingEvent[] {
  const data = trackingData(body, awb);
  if (!data) return [];
  const events: TrackingEvent[] = [];
  const activities = Array.isArray(data.shipment_track_activities) ? data.shipment_track_activities.slice(0, MAX_SCANS) : [];
  for (const a of activities) {
    if (!isObject(a)) continue;
    const event = scan(a['sr-status'], a['sr-status-label'] ?? a.status, a.date);
    if (event) events.push(event);
  }
  // The delivery itself, when Shiprocket reports it with a date but no scan for it yet.
  const track = Array.isArray(data.shipment_track) && isObject(data.shipment_track[0]) ? data.shipment_track[0] : null;
  if (track && typeof track.delivered_date === 'string') {
    const event = scan(data.shipment_status, track.current_status, track.delivered_date);
    if (event?.status === 'delivered') events.push(event);
  }
  return events;
}

/** A tracking push minimised to {awb, code, ts} (the route's receipt payload): no names, phones, addresses or scan locations. */
export function minimiseShiprocketPush(body: unknown): { awb: string; code: string | null; ts: string | null } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const awb = typeof b.awb === 'string' || typeof b.awb === 'number' ? String(b.awb).trim() : '';
  if (!AWB.test(awb)) return null;
  const rawCode = b.shipment_status_id ?? b.current_status_id;
  const code = (typeof rawCode === 'number' || typeof rawCode === 'string') && /^\d{1,4}$/.test(String(rawCode).trim())
    ? String(rawCode).trim() : null;
  const ts = typeof b.current_timestamp === 'string' && b.current_timestamp.length <= 40 && /^[0-9 :/T-]+$/.test(b.current_timestamp)
    ? b.current_timestamp : null;
  return { awb, code, ts };
}

/**
 * One coalesced track job per shipment (dedupe shptrk:<shipmentId>) in the
 * caller's transaction; re-arms a done or failed job with run_at = now()+30s.
 * A pending job is left as it is (it will read the newest data when it runs).
 * A running job may already have read older data, so the push queues one
 * follow-up (shptrk:<shipmentId>:next, same re-arm rule) instead of being lost.
 * Worker transaction (the app role may not update jobs).
 */
export async function enqueueShipmentTrack(tx: TenantTransaction, accountId: string, shipmentId: string): Promise<void> {
  const runAt = new Date(Date.now() + TRACK_COALESCE_MS);
  const payload = JSON.stringify({ shipmentId });
  const arm = (key: string) => tx.$executeRaw`INSERT INTO jobs(type, tenant_id, payload, dedupe_key, run_at, max_attempts)
    VALUES(${SHIPMENT_TRACK_JOB}, ${accountId}::uuid, ${payload}::jsonb, ${key}, ${runAt}, 5)
    ON CONFLICT (dedupe_key) DO UPDATE SET status='pending', attempts=0, run_at=EXCLUDED.run_at, payload=EXCLUDED.payload,
      lease_until=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
    WHERE jobs.type=EXCLUDED.type AND jobs.tenant_id IS NOT DISTINCT FROM EXCLUDED.tenant_id AND jobs.status IN ('done','failed')`;
  const key = `shptrk:${shipmentId}`;
  if ((await arm(key)) > 0) return;
  const [current] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM jobs
    WHERE dedupe_key=${key} AND type=${SHIPMENT_TRACK_JOB} AND tenant_id=${accountId}::uuid`;
  if (current?.status === 'running') await arm(`${key}:next`);
}

export interface TrackTarget { id: string; order_id: string; awb: string }

async function loadTarget(accountId: string, shipmentId: string): Promise<TrackTarget | null> {
  return withTenant({ accountId }, async (tx) => {
    const [row] = await tx.$queryRaw<{ id: string; order_id: string; awb: string | null; create_state: string; live: boolean }[]>`
      SELECT s.id::text AS id, s.order_id::text AS order_id, s.awb, s.create_state,
        EXISTS (SELECT 1 FROM courier_connections c WHERE c.account_id=s.account_id AND c.status='active') AS live
      FROM order_shipments s WHERE s.account_id=${accountId}::uuid AND s.id=${shipmentId}::uuid`;
    if (!row || !row.live || row.create_state !== 'created' || !row.awb || !AWB.test(row.awb)) return null;
    return { id: row.id, order_id: row.order_id, awb: row.awb };
  }, getWorkerPrisma());
}

/** commerce.shipment_track job. */
export async function handleShipmentTrackJob(accountId: string, payload: ShipmentJobPayload): Promise<void> {
  if (shiprocketDisabled()) return;
  const target = await loadTarget(accountId, payload.shipmentId);
  if (!target) return;
  let body: unknown;
  try {
    body = await shiprocketCall(accountId, 'GET', `/courier/track/awb/${encodeURIComponent(target.awb)}`);
  } catch (error) {
    // Not connected any more, or a definite refusal (unknown AWB, bad token): a
    // retry cannot help; the sweep polls again later. Ambiguous or throttled → retry.
    if (error instanceof ShipmentError && ['not_connected', 'not_configured', 'auth', 'feature_unavailable'].includes(error.code)) return;
    if (error instanceof ShiprocketError && (error.kind === 'rejected' || error.kind === 'auth')) return;
    throw error;
  }
  await applyTracking(accountId, target, parseTrackingResponse(body, target.awb), 'refetch');
}

/**
 * Stores the scans and applies their fold (exported for the poll sweep, which
 * passes source 'poll'). Every effect is idempotent: re-running with the same
 * or a reordered history changes nothing further.
 */
export async function applyTracking(
  accountId: string, target: TrackTarget, scans: readonly TrackingEvent[], source: TrackingEventSource,
): Promise<void> {
  await withTenant({ accountId }, async (tx) => {
    await lockOrder(tx, accountId, target.order_id);
    const [shipment] = await tx.$queryRaw<{ awb: string | null; create_state: string }[]>`
      SELECT awb, create_state FROM order_shipments
      WHERE account_id=${accountId}::uuid AND id=${target.id}::uuid FOR UPDATE`;
    if (!shipment || shipment.awb !== target.awb || shipment.create_state !== 'created') return;

    for (const e of scans) {
      await tx.$executeRaw`INSERT INTO shipment_tracking_events(account_id, shipment_id, status, provider_code, event_at, source)
        VALUES(${accountId}::uuid, ${target.id}::uuid, ${e.status}, ${e.providerCode}, ${e.eventAt}, ${source})
        ON CONFLICT (account_id, shipment_id, provider_code, event_at) DO NOTHING`;
    }
    const stored = await tx.$queryRaw<{ status: string; provider_code: string; event_at: Date }[]>`
      SELECT status, provider_code, event_at FROM shipment_tracking_events
      WHERE account_id=${accountId}::uuid AND shipment_id=${target.id}::uuid`;
    const accepted = await tx.$queryRaw<{ observed_status: string }[]>`
      SELECT DISTINCT observed_status FROM shipment_exceptions
      WHERE account_id=${accountId}::uuid AND shipment_id=${target.id}::uuid AND kind='contradiction'
        AND resolution='accept_correction' AND observed_status IS NOT NULL`;
    const history: TrackingEvent[] = stored.flatMap((r) => (isTrackingStatus(r.status)
      ? [{ status: r.status, providerCode: r.provider_code, eventAt: r.event_at }] : []));
    const derived = deriveTracking(history, {
      acceptedCorrections: new Set(accepted.map((r) => r.observed_status).filter(isTrackingStatus)),
    });
    if (derived.status === null) return;

    // Evidence times only ever move earlier (LEAST ignores NULL), so they are the
    // earliest confirmed scan whatever order the scans arrived in.
    await tx.$executeRaw`UPDATE order_shipments SET tracking_status=${derived.status}, tracking_rank=${derived.rank},
        tracking_event_at=${derived.eventAt},
        provider_dispatched_at=LEAST(provider_dispatched_at, ${derived.firstDispatchAt}::timestamptz),
        provider_delivered_at=LEAST(provider_delivered_at, ${derived.status === 'delivered' ? derived.deliveredAt : null}::timestamptz)
      WHERE account_id=${accountId}::uuid AND id=${target.id}::uuid`;

    for (const observed of derived.contradictions)
      await openShipmentException(tx, accountId, target.id, 'contradiction', observed, { once: true });
    if (derived.rto) await openShipmentException(tx, accountId, target.id, 'rto', null, { once: true });
    if (derived.lost) await openShipmentException(tx, accountId, target.id, 'lost_or_damaged', null, { once: true });
    // Collected after all (scheduled in Shiprocket, or a late pickup): a failed pickup request no longer needs anyone.
    if (derived.firstDispatchAt) {
      await tx.$executeRaw`UPDATE order_shipments SET last_error_code=NULL
        WHERE account_id=${accountId}::uuid AND id=${target.id}::uuid AND last_error_code='pickup_failed'`;
      await tx.$executeRaw`UPDATE shipment_exceptions SET status='resolved', resolution='dismiss', resolved_at=now()
        WHERE account_id=${accountId}::uuid AND shipment_id=${target.id}::uuid AND kind='pickup_failed' AND status='open'`;
    }

    let outcome: 'applied' | 'already' | 'conflict' | null = null;
    let claimed: TrackingStatus | null = null;
    if (derived.status === 'delivered') {
      outcome = await systemDeliver(tx, accountId, target.order_id);
      claimed = 'delivered';
    } else if (derived.firstDispatchAt) {
      outcome = await systemDispatch(tx, accountId, target.order_id);
      claimed = 'picked_up';
    }
    if (outcome === 'conflict') await openShipmentException(tx, accountId, target.id, 'order_conflict', claimed, { once: true });

    // Shiprocket cancelled the shipment. Before any dispatch evidence nothing left: free the order's one-live-shipment
    // slot (unless a staff cancel holds the claim; its own success path settles the row). After dispatch evidence a
    // parcel may be out, so staff look instead of the slot being freed silently.
    if (derived.status === 'cancelled') {
      if (derived.firstDispatchAt) {
        await openShipmentException(tx, accountId, target.id, 'order_conflict', 'cancelled', { once: true });
      } else {
        const released = await tx.$executeRaw`UPDATE order_shipments SET create_state='cancelled', claim_token=NULL, claimed_until=NULL
          WHERE account_id=${accountId}::uuid AND id=${target.id}::uuid AND create_state='created'
            AND (claim_token IS NULL OR claimed_until IS NULL OR claimed_until <= now())`;
        if (released === 1) await orderEventTx(tx, accountId, target.order_id, 'shipment_cancelled');
      }
    }
  }, getWorkerPrisma());
}
