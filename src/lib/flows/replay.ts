// Run inspection and replay of failed flow runs (Phase 12, design §3.2-3.3).
//
// Replay re-runs the step a run failed on, on the version the run is pinned
// to, and only when it is safe:
// - the run failed in the last 7 days for a transient delivery or scheduling
//   reason (REPLAYABLE_END_REASONS); a business outcome (a payment link), a
//   booking that may have half happened, or a graph defect is never replayed;
// - the flow is not archived and the run is pinned to a version;
// - no send of the failed step has an ambiguous outcome (pending, dispatching
//   or unknown: that needs reconciliation, never a blind re-send) and none was
//   accepted (the failure came after the message went out);
// - no other run is active on the same conversation.
// The run row is locked FOR UPDATE, reactivated with transition_seq + 1 (so
// the step's sends get new outbound-intent keys) and the `flow.replay` job is
// inserted in the same transaction, before the route answers.
//
// Intent keys are `${account}:${prefix}:${run}:...` (engine.ts): `flow` and
// `flow-api` carry `${node}:${seq}:${attempt}` (plus `:caption` or
// `:storefront_link`); `flow-ai` and `flow-fallback` carry an inbound message
// id. Only fixed fields are exposed: never a payload, result or message id.
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { FlowRow } from './types';

export const REPLAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INSPECTED_INTENTS = 200;

/** End reasons of transient delivery or scheduling failures, the only ones replay accepts. */
export const REPLAYABLE_END_REASONS: ReadonlySet<string> = new Set([
  'send_text_failed',
  'send_media_failed',
  'send_buttons_failed',
  'send_list_failed',
  'send_template_failed',
  'send_form_failed',
  'send_product_failed',
  'send_product_list_failed',
  'send_catalog_failed',
  'collect_input_prompt_failed',
  'ask_media_prompt_failed',
  'ask_location_prompt_failed',
  'ask_address_prompt_failed',
  'delay_schedule_failed',
  'storefront_link_failed',
]);

export type ReplayRefusal =
  | 'not_failed'
  | 'too_old'
  | 'no_contact'
  | 'flow_archived'
  | 'not_pinned'
  | 'not_replayable_reason'
  | 'needs_reconciliation'
  | 'already_sent'
  | 'conversation_busy';

export type Replayable = { ok: true } | { ok: false; reason: ReplayRefusal };

export interface ReplayRunState {
  status: string;
  ended_at: Date | string | null;
  end_reason: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  flow_version_id: string | null;
}

export type IntentStatus = 'pending' | 'dispatching' | 'accepted' | 'failed' | 'unknown' | string;

/** Pure: whether a run may be replayed, and why not. */
export function replayEligibility(input: {
  run: ReplayRunState;
  flowStatus: FlowRow['status'] | string;
  failedNode: string | null;
  /** The failed step's error-event reason (payload.reason), when known. */
  failedReason?: string | null;
  nodeIntents: ReadonlyArray<{ status: IntentStatus }>;
  conversationBusy: boolean;
  now?: Date;
}): Replayable {
  const { run } = input;
  const now = input.now ?? new Date();
  if (run.status !== 'failed') return { ok: false, reason: 'not_failed' };
  const ended = run.ended_at ? new Date(run.ended_at).getTime() : NaN;
  if (!Number.isFinite(ended) || now.getTime() - ended > REPLAY_WINDOW_MS) return { ok: false, reason: 'too_old' };
  if (!run.contact_id || !run.conversation_id) return { ok: false, reason: 'no_contact' };
  if (input.flowStatus === 'archived') return { ok: false, reason: 'flow_archived' };
  if (!run.flow_version_id) return { ok: false, reason: 'not_pinned' };
  if (!run.end_reason || !REPLAYABLE_END_REASONS.has(run.end_reason) || !input.failedNode) {
    return { ok: false, reason: 'not_replayable_reason' };
  }
  // The engine ends every unsuccessful storefront link with this one reason;
  // only a failed send is transient. A bad config, a missing order or a
  // disabled storefront would fail again the same way.
  if (run.end_reason === 'storefront_link_failed' && input.failedReason !== 'storefront_link_send_failed') {
    return { ok: false, reason: 'not_replayable_reason' };
  }
  if (input.nodeIntents.some((i) => i.status === 'pending' || i.status === 'dispatching' || i.status === 'unknown')) {
    return { ok: false, reason: 'needs_reconciliation' };
  }
  if (input.nodeIntents.some((i) => i.status === 'accepted')) return { ok: false, reason: 'already_sent' };
  if (input.nodeIntents.some((i) => i.status !== 'failed')) return { ok: false, reason: 'needs_reconciliation' };
  if (input.conversationBusy) return { ok: false, reason: 'conversation_busy' };
  return { ok: true };
}

