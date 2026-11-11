// Instagram comment private replies (Phase 11, design section 6; Stage 2 comment flows).
//
// The webhook processor (process-webhook.ts) records each comment once in
// instagram_comment_events (UNIQUE (instagram_account_id, comment_id)) and
// queues this job once per comment (dedupe igpr:<event id>) with status 'queued':
//   - { eventId }: a legacy comment rule matched. This job sends that rule's
//     text as ONE private reply (runPrivateReply).
//   - { eventId, flows, fallbackRuleId }: live ig_comment flows may take the
//     comment (Stage 2). runCommentFlowJob starts the first one that does
//     (resolving a "next post" flow against Graph first); the flow's private
//     reply step then sends through sendCommentPrivateReply. When no flow
//     takes it, the legacy rule (if any) runs as the fallback.
// Every private reply, from a rule or a flow:
//   - only while the event is still 'queued' and the comment is at most 7 days
//     old (else 'expired');
//   - through dispatchOnce('ig_private_reply:<comment_id>'), the same key on both
//     paths, so a comment never gets a second private reply and an ambiguous
//     outcome is recorded as 'unknown' and never sent again automatically;
//   - under Meta's 750 private replies per hour per professional account: at 700
//     sent/unknown in the last hour it is held back (the rule job is queued again
//     later; a flow step waits and retries) with no counter columns (the partial
//     index instagram_comment_events_rate_idx serves the count).
// A public reply under the comment (postCommentPublicReply) is sent at most
// once per comment (dispatch key ig-comment-reply:<comment_id>) and its id is
// kept on the event. Nothing runs while Instagram is off (instagramConfig() ===
// null). No comment text, reply text, token or Meta message is logged.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { FLOW_TRIGGER_LIMITS, type IgCommentTriggerConfig } from '@/lib/flows/types';
import { effectiveTriggers } from '@/lib/flows/flow-triggers';
import { instagramConfig, missingScopes } from './config';
import { recordHealthTx } from './health';
import {
  isMetaThrottle, isMetaTokenInvalid, listMedia, metaErrorCode, quickRepliesFit, replyToComment, sendPrivateReply,
  validCommentReply, validInstagramText, type QuickReply,
} from './graph';
import { isNextPost, type MediaTime } from './comment-matching';
import { INSTAGRAM_PRIVATE_REPLY_JOB } from './jobs';

/** (unconfirmed) Meta allows a private reply within 7 days of the comment; the live check confirms it. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Meta's documented limit is 750 per hour per professional account; we stop short of it. */
export const PRIVATE_REPLY_HOURLY_GUARD = 700;
/** How long a rate-limited or throttled reply waits before the job (or the flow step) tries again. */
export const PRIVATE_REPLY_RETRY_MS = 10 * 60 * 1000;
/** At most this many flows are offered one comment (the webhook ranks them). */
const MAX_FLOW_CHOICES = 100;

export type PrivateReplyOutcome =
  | 'disabled' | 'noop' | 'sent' | 'unknown' | 'expired' | 'rejected' | 'no_rule' | 'rate_limited' | 'throttled';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EventRow {
  comment_id: string;
  received_at: Date;
  status: string;
  instagram_account_id: string;
  flow_run_id: string | null;
  reply_text: string | null;
  rule_active: boolean | null;
  ig_user_id: string;
  account_status: string;
  scopes: string[] | null;
  access_token_enc: string | null;
  contact_blocked: boolean;
  /** Stage 5: the commenter unsubscribed on Instagram (5D consent); null before Stage 5 rows load the column. */
  contact_opted_out?: boolean | null;
}

interface SendPlan { commentId: string; igUserId: string; instagramAccountId: string; tokenEnc: string; text: string; quickReplies?: QuickReply[] }

type Plan = { kind: 'done'; outcome: PrivateReplyOutcome } | ({ kind: 'send' } & SendPlan);

const worker = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

