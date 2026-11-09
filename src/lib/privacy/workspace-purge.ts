// Closed-workspace purge (audit finding 39, runbook docs/runbooks/data-requests.md).
//
// A workspace whose owner requested deletion is 'closing' until purge_after (30 days,
// src/lib/account/deletion.ts). Once a day per due workspace (crm_accounts_due_for_purge)
// the worker queues one job:
//
// workspace.purge (tenant job): WORKSPACE_PURGE_ENABLED is OFF by default. While off the
//   job is a dry run: it re-checks the workspace (crm_workspace_purge_check) and logs the
//   row counts the purge would delete, nothing else. When 'true', one worker transaction
//   under withTenant re-checks it (still closing, past purge_after, no live provider
//   subscription; rows locked so a concurrent cancel waits), copies its Bodhinox tax
//   invoices to purged_invoices, writes the workspace_purges audit row (ids, dates and
//   counts only) and deletes the accounts row, which cascades to every tenant table
//   (audit_logs and billing records are kept with account_id cleared). Its stored files
//   are then removed.
//
// workspace.purge_storage (global job, the workspace row is gone): removes the stored
//   files of a purged workspace still marked uncleared, for up to 30 days.
//
// Logs carry the workspace id, a reason code and counts, never customer content.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { istDay } from '@/lib/ai/retention';
import { deleteWorkspaceObjects, storageConfigured } from '@/lib/storage/server';

export const WORKSPACE_PURGE_JOB = 'workspace.purge';
export const WORKSPACE_PURGE_STORAGE_JOB = 'workspace.purge_storage';
/** One purge transaction may cascade through a large workspace. */
export const PURGE_TRANSACTION_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCHEDULE_INTERVAL_MS = 60 * 60_000;
let lastSchedule = Number.NEGATIVE_INFINITY;
let lastScheduledDay: string | null = null;

/** Off unless explicitly 'true': the purge cannot be undone. */
export function workspacePurgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WORKSPACE_PURGE_ENABLED === 'true';
}