/** A LIKE pattern matching keys that start with `prefix` (wildcards escaped). */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface InspectedIntent {
  kind: 'flow' | 'flow-api' | 'flow-ai' | 'flow-fallback';
  node_key: string | null;
  seq: number | null;
  attempt: number | null;
  /** A second message of the same step: 'caption' or 'storefront_link'. */
  part: string | null;
  status: string;
  last_error: string | null;
  updated_at: string;
}

const KINDS = ['flow', 'flow-api', 'flow-ai', 'flow-fallback'] as const;

/** Parses the fixed fields of an intent key; null for a key that is not this run's. */
export function parseIntentKey(key: string, accountId: string, runId: string): Pick<InspectedIntent, 'kind' | 'node_key' | 'seq' | 'attempt' | 'part'> | null {
  for (const kind of KINDS) {
    const prefix = `${accountId}:${kind}:${runId}:`;
    if (!key.startsWith(prefix)) continue;
    if (kind === 'flow-ai' || kind === 'flow-fallback') return { kind, node_key: null, seq: null, attempt: null, part: null };
    const parts = key.slice(prefix.length).split(':');
    const seq = /^\d+$/.test(parts[1] ?? '') ? Number(parts[1]) : null;
    const hasAttempt = /^\d+$/.test(parts[2] ?? '');
    const rest = parts.slice(hasAttempt ? 3 : 2).join(':');
    return { kind, node_key: parts[0] || null, seq, attempt: hasAttempt ? Number(parts[2]) : null, part: rest || null };
  }
  return null;
}

interface IntentDbRow {
  idempotency_key: string;
  status: string;
  last_error: string | null;
  updated_at: Date | string;
}

/** The run's outbound intents, newest first, at most MAX_INSPECTED_INTENTS. */
export async function readRunIntents(tx: TenantTransaction, accountId: string, runId: string): Promise<InspectedIntent[]> {
  const rows: IntentDbRow[] = [];
  for (const kind of KINDS) {
    // One prefix scan per kind, on outbound_intents_key_prefix_idx.
    rows.push(...await tx.$queryRaw<IntentDbRow[]>(Prisma.sql`SELECT idempotency_key, status, last_error, updated_at
      FROM outbound_intents WHERE account_id=${accountId}::uuid
        AND idempotency_key LIKE ${likePrefix(`${accountId}:${kind}:${runId}:`)}
      ORDER BY updated_at DESC LIMIT ${MAX_INSPECTED_INTENTS}`));
  }
  return rows
    .map((row) => {
      const parsed = parseIntentKey(row.idempotency_key, accountId, runId);
      return parsed && { ...parsed, status: row.status, last_error: row.last_error,
        updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) };
    })
    .filter((row): row is InspectedIntent => row !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, MAX_INSPECTED_INTENTS);
}

/** The intents of one step at one transition (every attempt and part). */
export async function readNodeIntents(tx: TenantTransaction, accountId: string, runId: string, nodeKey: string, seq: number):
  Promise<Array<{ status: string }>> {
  const step = `${runId}:${nodeKey}:${seq}:`;
  return tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT status FROM outbound_intents
    WHERE account_id=${accountId}::uuid AND (idempotency_key LIKE ${likePrefix(`${accountId}:flow:${step}`)}
      OR idempotency_key LIKE ${likePrefix(`${accountId}:flow-api:${step}`)})`);
}

/**
 * The step a run failed on, and that error event's reason: the newest
 * `error` event with a node, preferring one whose reason is the run's end
 * reason.
 */
export async function readFailedNode(tx: TenantTransaction, accountId: string, runId: string, endReason: string | null):
  Promise<{ node_key: string; reason: string | null } | null> {
  const rows = await tx.$queryRaw<Array<{ node_key: string; reason: string | null }>>(Prisma.sql`SELECT node_key, payload->>'reason' AS reason
    FROM flow_run_events WHERE account_id=${accountId}::uuid AND flow_run_id=${runId}::uuid
      AND event_type='error' AND node_key IS NOT NULL
    ORDER BY created_at DESC, id DESC LIMIT 20`);
  const row = rows.find((r) => r.reason === endReason) ?? rows[0];
  return row ? { node_key: row.node_key, reason: row.reason } : null;
}

interface RunDbRow extends ReplayRunState {
  id: string;
  flow_id: string;
  current_node_key: string | null;
  transition_seq: number;
}

async function conversationBusy(tx: TenantTransaction, accountId: string, run: RunDbRow): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT 1 FROM flow_runs
    WHERE account_id=${accountId}::uuid AND status='active' AND id<>${run.id}::uuid
      AND contact_id IS NOT DISTINCT FROM ${run.contact_id}::uuid
      AND conversation_id IS NOT DISTINCT FROM ${run.conversation_id}::uuid LIMIT 1`);
  return rows.length > 0;
}