/** Queue this event's job again at `runAt`; the bucket keeps one job per retry slot. */
async function requeue(tx: TenantTransaction, accountId: string, eventId: string, reason: 'rate' | 'throttle', now: Date): Promise<void> {
  const runAt = new Date(now.getTime() + PRIVATE_REPLY_RETRY_MS);
  const bucket = Math.floor(now.getTime() / PRIVATE_REPLY_RETRY_MS);
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at,max_attempts)
    VALUES(${INSTAGRAM_PRIVATE_REPLY_JOB},${accountId}::uuid,${JSON.stringify({ eventId })}::jsonb,
      ${`igpr:${eventId}:${reason}:${bucket}`},${runAt},5)
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

async function settle(accountId: string, eventId: string, status: 'sent' | 'unknown' | 'rejected' | 'expired' | 'no_rule',
  now: Date): Promise<void> {
  const sentAt = status === 'sent' || status === 'unknown' ? now : null;
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE instagram_comment_events
    SET private_reply_status=${status}, private_reply_at=COALESCE(${sentAt}::timestamptz, private_reply_at)
    WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid AND private_reply_status='queued'`);
}

/** The event (locked), its account and whether the commenter is blocked. */
async function lockEvent(tx: TenantTransaction, accountId: string, eventId: string): Promise<EventRow | null> {
  const [row] = await tx.$queryRaw<EventRow[]>(Prisma.sql`
    SELECT e.comment_id, e.received_at, e.private_reply_status AS status, e.instagram_account_id::text AS instagram_account_id,
      e.flow_run_id::text AS flow_run_id, r.reply_text, r.active AS rule_active, a.ig_user_id, a.status AS account_status,
      a.scopes, a.access_token_enc, (ct.blocked_at IS NOT NULL) AS contact_blocked,
      (ct.instagram_opted_out_at IS NOT NULL) AS contact_opted_out
    FROM instagram_comment_events e
    JOIN instagram_accounts a ON a.account_id=e.account_id AND a.id=e.instagram_account_id
    LEFT JOIN instagram_comment_rules r ON r.account_id=e.account_id AND r.id=e.rule_id
    LEFT JOIN contact_channel_identities i ON i.account_id=e.account_id AND i.instagram_account_id=e.instagram_account_id
      AND i.external_id=e.from_igsid
    LEFT JOIN contacts ct ON ct.account_id=i.account_id AND ct.id=i.contact_id
    WHERE e.account_id=${accountId}::uuid AND e.id=${eventId}::uuid
    FOR UPDATE OF e`);
  return row ?? null;
}

/**
 * The checks every private reply passes before an intent exists, under the
 * event's row lock. `content` gives the text (and quick replies) to send, or
 * the status to record instead. Rate-limited returns without a status change.
 */
async function planReply(tx: TenantTransaction, accountId: string, eventId: string, row: EventRow, now: Date,
  content: { text: string; quickReplies?: QuickReply[] } | 'no_rule'): Promise<Plan> {
  const mark = async (status: 'expired' | 'rejected' | 'no_rule') => {
    await tx.$executeRaw`UPDATE instagram_comment_events SET private_reply_status=${status}
      WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid`;
    return { kind: 'done' as const, outcome: status };
  };
  if (now.getTime() - new Date(row.received_at).getTime() > PRIVATE_REPLY_WINDOW_MS) return mark('expired');
  if (content === 'no_rule') return mark('no_rule');
  if (!validInstagramText(content.text)) return mark('rejected');
  if (content.quickReplies && !quickRepliesFit(content.quickReplies)) return mark('rejected');
  // Like every other Instagram send path: a contact the business blocked (even after the comment was queued) gets no DM.
  if (row.contact_blocked) return mark('rejected');
  // Stage 5: a commenter who unsubscribed on Instagram gets no automated DM, a legacy rule's included.
  if (row.contact_opted_out === true) return mark('rejected');
  if (row.account_status !== 'active' || !row.access_token_enc || missingScopes(row.scopes ?? [], 'comments').length)
    return mark('rejected');
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_comment_events
    WHERE account_id=${accountId}::uuid AND instagram_account_id=${row.instagram_account_id}::uuid
      AND private_reply_status IN ('sent','unknown') AND private_reply_at > ${now}::timestamptz - interval '1 hour'`;
  if (n >= PRIVATE_REPLY_HOURLY_GUARD) return { kind: 'done', outcome: 'rate_limited' };
  return {
    kind: 'send', commentId: row.comment_id, igUserId: row.ig_user_id, instagramAccountId: row.instagram_account_id,
    tokenEnc: row.access_token_enc, text: content.text, ...(content.quickReplies ? { quickReplies: content.quickReplies } : {}),
  };
}