/** Queues at most one purge (or storage clean-up) job per due workspace per IST day. */
export async function scheduleWorkspacePurges(now: number = Date.now(), force = false): Promise<number> {
  if (!force && (lastScheduledDay === istDay(now) || now - lastSchedule < SCHEDULE_INTERVAL_MS)) return 0;
  lastSchedule = now;
  const due = await getWorkerPrisma().$queryRaw<{ account_id: string; purged: boolean }[]>`
    SELECT account_id::text AS account_id, purged FROM crm_accounts_due_for_purge()`;
  let queued = 0;
  for (const { account_id, purged } of due) {
    if (!UUID.test(account_id)) continue;
    const day = istDay(now);
    queued += purged
      // The workspace row is gone, so the job has no tenant (jobs.tenant_id references accounts).
      ? await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,payload,dedupe_key,max_attempts)
          VALUES(${WORKSPACE_PURGE_STORAGE_JOB},${JSON.stringify({ accountId: account_id })}::jsonb,${`workspace-purge-storage:${account_id}:${day}`},3)
          ON CONFLICT(dedupe_key) DO NOTHING`
      : await getWorkerPrisma().$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,max_attempts)
          VALUES(${WORKSPACE_PURGE_JOB},${account_id}::uuid,'{}'::jsonb,${`workspace-purge:${account_id}:${day}`},2)
          ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  lastScheduledDay = istDay(now);
  return queued;
}

/** Test hook. */
export function resetWorkspacePurgeScheduleForTests(): void {
  lastSchedule = Number.NEGATIVE_INFINITY;
  lastScheduledDay = null;
}

export type PurgeCounts = Record<string, number>;

/** Row counts of the main tenant tables (fixed identifiers, RLS-scoped to the workspace). */
async function countWorkspace(tx: TenantTransaction, accountId: string): Promise<PurgeCounts> {
  const [row] = await tx.$queryRaw<Record<string, bigint | number>[]>`SELECT
    (SELECT count(*) FROM contacts WHERE account_id=${accountId}::uuid) AS contacts,
    (SELECT count(*) FROM conversations WHERE account_id=${accountId}::uuid) AS conversations,
    (SELECT count(*) FROM messages WHERE account_id=${accountId}::uuid) AS messages,
    (SELECT count(*) FROM media_objects WHERE account_id=${accountId}::uuid) AS media_objects,
    (SELECT count(*) FROM broadcasts WHERE account_id=${accountId}::uuid) AS broadcasts,
    (SELECT count(*) FROM flows WHERE account_id=${accountId}::uuid) AS flows,
    (SELECT count(*) FROM orders WHERE account_id=${accountId}::uuid) AS orders,
    (SELECT count(*) FROM invoices WHERE account_id=${accountId}::uuid) AS invoices`;
  return Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, Number(v)]));
}

export type PurgeOutcome =
  | { state: 'dry_run'; reason: string | null; counts: PurgeCounts }
  | { state: 'skipped'; reason: string }
  | { state: 'purged'; counts: PurgeCounts; invoicesRetained: number; storageCleared: boolean };

/** The workspace.purge job. A refused re-check (cancelled, not due, live subscription) is a no-op. */
export async function runWorkspacePurge(accountId: string, env: Record<string, string | undefined> = process.env): Promise<PurgeOutcome> {
  if (!UUID.test(accountId)) throw new Error('Invalid workspace purge job');
  const scope = { accountId, role: 'owner' as const };
  if (!workspacePurgeEnabled(env)) {
    const result = await withTenant(scope, async (tx) => {
      // Count first: the check locks the workspace row until commit, so it comes last.
      const counts = await countWorkspace(tx, accountId);
      const [check] = await tx.$queryRaw<{ reason: string | null }[]>`SELECT crm_workspace_purge_check(${accountId}::uuid) AS reason`;
      return { reason: check?.reason ?? null, counts };
    }, getWorkerPrisma());
    console.info('[workspace-purge] dry run (WORKSPACE_PURGE_ENABLED is off)', accountId, result.reason ?? 'due', JSON.stringify(result.counts));
    return { state: 'dry_run', ...result };
  }
  const outcome = await withTenant(scope, async (tx): Promise<{ reason: string } | { counts: PurgeCounts; invoicesRetained: number }> => {
    const [check] = await tx.$queryRaw<{ reason: string | null }[]>`SELECT crm_workspace_purge_check(${accountId}::uuid) AS reason`;
    const refused = check?.reason;
    if (refused) return { reason: refused };
    const counts = await countWorkspace(tx, accountId);
    const invoicesRetained = await tx.$executeRaw`INSERT INTO purged_invoices(invoice_id,account_id,number,issued_at,invoice)
      SELECT i.id, i.account_id, i.number, i.issued_at, to_jsonb(i) FROM invoices i WHERE i.account_id=${accountId}::uuid
      ON CONFLICT (invoice_id) DO NOTHING`;
    // Re-checks under the same locks, writes the audit row and deletes the workspace (cascade).
    const [finish] = await tx.$queryRaw<{ reason: string | null }[]>`
      SELECT crm_workspace_purge_finish(${accountId}::uuid, ${JSON.stringify(counts)}::jsonb, ${invoicesRetained}::int) AS reason`;
    if (finish?.reason) throw new Error(`Workspace purge refused: ${finish.reason}`);
    return { counts, invoicesRetained };
  }, getWorkerPrisma(), { timeoutMs: PURGE_TRANSACTION_MS });
  if ('reason' in outcome) {
    console.info('[workspace-purge] skipped', accountId, outcome.reason);
    return { state: 'skipped', reason: outcome.reason };
  }
  console.info('[workspace-purge] purged', accountId, JSON.stringify(outcome.counts));
  // The rows are gone; a storage failure here is retried by workspace.purge_storage.
  const storageCleared = await clearPurgedWorkspaceStorage(accountId).catch(() => {
    console.error('[workspace-purge] storage clean-up failed; retried daily', accountId);
    return false;
  });
  return { state: 'purged', ...outcome, storageCleared };
}

/**
 * Removes a purged workspace's stored files and records storage_cleared_at once its
 * prefix is empty. Refuses a workspace that has no purge record (never deletes the
 * files of a live workspace). Returns whether storage is now clear.
 */
export async function clearPurgedWorkspaceStorage(accountId: string): Promise<boolean> {
  if (!UUID.test(accountId)) throw new Error('Invalid workspace purge job');
  const db = getWorkerPrisma();
  const purged = await db.$queryRaw<{ cleared: boolean }[]>`
    SELECT storage_cleared_at IS NOT NULL AS cleared FROM workspace_purges WHERE account_id=${accountId}::uuid`;
  if (!purged[0]) throw new Error('Workspace has no purge record');
  if (purged[0].cleared) return true;
  if (!storageConfigured()) {
    console.warn('[workspace-purge] storage not configured; files not removed', accountId);
    return false;
  }
  const { done } = await deleteWorkspaceObjects(accountId);
  if (!done) return false;
  await db.$executeRaw`UPDATE workspace_purges SET storage_cleared_at=now()
    WHERE account_id=${accountId}::uuid AND storage_cleared_at IS NULL`;
  return true;
}

/** The workspace.purge_storage job (payload { accountId }). */
export async function runWorkspacePurgeStorage(payload: Record<string, unknown>): Promise<void> {
  const accountId = payload.accountId;
  if (typeof accountId !== 'string' || !UUID.test(accountId)) throw new Error('Invalid workspace purge storage job');
  await clearPurgedWorkspaceStorage(accountId);
}
