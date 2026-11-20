// The "needs review" list (standardisation batch 5, item 6): every send whose outcome is
// uncertain, in one place for admins.
//
// A send through dispatchOnce (src/lib/jobs/dispatch.ts) that timed out, lost its connection or
// got a 5xx leaves its outbound intent 'unknown'; one whose worker died mid-send stays
// 'dispatching'. Neither is ever re-sent automatically. Listed here:
//   - 'unknown' intents, and
//   - 'dispatching' intents untouched for 10 minutes whose job is not running on a live lease
//     (the same 10 minutes as crm_ops_stuck_dispatching, which the ops alert counts).
// Only keys dispatchOnce wrote (`<account>:<key>`) are listed; other writers of outbound_intents
// (the Meta catalogue sync) reconcile their own.
//
// An admin checks the chat (or WhatsApp Manager) and picks one:
//   - was_sent: the intent becomes 'accepted', so nothing sends it again, and the module's own
//     record is resolved through the module's function (order and appointment messages, store
//     event messages, campaign recipients).
//   - send_again: the uncertain intent is retired (its key gets a '#reviewed:<id>' suffix and it
//     becomes 'failed'), which frees the key, and the job that claimed it is queued once more
//     (a copy, unless that job is still pending or running); the job's next dispatchOnce claims
//     the key afresh and sends once. A send that ran outside a job has nothing to queue: the
//     intent is retired and staff send again from the chat. A campaign recipient goes back to
//     its campaign's "Retry failed", which re-claims a failed intent.
// The intent row is locked (FOR UPDATE) and re-checked, so a second click or a concurrent one
// finds it no longer open: one send at most. Every resolution writes an audit_logs row.
// Rows carry ids, a kind, a reason code, the contact's name and times; never message text.
import { Prisma } from '@prisma/client';

import { resolveMessage } from '@/lib/appointments/listing';
import { AppointmentError } from '@/lib/appointments/types';
import { reconcileBroadcastRecipients, ReconcileError } from '@/lib/broadcasts/reconcile';
import { AttentionError, resolveCommerceEventTx } from '@/lib/commerce/event-attention';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';

export const NEEDS_REVIEW_KINDS = ['order', 'appointment', 'store_event', 'flow', 'rule', 'campaign', 'scheduled_reply', 'other'] as const;
export type NeedsReviewKind = (typeof NEEDS_REVIEW_KINDS)[number];
export const NEEDS_REVIEW_ACTIONS = ['was_sent', 'send_again'] as const;
export type NeedsReviewAction = (typeof NEEDS_REVIEW_ACTIONS)[number];

export const NEEDS_REVIEW_PAGE_SIZE = 25;
export const NEEDS_REVIEW_PAGE_MAX = 50;
/** A 'dispatching' intent untouched this long is stuck (crm_ops_stuck_dispatching uses the same). */
export const STUCK_DISPATCHING_MINUTES = 10;

export const isNeedsReviewKind = (value: unknown): value is NeedsReviewKind =>
  typeof value === 'string' && (NEEDS_REVIEW_KINDS as readonly string[]).includes(value);
export const isNeedsReviewAction = (value: unknown): value is NeedsReviewAction =>
  typeof value === 'string' && (NEEDS_REVIEW_ACTIONS as readonly string[]).includes(value);

export interface NeedsReviewItem {
  id: string;
  kind: NeedsReviewKind;
  /** outcome_unknown: the provider's answer was lost; stuck_sending: the send never finished. */
  reason: 'outcome_unknown' | 'stuck_sending';
  contact: { id: string; name: string | null } | null;
  conversation_id: string | null;
  created_at: string;
  /** Whether "send again" can queue the job that owns it (false: staff send it from the chat). */
  can_send_again: boolean;
}

export interface NeedsReviewPage {
  items: NeedsReviewItem[];
  total: number;
  page: number;
  page_size: number;
}