/** Sends a planned reply under the per-comment intent and records the outcome on the event. */
async function deliver(accountId: string, eventId: string, plan: SendPlan, now: Date): Promise<PrivateReplyOutcome> {
  // Decrypt before the intent exists: a failure here is not a provider outcome.
  const token = decrypt(plan.tokenEnc);
  try {
    // A queued event with a 'failed' intent was rejected by Meta (only a throttle
    // leaves the event queued) or the worker crashed before recording the
    // rejection: nothing was delivered, so claiming it again is safe. An
    // 'unknown' or 'accepted' intent is never re-sent.
    await dispatchOnce(accountId, `ig_private_reply:${plan.commentId}`,
      () => sendPrivateReply(plan.igUserId, token, plan.commentId, plan.text, plan.quickReplies), { retryRejected: true });
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      console.error('[instagram] private reply outcome unknown');
      await settle(accountId, eventId, 'unknown', now);
      return 'unknown';
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const code = metaErrorCode(error);
      console.error('[instagram] private reply rejected', { code });
      if (isMetaThrottle(error)) return 'throttled';
      if (isMetaTokenInvalid(error)) {
        // Compare-and-set on the token this send used (a reconnect meanwhile wins) and notify owners/admins once.
        await worker(accountId, (tx) => recordHealthTx(tx, accountId, plan.instagramAccountId, plan.tokenEnc, 'token_invalid',
          code && /^[0-9:]{1,32}$/.test(code) ? code : null));
      }
      await settle(accountId, eventId, 'rejected', now);
      return 'rejected';
    }
    throw error;
  }
  await settle(accountId, eventId, 'sent', now);
  return 'sent';
}

/** The instagram.private_reply job: { eventId } (a rule) or { eventId, flows, fallbackRuleId } (comment flows). */
export async function handlePrivateReplyJob(accountId: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  void attempt;
  if (payload.flows !== undefined) {
    await runCommentFlowJob(accountId, payload);
    return;
  }
  await runPrivateReply(accountId, payload);
}

/** A legacy comment rule's private reply. */
export async function runPrivateReply(accountId: string, payload: Record<string, unknown>,
  now: Date = new Date()): Promise<PrivateReplyOutcome> {
  if (!instagramConfig()) return 'disabled';
  const eventId = payload.eventId;
  if (typeof eventId !== 'string' || !UUID.test(eventId) || !UUID.test(accountId)) throw new Error('Invalid private reply job');

  const plan = await worker(accountId, async (tx): Promise<Plan> => {
    const row = await lockEvent(tx, accountId, eventId);
    // A comment a flow took is answered by the flow's own private reply step.
    if (!row || row.status !== 'queued' || row.flow_run_id) return { kind: 'done', outcome: 'noop' };
    // The rule was deleted or switched off after the comment matched it.
    const content = !row.reply_text || row.rule_active === false ? 'no_rule' as const : { text: row.reply_text };
    const planned = await planReply(tx, accountId, eventId, row, now, content);
    if (planned.kind === 'done' && planned.outcome === 'rate_limited') await requeue(tx, accountId, eventId, 'rate', now);
    return planned;
  });
  if (plan.kind === 'done') return plan.outcome;
  const outcome = await deliver(accountId, eventId, plan, now);
  if (outcome === 'throttled') await worker(accountId, (tx) => requeue(tx, accountId, eventId, 'throttle', now));
  return outcome;
}

