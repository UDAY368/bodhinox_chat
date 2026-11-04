// Instagram comment private replies (Phase 11, design section 6).
//
// The webhook processor (process-webhook.ts) records each comment once in
// instagram_comment_events (UNIQUE (instagram_account_id, comment_id)), matches
// an active comment rule and queues this job with { eventId } when one matched
// (status 'queued'). This job sends that rule's text as ONE private reply:
//   - only while the event is still 'queued' and the comment is at most 7 days
//     old (else 'expired');
//   - through dispatchOnce('ig_private_reply:<comment_id>'), so an ambiguous
//     outcome is recorded as 'unknown' and never sent again automatically;
//   - under Meta's 750 private replies per hour per professional account: at 700
//     sent/unknown in the last hour the job is queued again later (no counter
//     columns; the partial index instagram_comment_events_rate_idx serves the count).
// Nothing runs while Instagram is off (instagramConfig() === null). No comment
// text, token or Meta message is logged.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { instagramConfig, missingScopes } from './config';
import { recordHealthTx } from './health';
import { isMetaThrottle, isMetaTokenInvalid, metaErrorCode, sendPrivateReply, validInstagramText } from './graph';
import { INSTAGRAM_PRIVATE_REPLY_JOB } from './jobs';

/** (unconfirmed) Meta allows a private reply within 7 days of the comment; the live check confirms it. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Meta's documented limit is 750 per hour per professional account; we stop short of it. */
export const PRIVATE_REPLY_HOURLY_GUARD = 700;
/** How long a rate-limited or throttled reply waits before the job tries again. */
export const PRIVATE_REPLY_RETRY_MS = 10 * 60 * 1000;

export type PrivateReplyOutcome =
  | 'disabled' | 'noop' | 'sent' | 'unknown' | 'expired' | 'rejected' | 'no_rule' | 'rate_limited' | 'throttled';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EventRow {
  comment_id: string;
  received_at: Date;
  status: string;
  instagram_account_id: string;
  reply_text: string | null;
  rule_active: boolean | null;
  ig_user_id: string;
  account_status: string;
  scopes: string[] | null;
  access_token_enc: string | null;
  contact_blocked: boolean;
}

type Plan =
  | { kind: 'done'; outcome: PrivateReplyOutcome }
  | { kind: 'send'; commentId: string; igUserId: string; instagramAccountId: string; tokenEnc: string; text: string };

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

/** The instagram.private_reply job: { eventId }. */
export async function handlePrivateReplyJob(accountId: string, payload: Record<string, unknown>,
  attempt?: { attempts: number; maxAttempts: number }): Promise<void> {
  void attempt;
  await runPrivateReply(accountId, payload);
}

export async function runPrivateReply(accountId: string, payload: Record<string, unknown>,
  now: Date = new Date()): Promise<PrivateReplyOutcome> {
  if (!instagramConfig()) return 'disabled';
  const eventId = payload.eventId;
  if (typeof eventId !== 'string' || !UUID.test(eventId) || !UUID.test(accountId)) throw new Error('Invalid private reply job');

  const plan = await worker(accountId, async (tx): Promise<Plan> => {
    const [row] = await tx.$queryRaw<EventRow[]>(Prisma.sql`
      SELECT e.comment_id, e.received_at, e.private_reply_status AS status, e.instagram_account_id::text AS instagram_account_id,
        r.reply_text, r.active AS rule_active, a.ig_user_id, a.status AS account_status, a.scopes, a.access_token_enc,
        (ct.blocked_at IS NOT NULL) AS contact_blocked
      FROM instagram_comment_events e
      JOIN instagram_accounts a ON a.account_id=e.account_id AND a.id=e.instagram_account_id
      LEFT JOIN instagram_comment_rules r ON r.account_id=e.account_id AND r.id=e.rule_id
      LEFT JOIN contact_channel_identities i ON i.account_id=e.account_id AND i.instagram_account_id=e.instagram_account_id
        AND i.external_id=e.from_igsid
      LEFT JOIN contacts ct ON ct.account_id=i.account_id AND ct.id=i.contact_id
      WHERE e.account_id=${accountId}::uuid AND e.id=${eventId}::uuid
      FOR UPDATE OF e`);
    if (!row || row.status !== 'queued') return { kind: 'done', outcome: 'noop' };
    const mark = async (status: 'expired' | 'rejected' | 'no_rule') => {
      await tx.$executeRaw`UPDATE instagram_comment_events SET private_reply_status=${status}
        WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid`;
      return { kind: 'done' as const, outcome: status };
    };
    if (now.getTime() - new Date(row.received_at).getTime() > PRIVATE_REPLY_WINDOW_MS) return mark('expired');
    // The rule was deleted or switched off after the comment matched it.
    if (!row.reply_text || row.rule_active === false) return mark('no_rule');
    if (!validInstagramText(row.reply_text)) return mark('rejected');
    // Like every other Instagram send path: a contact the business blocked (even after the comment was queued) gets no DM.
    if (row.contact_blocked) return mark('rejected');
    if (row.account_status !== 'active' || !row.access_token_enc || missingScopes(row.scopes ?? [], 'comments').length)
      return mark('rejected');
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM instagram_comment_events
      WHERE account_id=${accountId}::uuid AND instagram_account_id=${row.instagram_account_id}::uuid
        AND private_reply_status IN ('sent','unknown') AND private_reply_at > ${now}::timestamptz - interval '1 hour'`;
    if (n >= PRIVATE_REPLY_HOURLY_GUARD) {
      await requeue(tx, accountId, eventId, 'rate', now);
      return { kind: 'done', outcome: 'rate_limited' };
    }
    return {
      kind: 'send', commentId: row.comment_id, igUserId: row.ig_user_id, instagramAccountId: row.instagram_account_id,
      tokenEnc: row.access_token_enc, text: row.reply_text,
    };
  });
  if (plan.kind === 'done') return plan.outcome;

  // Decrypt before the intent exists: a failure here is not a provider outcome.
  const token = decrypt(plan.tokenEnc);
  try {
    // A queued event with a 'failed' intent was rejected by Meta (only a throttle
    // leaves the event queued) or the worker crashed before recording the
    // rejection: nothing was delivered, so claiming it again is safe. An
    // 'unknown' or 'accepted' intent is never re-sent.
    await dispatchOnce(accountId, `ig_private_reply:${plan.commentId}`,
      () => sendPrivateReply(plan.igUserId, token, plan.commentId, plan.text), { retryRejected: true });
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      console.error('[instagram] private reply outcome unknown');
      await settle(accountId, eventId, 'unknown', now);
      return 'unknown';
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const code = metaErrorCode(error);
      console.error('[instagram] private reply rejected', { code });
      if (isMetaThrottle(error)) {
        await worker(accountId, (tx) => requeue(tx, accountId, eventId, 'throttle', now));
        return 'throttled';
      }
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
