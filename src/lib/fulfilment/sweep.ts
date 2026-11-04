// Fulfilment sweep (Phase 9, design §3 sweep.ts). Owner: T4.
//
// scheduleFulfilmentSweeps runs on every worker tick (handlers.ts scheduleWork)
// and acts at most once per 30 minutes per process. It queues one
// fulfilment.sweep job per workspace from crm_accounts_for_fulfilment_sweep()
// only (a live Zoom or Shiprocket connection plus open work), dedupe
// fsweep:<acct>:<slot>, so an unconnected workspace never gets a provider call.
// With Zoom unconfigured and Shiprocket switched off it queries nothing.
//
// runFulfilmentSweep: polls tracking for open shipments with no event for 3 h
// (batch 50, random order), opens stale_tracking after 10 days without one,
// reconciles ambiguous shipments (never re-creates, never re-assigns), opens
// create_unknown / awb_unknown for ambiguous rows of a replaced connection, resumes
// shipments that were never sent, then hands meetings and ageing Zoom tokens to
// the meetings module. One row's failure is logged (ids only) and left for the
// next sweep.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { zoomConfig } from '@/lib/meetings/config';
import { loadCourierSecrets } from './connection';
import { reconcileShipment, requeueUnsentShipment } from './shipments';
import { shiprocketDisabled } from './shiprocket-client';
import { TRACKING_RANK } from './status-map';
import { enqueueShipmentTrack } from './tracking-job';
import { FULFILMENT_SWEEP_JOB } from './types';

export const FULFILMENT_SWEEP_INTERVAL_MS = 30 * 60_000;
const BATCH = 50;
const POLL_AFTER_HOURS = 3;
const STALE_AFTER_DAYS = 10;
/**
 * A shipment row its create job has not claimed, this long after it was requested, is re-queued (the job was lost,
 * exhausted, or ran while Shiprocket was switched off). Re-queuing only re-arms a finished job, so a pending one is
 * left alone, and the job decides from the row what is left to do (no HTTP when nothing is).
 */
const UNSENT_AFTER_MINUTES = 10;

let lastSchedule = Number.NEGATIVE_INFINITY;
let missingFunctionLogged = false;