/**
 * A comment flow's private reply step (engine.ts, ig_private_reply). The event
 * must be linked to this run. A reply already sent for the comment ('sent' or
 * 'unknown') is reported as such, so a step re-run after a crash moves on
 * without sending again. 'rate_limited' and 'throttled' leave the event queued:
 * the step waits PRIVATE_REPLY_RETRY_MS and tries again.
 */
export async function sendCommentPrivateReply(args: {
  accountId: string; eventId: string; runId: string; text: string; quickReplies?: QuickReply[]; now?: Date;
}): Promise<PrivateReplyOutcome> {
  if (!instagramConfig()) return 'disabled';
  const { accountId, eventId, runId } = args;
  const now = args.now ?? new Date();
  if (![accountId, eventId, runId].every((id) => UUID.test(id))) throw new Error('Invalid private reply request');
  const plan = await worker(accountId, async (tx): Promise<Plan> => {
    const row = await lockEvent(tx, accountId, eventId);
    // Another run's comment (or none): never answered from this run.
    if (!row || row.flow_run_id?.toLowerCase() !== runId.toLowerCase()) return { kind: 'done', outcome: 'rejected' };
    if (row.status === 'sent' || row.status === 'unknown') return { kind: 'done', outcome: row.status };
    if (row.status !== 'queued') return { kind: 'done', outcome: row.status === 'expired' ? 'expired' : 'rejected' };
    return planReply(tx, accountId, eventId, row, now, { text: args.text, quickReplies: args.quickReplies });
  });
  if (plan.kind === 'done') return plan.outcome;
  return deliver(accountId, eventId, plan, now);
}

// ---------------------------------------------------------------- comment flows

/** `trigger` (Stage 5): which of the flow's triggers matched, in effectiveTriggers order; absent means the primary. */
interface FlowChoice { flowId: string; check: boolean; trigger?: number }

function parseChoices(value: unknown): FlowChoice[] {
  if (!Array.isArray(value) || value.length > MAX_FLOW_CHOICES) throw new Error('Invalid private reply job');
  return value.map((raw) => {
    const choice = raw as Record<string, unknown> | null;
    if (!choice || typeof choice.flowId !== 'string' || !UUID.test(choice.flowId) || typeof choice.check !== 'boolean')
      throw new Error('Invalid private reply job');
    const trigger = choice.trigger;
    if (trigger !== undefined && (typeof trigger !== 'number' || !Number.isInteger(trigger) || trigger < 0 || trigger > FLOW_TRIGGER_LIMITS.extraTriggers))
      throw new Error('Invalid private reply job');
    return { flowId: choice.flowId, check: choice.check, ...(trigger ? { trigger } : {}) };
  });
}

interface CommentEventRow {
  status: string;
  flow_run_id: string | null;
  media_id: string | null;
  received_at: Date;
  ig_user_id: string;
  account_status: string;
  access_token_enc: string | null;
}

export type CommentFlowOutcome = PrivateReplyOutcome | 'flow';

/**
 * The comment-flow job: the first offered flow that takes the comment starts
 * a run on the commenter's conversation (engine.startCommentFlow). A "next
 * post" flow takes it only when Graph shows the post is the first one
 * published after the flow's start time. When no flow takes it, the legacy
 * rule the webhook matched (if any) sends its reply instead.
 */