async function readRun(tx: TenantTransaction, accountId: string, flowId: string, runId: string, lock: boolean): Promise<RunDbRow | null> {
  const rows = await tx.$queryRaw<RunDbRow[]>(Prisma.sql`SELECT id::text, flow_id::text, status, ended_at, end_reason,
      contact_id::text, conversation_id::text, flow_version_id::text, current_node_key, transition_seq
    FROM flow_runs WHERE account_id=${accountId}::uuid AND id=${runId}::uuid AND flow_id=${flowId}::uuid
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
  return rows[0] ?? null;
}

async function flowStatus(tx: TenantTransaction, accountId: string, flowId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`SELECT status FROM flows
    WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid`);
  return rows[0]?.status ?? null;
}

/** Eligibility of a run as it stands, for the inspection page (no lock). */
export async function inspectReplayable(tx: TenantTransaction, accountId: string, flowId: string, runId: string,
  now = new Date()): Promise<{ replayable: Replayable; failedNode: string | null } | null> {
  const run = await readRun(tx, accountId, flowId, runId, false);
  if (!run) return null;
  return evaluate(tx, accountId, flowId, run, now);
}

async function evaluate(tx: TenantTransaction, accountId: string, flowId: string, run: RunDbRow, now: Date) {
  const status = (await flowStatus(tx, accountId, flowId)) ?? 'archived';
  if (run.status !== 'failed') {
    return { replayable: replayEligibility({ run, flowStatus: status, failedNode: null, nodeIntents: [], conversationBusy: false, now }), failedNode: null };
  }
  const failed = await readFailedNode(tx, accountId, run.id, run.end_reason);
  const failedNode = failed?.node_key ?? null;
  const nodeIntents = failedNode ? await readNodeIntents(tx, accountId, run.id, failedNode, run.transition_seq) : [];
  const busy = await conversationBusy(tx, accountId, run);
  return {
    replayable: replayEligibility({ run, flowStatus: status, failedNode, failedReason: failed?.reason ?? null, nodeIntents, conversationBusy: busy, now }),
    failedNode,
  };
}

export class ReplayError extends Error {
  constructor(public readonly reason: ReplayRefusal | 'not_found') {
    super(reason);
    this.name = 'ReplayError';
  }
}

export interface ReplayQueued {
  run_id: string;
  node_key: string;
  seq: number;
}

/**
 * Reactivates a failed run and queues its replay, in the caller's
 * transaction (the member's, so RLS scopes every statement to the
 * workspace). Throws ReplayError when the run may not be replayed. A
 * concurrent run on the same conversation can still win the unique index
 * between the check and the update; the caller maps that 23505 to
 * conversation_busy.
 */
export async function replayFlowRun(tx: TenantTransaction, args: { accountId: string; flowId: string; runId: string; userId: string; now?: Date }):
  Promise<ReplayQueued> {
  const run = await readRun(tx, args.accountId, args.flowId, args.runId, true);
  if (!run) throw new ReplayError('not_found');
  const { replayable, failedNode } = await evaluate(tx, args.accountId, args.flowId, run, args.now ?? new Date());
  if (!replayable.ok) throw new ReplayError(replayable.reason);
  const nodeKey = failedNode!;

  // last_advanced_at=now() so the run timeout does not end a replay of an older failure;
  // the seq bump gives the replayed step new outbound-intent keys.
  const updated = await tx.$queryRaw<Array<{ transition_seq: number }>>(Prisma.sql`UPDATE flow_runs
    SET status='active', ended_at=NULL, end_reason=NULL, transition_seq=transition_seq+1, reprompt_count=0,
      current_node_key=${nodeKey}, delay_until=NULL, wait_until=NULL, last_advanced_at=now()
    WHERE account_id=${args.accountId}::uuid AND id=${run.id}::uuid AND status='failed'
    RETURNING transition_seq`);
  if (!updated[0]) throw new ReplayError('not_failed');
  const seq = updated[0].transition_seq;
  await tx.$executeRaw(Prisma.sql`INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key,payload)
    VALUES(${args.accountId}::uuid,${run.id}::uuid,'replayed',${nodeKey},${JSON.stringify({ by: args.userId, seq })}::jsonb)`);

  // Queued before the route answers, in the same transaction as the reactivation.
  const payload = { accountId: args.accountId, runId: run.id, seq, nodeKey };
  await tx.$executeRaw(Prisma.sql`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES('flow.replay',${args.accountId}::uuid,${JSON.stringify(payload)}::jsonb,${`flow-replay:${run.id}:${seq}`})
    ON CONFLICT (dedupe_key) DO NOTHING`);
  await tx.$executeRaw(Prisma.sql`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${args.accountId}::uuid,${args.userId}::uuid,'flows.run_replayed',${args.flowId},
      ${JSON.stringify({ flow_id: args.flowId, run_id: run.id, node_key: nodeKey, seq, end_reason: run.end_reason })}::jsonb)`);
  return { run_id: run.id, node_key: nodeKey, seq };
}

/** Whether a database error is a unique violation (23505), e.g. the one-active-run-per-conversation index. */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return e.code === '23505' || e.meta?.code === '23505' || (typeof e.message === 'string' && /\b23505\b|unique constraint/i.test(e.message));
}