export class NeedsReviewError extends Error {
  constructor(readonly code: 'not_found' | 'not_open', readonly status: 404 | 409) {
    super(code);
    this.name = 'NeedsReviewError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
// An account id is 36 characters; dispatchOnce keys are '<account>:<key>' (37 characters of prefix),
// so the key starts at character 38 (the SQL below uses these literals).
const STUCK_INTERVAL = Prisma.raw(`interval '${STUCK_DISPATCHING_MINUTES} minutes'`);

export interface ParsedReviewKey {
  kind: NeedsReviewKind;
  /** The key's first id (order, appointment, store event, flow run, campaign, scheduled reply). */
  ref1: string | null;
  /** The key's second id (campaign recipient row; contact for a contact-event rule). */
  ref2: string | null;
  /** order message kind or appointment message kind. */
  subKind: string | null;
  /** appointment version. */
  version: number | null;
}

/** What a dispatchOnce key (without the account prefix) belongs to. Mirrors KIND_SQL below. */
export function parseReviewKey(key: string): ParsedReviewKey {
  const parts = key.split(':');
  const id = (value: string | undefined) => (value && UUID_RE.test(value) ? value.toLowerCase() : null);
  const base = { ref1: id(parts[1]), ref2: id(parts[2]), subKind: null, version: null };
  const head = parts[0];
  if (head === 'order') return { ...base, kind: 'order', subKind: parts[2] ?? null, ref2: null };
  if (/^appt-(rem|ntf|fbk|rbk)$/.test(head)) {
    const version = /^v(\d{1,9})$/.exec(parts[2] ?? '');
    const subKind = head === 'appt-fbk' ? 'feedback' : head === 'appt-rbk' ? 'rebook' : parts[3] ?? null;
    return { ...base, kind: 'appointment', ref2: null, subKind, version: version ? Number(version[1]) : null };
  }
  if (head === 'commerce') return { ...base, kind: 'store_event' };
  if (head === 'flow' || head === 'flow-api') return { ...base, kind: 'flow' };
  if (head === 'automation') return { ...base, kind: 'rule' };
  // contact-event:<automation>:<contact>:<event>
  if (head === 'contact-event') return { ...base, kind: 'rule' };
  if (head === 'broadcast') return { ...base, kind: 'campaign' };
  if (head === 'scheduled-reply') return { ...base, kind: 'scheduled_reply' };
  return { ...base, kind: 'other' };
}

const KIND_SQL = Prisma.sql`CASE
    WHEN t.head = 'order' THEN 'order'
    WHEN t.head IN ('appt-rem','appt-ntf','appt-fbk','appt-rbk') THEN 'appointment'
    WHEN t.head = 'commerce' THEN 'store_event'
    WHEN t.head IN ('flow','flow-api') THEN 'flow'
    WHEN t.head IN ('automation','contact-event') THEN 'rule'
    WHEN t.head = 'broadcast' THEN 'campaign'
    WHEN t.head = 'scheduled-reply' THEN 'scheduled_reply'
    ELSE 'other' END`;

/** The intent alias i is open for review, in this workspace. */
function openIntent(accountId: string): Prisma.Sql {
  return Prisma.sql`i.account_id = ${accountId}::uuid
    AND left(i.idempotency_key, 37) = ${`${accountId}:`}
    AND i.status IN ('unknown','dispatching')
    AND (i.status = 'unknown' OR (i.updated_at < now() - ${STUCK_INTERVAL}
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = i.job_id AND j.status = 'running' AND j.lease_until > now())))`;
}

/** The open intents with their kind, ids and links; filtered and without rows another screen already resolved. */
function reviewRows(accountId: string, kind: NeedsReviewKind | null): Prisma.Sql {
  const ref = (n: 2 | 3) => Prisma.sql`CASE WHEN split_part(b.k, ':', ${Prisma.raw(String(n))}) ~* ${UUID_SQL} THEN split_part(b.k, ':', ${Prisma.raw(String(n))})::uuid END`;
  return Prisma.sql`
    WITH b AS (
      SELECT i.id, i.status, i.created_at, i.job_id, substr(i.idempotency_key, 38) AS k
      FROM outbound_intents i WHERE ${openIntent(accountId)}
    ), t AS (
      SELECT b.*, split_part(b.k, ':', 1) AS head, ${ref(2)} AS ref1, ${ref(3)} AS ref2,
        split_part(b.k, ':', 3) AS part3, split_part(b.k, ':', 4) AS part4
      FROM b
    ), r AS (
      SELECT t.*, ${KIND_SQL} AS kind FROM t
    )
    SELECT r.id::text AS id, r.kind, r.status, r.created_at, r.k, r.job_id,
      c.id::text AS contact_id, c.name AS contact_name,
      COALESCE(o.conversation_id, a.conversation_id, f.conversation_id, s.conversation_id)::text AS conversation_id
    FROM r
    LEFT JOIN orders o ON r.kind = 'order' AND o.account_id = ${accountId}::uuid AND o.id = r.ref1
    LEFT JOIN appointments a ON r.kind = 'appointment' AND a.account_id = ${accountId}::uuid AND a.id = r.ref1
    LEFT JOIN commerce_events e ON r.kind = 'store_event' AND e.account_id = ${accountId}::uuid AND e.id = r.ref1
    LEFT JOIN flow_runs f ON r.kind = 'flow' AND f.account_id = ${accountId}::uuid AND f.id = r.ref1
    LEFT JOIN broadcast_recipients br ON r.kind = 'campaign' AND br.account_id = ${accountId}::uuid AND br.id = r.ref2
    LEFT JOIN scheduled_replies s ON r.kind = 'scheduled_reply' AND s.account_id = ${accountId}::uuid AND s.id = r.ref1
    LEFT JOIN contacts c ON c.account_id = ${accountId}::uuid AND c.id = COALESCE(o.contact_id, a.contact_id, e.contact_id,
      f.contact_id, br.contact_id, CASE WHEN r.head = 'contact-event' THEN r.ref2 END)
    WHERE (${kind}::text IS NULL OR r.kind = ${kind}::text)
      AND NOT (r.kind = 'store_event' AND e.resolved_at IS NOT NULL)
      AND NOT (r.kind = 'order' AND EXISTS (SELECT 1 FROM order_messages m WHERE m.account_id = ${accountId}::uuid
        AND m.order_id = r.ref1 AND m.kind = r.part3 AND m.resolved_at IS NOT NULL))
      AND NOT (r.kind = 'appointment' AND EXISTS (SELECT 1 FROM appointment_messages m WHERE m.account_id = ${accountId}::uuid
        AND m.appointment_id = r.ref1 AND m.resolved_at IS NOT NULL
        AND m.version::text = substring(r.part3 from '^v([0-9]+)$')
        AND m.kind = CASE r.head WHEN 'appt-fbk' THEN 'feedback' WHEN 'appt-rbk' THEN 'rebook' ELSE r.part4 END))`;
}

type ListRow = {
  id: string; kind: NeedsReviewKind; status: string; created_at: Date; k: string; job_id: string | null;
  contact_id: string | null; contact_name: string | null; conversation_id: string | null; queueable: boolean;
};

/** The job that claimed the intent: recorded by dispatchOnce, or (older rows) a job whose dedupe key is the intent key. */
const OWNING_JOB = (accountId: string) => Prisma.sql`(SELECT j.id FROM jobs j WHERE j.tenant_id = ${accountId}::uuid
  AND (j.id = x.job_id OR (x.job_id IS NULL AND j.dedupe_key = x.k)) LIMIT 1)`;

/** One page of the workspace's uncertain sends, newest first, with the total from the same filter. */
export async function listNeedsReview(ctx: TenantContext, options: { kind?: NeedsReviewKind | null; page?: number; pageSize?: number } = {}):
  Promise<NeedsReviewPage> {
  const kind = options.kind ?? null;
  const page = Math.max(0, Math.trunc(options.page ?? 0));
  const pageSize = Math.min(Math.max(1, Math.trunc(options.pageSize ?? NEEDS_REVIEW_PAGE_SIZE)), NEEDS_REVIEW_PAGE_MAX);
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<(ListRow & { total: number })[]>(Prisma.sql`
      WITH x AS (${reviewRows(ctx.accountId, kind)})
      SELECT x.*, ${OWNING_JOB(ctx.accountId)} IS NOT NULL AS queueable, count(*) OVER ()::int AS total
      FROM x ORDER BY x.created_at DESC, x.id DESC LIMIT ${pageSize} OFFSET ${page * pageSize}`);
    let total = rows[0]?.total ?? 0;
    // A page past the end has no row to carry the total.
    if (!rows.length && page > 0) {
      const [counted] = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
        WITH x AS (${reviewRows(ctx.accountId, kind)}) SELECT count(*)::int AS total FROM x`);
      total = counted?.total ?? 0;
    }
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        reason: row.status === 'unknown' ? 'outcome_unknown' : 'stuck_sending',
        contact: row.contact_id ? { id: row.contact_id, name: row.contact_name } : null,
        conversation_id: row.conversation_id,
        created_at: new Date(row.created_at).toISOString(),
        can_send_again: row.kind === 'campaign' || row.queueable,
      })),
      total,
      page,
      page_size: pageSize,
    };
  });
}

/** How many sends need review (the Settings badge). */
export async function countNeedsReview(ctx: TenantContext): Promise<number> {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
      WITH x AS (${reviewRows(ctx.accountId, null)}) SELECT count(*)::int AS total FROM x`);
    return row?.total ?? 0;
  });
}