export async function runCommentFlowJob(accountId: string, payload: Record<string, unknown>,
  now: Date = new Date()): Promise<CommentFlowOutcome> {
  if (!instagramConfig()) return 'disabled';
  const eventId = payload.eventId;
  if (typeof eventId !== 'string' || !UUID.test(eventId) || !UUID.test(accountId)) throw new Error('Invalid private reply job');
  const choices = parseChoices(payload.flows);
  const fallbackRuleId = payload.fallbackRuleId;
  if (fallbackRuleId !== null && fallbackRuleId !== undefined && (typeof fallbackRuleId !== 'string' || !UUID.test(fallbackRuleId)))
    throw new Error('Invalid private reply job');

  const event = await worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<CommentEventRow[]>(Prisma.sql`
      SELECT e.private_reply_status AS status, e.flow_run_id::text AS flow_run_id, e.media_id, e.received_at,
        a.ig_user_id, a.status AS account_status, a.access_token_enc
      FROM instagram_comment_events e JOIN instagram_accounts a ON a.account_id=e.account_id AND a.id=e.instagram_account_id
      WHERE e.account_id=${accountId}::uuid AND e.id=${eventId}::uuid`);
    return row ?? null;
  });
  if (!event || event.status !== 'queued' || event.flow_run_id) return 'noop';
  if (now.getTime() - new Date(event.received_at).getTime() > PRIVATE_REPLY_WINDOW_MS) {
    await settle(accountId, eventId, 'expired', now);
    return 'expired';
  }

  let media: MediaTime[] | null = null;
  const recentMedia = async (): Promise<MediaTime[]> => {
    if (media) return media;
    if (event.account_status !== 'active' || !event.access_token_enc) return (media = []);
    try {
      media = (await listMedia(event.ig_user_id, decrypt(event.access_token_enc))).map((m) => ({ id: m.id, timestamp: m.timestamp }));
    } catch (error) {
      // Refused by Meta: the next-post check cannot pass. Anything else retries the job.
      if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) media = [];
      else throw error;
    }
    return media;
  };

  const engine = await import('@/lib/flows/engine');
  let held = false;
  for (const choice of choices) {
    if (choice.check) {
      const trigger = await liveCommentTrigger(accountId, choice.flowId, choice.trigger ?? 0);
      if (!trigger || !isNextPost(event.media_id, await recentMedia(), trigger.next_after)) continue;
    }
    const started = await engine.startCommentFlow({ accountId, eventId, flowId: choice.flowId, trigger: choice.trigger ?? 0 });
    if (started === 'started' || started === 'taken') return 'flow';
    if (started === 'opted_out') {
      // Stage 5: the commenter unsubscribed on Instagram. No automated DM at all: no
      // other flow and no legacy rule (agents can still answer by hand).
      await settle(accountId, eventId, 'rejected', now);
      return 'rejected';
    }
    if (started === 'busy' || started === 'paused') {
      // The commenter is mid-conversation with a flow or a person: no flow starts
      // (every other flow would meet the same conversation). The legacy rule still
      // answers, exactly as it did before comment flows existed.
      held = true;
      break;
    }
  }
  if (!fallbackRuleId) {
    const status = held ? 'rejected' : 'no_rule';
    await settle(accountId, eventId, status, now);
    return status;
  }
  // No flow took the comment: the rule it matched answers it, exactly as before Stage 2.
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET rule_id=${fallbackRuleId}::uuid
    WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid AND private_reply_status='queued' AND flow_run_id IS NULL AND rule_id IS NULL`);
  return runPrivateReply(accountId, { eventId }, now);
}

/**
 * The ig_comment trigger at `index` (effectiveTriggers order: 0 is the
 * primary, Stage 5 extra triggers follow) of an active flow's published
 * version, or of a draft being tested, in this workspace; null otherwise.
 */
async function liveCommentTrigger(accountId: string, flowId: string, index: number): Promise<IgCommentTriggerConfig | null> {
  return worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ trigger_type: string; trigger_config: unknown; extra_triggers: unknown }[]>(Prisma.sql`
      SELECT v.trigger_type, v.trigger_config, v.extra_triggers FROM flows f
      JOIN flow_versions v ON v.account_id=f.account_id AND v.id=f.published_version_id AND v.flow_id=f.id
      WHERE f.account_id=${accountId}::uuid AND f.id=${flowId}::uuid AND f.status='active'
      UNION ALL
      SELECT f.trigger_type, f.trigger_config, f.extra_triggers FROM flows f
      WHERE f.account_id=${accountId}::uuid AND f.id=${flowId}::uuid AND f.status='draft' AND cardinality(f.test_usernames)>0`);
    const trigger = row ? effectiveTriggers(row)[index] : undefined;
    return trigger?.trigger_type === 'ig_comment' ? (trigger.config as unknown as IgCommentTriggerConfig) : null;
  });
}

export type PublicReplyOutcome = 'posted' | 'unknown' | 'rejected' | 'disabled' | 'unavailable';

/**
 * A public reply under the comment of `eventId`, at most once per comment
 * (dispatch key ig-comment-reply:<comment_id>); the trigger's rotated reply and
 * the "Reply to comment" step share it. The reply id is kept on the event,
 * never the text. Never replies to a comment by the account itself (those are
 * not recorded). Failure is the caller's to log: the flow carries on.
 */
export async function postCommentPublicReply(accountId: string, eventId: string, text: string): Promise<PublicReplyOutcome> {
  if (!instagramConfig()) return 'disabled';
  if (!UUID.test(accountId) || !UUID.test(eventId)) throw new Error('Invalid comment reply request');
  if (!validCommentReply(text)) return 'rejected';
  const target = await worker(accountId, async (tx) => {
    const [row] = await tx.$queryRaw<{ comment_id: string; public_reply_id: string | null; instagram_account_id: string;
      account_status: string; scopes: string[] | null; access_token_enc: string | null }[]>(Prisma.sql`
      SELECT e.comment_id, e.public_reply_id, e.instagram_account_id::text AS instagram_account_id, a.status AS account_status,
        a.scopes, a.access_token_enc
      FROM instagram_comment_events e JOIN instagram_accounts a ON a.account_id=e.account_id AND a.id=e.instagram_account_id
      WHERE e.account_id=${accountId}::uuid AND e.id=${eventId}::uuid`);
    return row ?? null;
  });
  if (!target) return 'unavailable';
  if (target.public_reply_id) return 'posted';
  if (target.account_status !== 'active' || !target.access_token_enc || missingScopes(target.scopes ?? [], 'comments').length)
    return 'unavailable';
  const tokenEnc = target.access_token_enc;
  const token = decrypt(tokenEnc);
  let replyId: string;
  try {
    ({ replyId } = await dispatchOnce(accountId, `ig-comment-reply:${target.comment_id}`, () => replyToComment(target.comment_id, token, text)));
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      console.error('[instagram] comment reply outcome unknown');
      return 'unknown';
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const code = metaErrorCode(error);
      console.error('[instagram] comment reply rejected', { code });
      if (isMetaTokenInvalid(error)) {
        await worker(accountId, (tx) => recordHealthTx(tx, accountId, target.instagram_account_id, tokenEnc, 'token_invalid',
          code && /^[0-9:]{1,32}$/.test(code) ? code : null));
      }
      return 'rejected';
    }
    throw error;
  }
  if (/^\d{1,32}$/.test(replyId)) {
    await worker(accountId, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET public_reply_id=${replyId}
      WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid AND public_reply_id IS NULL`);
  }
  return 'posted';
}

/** Records the commenter's opt-in tap (the "Opening DM" button) once. */
export async function recordCommentOptIn(accountId: string, eventId: string, runId: string): Promise<void> {
  if (![accountId, eventId, runId].every((id) => UUID.test(id))) return;
  await worker(accountId, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET opted_in_at=now()
    WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid AND flow_run_id=${runId}::uuid AND opted_in_at IS NULL`);
}