/** Queues one fulfilment.sweep job per listed workspace; returns how many. */
export async function scheduleFulfilmentSweeps(now: number = Date.now(), force = false): Promise<number> {
  if (!force && now - lastSchedule < FULFILMENT_SWEEP_INTERVAL_MS) return 0;
  lastSchedule = now;
  // Nothing can be called: no query either.
  if (shiprocketDisabled() && !zoomConfig()) return 0;
  let accounts: { account_id: string }[];
  try {
    accounts = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
      SELECT account_id::text AS account_id FROM crm_accounts_for_fulfilment_sweep()`;
  } catch (error) {
    if (/crm_accounts_for_fulfilment_sweep|42883/.test(error instanceof Error ? error.message : '')) {
      if (!missingFunctionLogged) console.error('[fulfilment] sweep function missing');
      missingFunctionLogged = true;
      return 0;
    }
    throw error;
  }
  const slot = Math.floor(now / FULFILMENT_SWEEP_INTERVAL_MS);
  for (const { account_id } of accounts) {
    await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
      VALUES(${FULFILMENT_SWEEP_JOB},${account_id}::uuid,'{}'::jsonb,${`fsweep:${account_id}:${slot}`},2)
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return accounts.length;
}

/** Test hook. */
export function resetFulfilmentScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
}

export interface FulfilmentSweepSummary {
  polled: number;
  stale: number;
  reconciled: number;
  requeued: number;
  failures: number;
}

async function sweepShipments(accountId: string, summary: FulfilmentSweepSummary): Promise<void> {
  const secrets = await loadCourierSecrets(accountId);
  if (!secrets || secrets.status !== 'active') return;
  const connectionId = secrets.connectionId;
  const work = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    // Open shipments with an AWB and no tracking news for 3 hours: one coalesced re-fetch each (T5's job).
    const poll = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM order_shipments
      WHERE account_id=${accountId}::uuid AND connection_id=${connectionId}::uuid AND create_state='created' AND awb IS NOT NULL
        AND COALESCE(tracking_rank, 0) < ${TRACKING_RANK.delivered}
        AND COALESCE(tracking_event_at, updated_at) < now() - (${POLL_AFTER_HOURS}::int * interval '1 hour')
      ORDER BY random() LIMIT ${BATCH}`;
    for (const { id } of poll) await enqueueShipmentTrack(tx, accountId, id);
    // Ten days without a scan: staff should look (one open stale_tracking exception per shipment, whatever its status).
    const stale = await tx.$queryRaw<{ id: string }[]>`INSERT INTO shipment_exceptions(account_id, shipment_id, kind, observed_status)
      SELECT s.account_id, s.id, 'stale_tracking', s.tracking_status FROM order_shipments s
      WHERE s.account_id=${accountId}::uuid AND s.create_state='created' AND s.awb IS NOT NULL
        AND COALESCE(s.tracking_rank, 0) < ${TRACKING_RANK.delivered}
        AND COALESCE(s.tracking_event_at, s.created_at) < now() - (${STALE_AFTER_DAYS}::int * interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM shipment_exceptions e WHERE e.account_id=s.account_id AND e.shipment_id=s.id
          AND e.kind='stale_tracking' AND e.status='open')
      ON CONFLICT (account_id, shipment_id, kind, (COALESCE(observed_status, ''))) WHERE status='open' DO NOTHING
      RETURNING shipment_id::text AS id`;
    // Ambiguous rows left on a connection that is no longer the live one (disconnected, then reconnected): they can
    // never be reconciled, so staff get the create_unknown / awb_unknown exception once. No provider call.
    await tx.$executeRaw`INSERT INTO shipment_exceptions(account_id, shipment_id, kind)
      SELECT s.account_id, s.id, CASE WHEN s.create_state IN ('unknown','creating') THEN 'create_unknown' ELSE 'awb_unknown' END
      FROM order_shipments s
      WHERE s.account_id=${accountId}::uuid AND s.connection_id<>${connectionId}::uuid AND (
          s.create_state='unknown'
          OR (s.create_state='creating' AND s.claim_token IS NOT NULL AND s.claimed_until <= now())
          OR (s.create_state='created' AND (s.awb_state='unknown'
            OR (s.awb_state='assigning' AND s.claim_token IS NOT NULL AND s.claimed_until <= now())))
        )
        AND NOT EXISTS (SELECT 1 FROM shipment_exceptions e WHERE e.account_id=s.account_id AND e.shipment_id=s.id
          AND e.kind=CASE WHEN s.create_state IN ('unknown','creating') THEN 'create_unknown' ELSE 'awb_unknown' END)
      ORDER BY s.created_at LIMIT ${BATCH}
      ON CONFLICT (account_id, shipment_id, kind, (COALESCE(observed_status, ''))) WHERE status='open' DO NOTHING`;
    // Ambiguous creates and AWB assignments whose claim has lapsed.
    const unclear = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM order_shipments
      WHERE account_id=${accountId}::uuid AND connection_id=${connectionId}::uuid AND (
        create_state='unknown' OR awb_state='unknown'
        OR ((create_state='creating' OR awb_state='assigning') AND claim_token IS NOT NULL AND claimed_until <= now())
      )
      ORDER BY random() LIMIT ${BATCH}`;
    // Rows whose create job never claimed them (no HTTP was ever made): resume, never reconcile.
    const unsent = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM order_shipments
      WHERE account_id=${accountId}::uuid AND connection_id=${connectionId}::uuid AND claim_token IS NULL
        AND ((create_state='creating') OR (create_state='created' AND awb_state='none'))
        AND created_at < now() - (${UNSENT_AFTER_MINUTES}::int * interval '1 minute')
      ORDER BY random() LIMIT ${BATCH}`;
    return { polled: poll.length, stale: stale.length, unclear, unsent };
  }, getWorkerPrisma());
  summary.polled += work.polled;
  summary.stale += work.stale;
  for (const { id } of work.unclear) {
    try {
      if ((await reconcileShipment(accountId, id, { openException: true })) === 'adopted') summary.reconciled += 1;
    } catch {
      summary.failures += 1;
    }
  }
  for (const { id } of work.unsent) {
    try {
      await requeueUnsentShipment(accountId, id);
      summary.requeued += 1;
    } catch {
      summary.failures += 1;
    }
  }
}

/** Polls stale tracking, opens stale_tracking exceptions, reconciles ambiguous shipments and meetings, refreshes ageing Zoom tokens. */
export async function runFulfilmentSweep(accountId: string): Promise<FulfilmentSweepSummary> {
  const summary: FulfilmentSweepSummary = { polled: 0, stale: 0, reconciled: 0, requeued: 0, failures: 0 };
  if (!shiprocketDisabled()) {
    try {
      await sweepShipments(accountId, summary);
    } catch (error) {
      summary.failures += 1;
      console.error('[fulfilment] shipment sweep failed', error instanceof Error ? error.name : 'unknown');
    }
  }
  if (zoomConfig()) {
    const meetings = await import('@/lib/meetings/sync');
    const connection = await import('@/lib/meetings/connection');
    try {
      const result = await meetings.sweepMeetings(accountId);
      summary.reconciled += result.reconciled;
      summary.requeued += result.requeued;
    } catch (error) {
      summary.failures += 1;
      console.error('[fulfilment] meeting sweep failed', error instanceof Error ? error.name : 'unknown');
    }
    try {
      await connection.refreshZoomTokenIfAgeing(accountId);
    } catch (error) {
      summary.failures += 1;
      console.error('[fulfilment] zoom token refresh failed', error instanceof Error ? error.name : 'unknown');
    }
  }
  if (summary.failures) console.error('[fulfilment] sweep left work for the next run', { failures: summary.failures });
  return summary;
}

