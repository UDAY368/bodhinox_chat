// appointments.meeting_sync job inserts shared by sync.ts and connection.ts
// (Phase 9). Kept apart so the connection callback can queue a backfill
// without importing sync.ts (which imports connection.ts).
import { getEntitlements } from '@/lib/billing/entitlements';
import type { TenantTransaction } from '@/lib/db/tenant';
import { zoomConfig } from './config';
import { MEETING_SYNC_JOB, type MeetingSyncPayload } from './types';

/** Appointments queued per backfill pass (the sweep runs again for the rest). */
export const MEETING_BACKFILL_BATCH = 50;

/**
 * Inserts one meeting sync job. With `requeue`, a finished job under the same
 * key runs again (a pending or running one is left alone).
 */
export async function insertMeetingSyncJob(tx: TenantTransaction, accountId: string, appointmentId: string, version: number,
  dedupeKey: string, requeue = false): Promise<boolean> {
  const payload: MeetingSyncPayload = { appointmentId, version };
  const n = requeue
    ? await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
        VALUES(${MEETING_SYNC_JOB},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey},now())
        ON CONFLICT(dedupe_key) DO UPDATE SET status='pending', attempts=0, run_at=now(), payload=EXCLUDED.payload,
          lease_until=NULL, lease_token=NULL, last_error=NULL, updated_at=now()
        WHERE jobs.status IN ('done','failed') AND jobs.type=EXCLUDED.type AND jobs.tenant_id=EXCLUDED.tenant_id`
    : await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
        VALUES(${MEETING_SYNC_JOB},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey},now())
        ON CONFLICT(dedupe_key) DO NOTHING`;
  return n > 0;
}

/**
 * Queues a sync job for each confirmed, future, online appointment that has no
 * meeting row while the workspace's connection is active (bounded). Booking
 * queues nothing while the connection is token_invalid, so without this those
 * appointments would never get a meeting after a reconnect. Runs in the
 * caller's transaction; never calls Zoom.
 */
export async function backfillMeetingSyncTx(tx: TenantTransaction, accountId: string): Promise<number> {
  if (!zoomConfig()) return 0;
  const rows = await tx.$queryRaw<{ id: string; version: number }[]>`SELECT a.id::text AS id, a.version
    FROM appointments a
    JOIN appointment_services s ON s.account_id=a.account_id AND s.id=a.service_id AND s.mode='online'
    WHERE a.account_id=${accountId}::uuid AND a.status='confirmed' AND a.start_at > now()
      AND EXISTS (SELECT 1 FROM meeting_connections c WHERE c.account_id=a.account_id AND c.status='active')
      AND NOT EXISTS (SELECT 1 FROM appointment_meetings m WHERE m.account_id=a.account_id AND m.appointment_id=a.id)
    ORDER BY a.start_at LIMIT ${MEETING_BACKFILL_BATCH}`;
  if (!rows.length || !(await getEntitlements(tx, accountId)).features.online_meetings) return 0;
  let queued = 0;
  for (const r of rows)
    if (await insertMeetingSyncJob(tx, accountId, r.id, r.version, `appt-mtg:${r.id}:backfill`, true)) queued++;
  return queued;
}