/** Resolves the module's own record of a send that went out, through that module's function. */
async function resolveModuleRecord(tx: TenantTransaction, ctx: TenantContext & { userId: string }, key: ParsedReviewKey): Promise<void> {
  const { accountId, userId } = ctx;
  try {
    if (key.kind === 'order' && key.ref1 && key.subKind) {
      // order_messages has no resolve function; the admin_resolve policy allows exactly these columns.
      await tx.$executeRaw`UPDATE order_messages SET resolved_at = now(), resolved_by = ${userId}::uuid
        WHERE account_id = ${accountId}::uuid AND order_id = ${key.ref1}::uuid AND kind = ${key.subKind}
          AND resolved_at IS NULL AND status = 'outcome_unknown'`;
    } else if (key.kind === 'appointment' && key.ref1 && key.subKind && key.version !== null) {
      const [message] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM appointment_messages
        WHERE account_id = ${accountId}::uuid AND appointment_id = ${key.ref1}::uuid AND version = ${key.version}
          AND kind = ${key.subKind} AND resolved_at IS NULL AND status = 'outcome_unknown'`;
      if (message) await resolveMessage(tx, accountId, userId, message.id);
    } else if (key.kind === 'store_event' && key.ref1) {
      await resolveCommerceEventTx(tx, ctx, key.ref1, 'sent');
    } else if (key.kind === 'campaign' && key.ref1 && key.ref2) {
      await reconcileBroadcastRecipients(tx, { accountId, userId, broadcastId: key.ref1, recipientIds: [key.ref2], resolution: 'sent' });
    }
  } catch (error) {
    // The module record is already resolved, or not in a resolvable state: the intent decides alone.
    if (error instanceof AppointmentError || error instanceof AttentionError || error instanceof ReconcileError) return;
    throw error;
  }
}

/**
 * Records an admin's decision on one uncertain send. Throws NeedsReviewError not_found (not in this
 * workspace) or not_open (already resolved, or its job is sending right now).
 */
export async function resolveNeedsReview(ctx: TenantContext & { userId: string }, id: string, action: NeedsReviewAction):
  Promise<{ id: string; action: NeedsReviewAction; requeued: boolean }> {
  if (!UUID_RE.test(id)) throw new NeedsReviewError('not_found', 404);
  const { accountId, userId } = ctx;
  return withTenant(ctx, async (tx) => {
    // The lock serialises a double click or two admins: the second sees the row no longer open.
    const [row] = await tx.$queryRaw<{ id: string; status: string; k: string; job_id: string | null }[]>(Prisma.sql`
      SELECT i.id::text AS id, i.status, substr(i.idempotency_key, 38) AS k, i.job_id::text AS job_id
      FROM outbound_intents i WHERE i.id = ${id}::uuid AND ${openIntent(accountId)} FOR UPDATE OF i`);
    if (!row) {
      const seen = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM outbound_intents WHERE account_id = ${accountId}::uuid AND id = ${id}::uuid`;
      throw seen.length ? new NeedsReviewError('not_open', 409) : new NeedsReviewError('not_found', 404);
    }
    const key = parseReviewKey(row.k);
    let requeued = false;

    if (action === 'was_sent') {
      // result '{}' when none was stored: a later dispatchOnce on this key returns it instead of sending.
      await tx.$executeRaw`UPDATE outbound_intents SET status = 'accepted', result = COALESCE(result, '{}'::jsonb),
        last_error = 'Marked sent after review', updated_at = now() WHERE id = ${row.id}::uuid`;
      await resolveModuleRecord(tx, ctx, key);
    } else if (key.kind === 'campaign') {
      // The campaign's "Retry failed" re-claims a failed intent (retryRejected) and sends it once.
      await tx.$executeRaw`UPDATE outbound_intents SET status = 'failed', last_error = 'Marked not sent after review',
        updated_at = now() WHERE id = ${row.id}::uuid`;
      if (key.ref1 && key.ref2) {
        await reconcileBroadcastRecipients(tx, { accountId, userId, broadcastId: key.ref1, recipientIds: [key.ref2], resolution: 'not_sent' })
          .catch((error) => { if (!(error instanceof ReconcileError)) throw error; });
      }
    } else {
      // Retire the intent: its key is free, so the job's next dispatchOnce claims it and sends once.
      await tx.$executeRaw`UPDATE outbound_intents SET idempotency_key = idempotency_key || '#reviewed:' || id::text,
        status = 'failed', last_error = 'Cleared for another send after review', updated_at = now() WHERE id = ${row.id}::uuid`;
      const [job] = await tx.$queryRaw<{ id: string; type: string; payload: unknown; max_attempts: number; status: string; lane_key: string | null }[]>(Prisma.sql`
        SELECT j.id::text AS id, j.type, j.payload, j.max_attempts, j.status, j.lane_key FROM jobs j
        WHERE j.tenant_id = ${accountId}::uuid
          AND (j.id = ${row.job_id}::uuid OR (${row.job_id}::uuid IS NULL AND j.dedupe_key = ${row.k}))
        LIMIT 1`);
      if (job) {
        requeued = true;
        // A job still pending or running sends on its own next attempt; a finished one runs again as a copy.
        if (job.status !== 'pending' && job.status !== 'running') {
          // The copy keeps the conversation's lane key, so it still runs in order with that conversation's jobs.
          await tx.$executeRaw`INSERT INTO jobs(type, tenant_id, payload, dedupe_key, max_attempts, lane_key)
            VALUES(${job.type}, ${accountId}::uuid, ${JSON.stringify(job.payload)}::jsonb, ${`needs-review:${row.id}`}, ${job.max_attempts}, ${job.lane_key})
            ON CONFLICT (dedupe_key) DO NOTHING`;
        }
      }
    }

    await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
      VALUES(${accountId}::uuid, ${userId}::uuid, ${`needs_review.${action}`}, ${row.id},
        ${JSON.stringify({ kind: key.kind, status: row.status, requeued })}::jsonb)`;
    return { id: row.id, action, requeued };
  });
}
