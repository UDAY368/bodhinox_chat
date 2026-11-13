// ============================================================
// Instagram broadcasts (Campaigns redesign).
//
// Meta lets a business message an Instagram user only inside the 24-hour
// window that the user's own last message opened. An Instagram broadcast is
// therefore a free-text message to the contacts of an audience whose window
// is open now, sent right away (never scheduled: a window that is open now is
// usually closed by a later send time).
//
//   createInstagramBroadcast()  - validate, freeze recipients (each with the
//     Instagram conversation it goes through and its first name), insert the
//     campaign and its durable dispatch job in ONE transaction, return the id.
//   deliverInstagramBroadcast() - the worker pass: for every pending
//     recipient, load the conversation's send target, re-check consent and
//     the 24-hour window (closed -> failed, no intent), then send through
//     dispatchOnce under the recipient's broadcast intent key. An ambiguous
//     outcome flags the row uncertain for staff reconciliation; nothing is
//     resent blindly.
//
// The message text is never logged.
// ============================================================

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { requireWithinLimit } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import { requireCampaignSendRoom } from '@/lib/billing/limits';
import {
  checkInstagramText,
  loadInstagramTarget,
  sendInstagramText,
  storeInstagramSentMessage,
  type InstagramSendContext,
} from '@/lib/channels/sender';
import { InstagramError } from '@/lib/instagram/errors';
import { instagramConfig } from '@/lib/instagram/config';
import { STANDARD_WINDOW_MS } from '@/lib/instagram/window';
import { validInstagramText } from '@/lib/instagram/graph';
import { broadcastIntentKey, UNCERTAIN_SEND_MESSAGE } from '@/lib/whatsapp/broadcast-core';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { audienceSchema, audienceSource, CAMPAIGN_LIMITS } from './create-campaign';

export const INSTAGRAM_TEXT_MAX = 1000;
/** Recipients sent per worker pass; the handler queues the next pass for the rest. */
export const INSTAGRAM_PASS_MAX = 1000;
/** The personalisation token: replaced by each recipient's first name (frozen at creation). */
export const FIRST_NAME_TOKEN = '{first name}';

/** Failure reasons stored on a recipient (shown on the campaign page). */
export const IG_FAILURE = {
  windowClosed: 'Instagram 24-hour window closed before sending',
  noConversation: 'No Instagram conversation for this contact',
  optedOut: 'Contact opted out or is blocked',
  unavailable: 'Instagram account unavailable; reconnect it and use Retry failed',
  rejected: 'Instagram rejected the message',
} as const;

const audience = audienceSchema.superRefine((a, ctx) => {
  if (a.type === 'csv') ctx.addIssue({ code: 'custom', message: 'Instagram campaigns cannot use a CSV audience' });
});
const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  text: z.string().max(INSTAGRAM_TEXT_MAX),
  audience,
}).strict();
export type InstagramBroadcastInput = z.infer<typeof inputSchema>;

function invalid(message: string): never {
  throw new AuthError(message, 400, 'campaign_input');
}

/** The message a recipient gets: {first name} becomes their first name (or is dropped with its spacing when unknown). */
export function personalizeInstagramText(text: string, firstName: string | null | undefined): string {
  const name = (firstName ?? '').trim();
  if (name) return text.split(FIRST_NAME_TOKEN).join(name);
  return text.replace(/\s*\{first name\}/g, '').replace(/^[\s,]+/, '');
}

/** SQL for "the customer wrote on this Instagram conversation in the last 24 hours". */
const windowOpen = (accountId: string, conversation: Prisma.Sql) => Prisma.sql`EXISTS(SELECT 1 FROM messages m
  WHERE m.account_id=${accountId}::uuid AND m.conversation_id=${conversation} AND m.sender_type='customer'
    AND m.created_at > now() - interval '24 hours')`; // STANDARD_WINDOW_MS

/** The contact's Instagram conversation whose window is open (latest customer message first), or NULL. */
const openConversation = (accountId: string) => Prisma.sql`(SELECT cv.id FROM conversations cv
  WHERE cv.account_id=${accountId}::uuid AND cv.contact_id=c.id AND cv.channel='instagram' AND cv.instagram_account_id IS NOT NULL
    AND ${windowOpen(accountId, Prisma.sql`cv.id`)}
  ORDER BY (SELECT max(m.created_at) FROM messages m WHERE m.account_id=cv.account_id AND m.conversation_id=cv.id AND m.sender_type='customer') DESC NULLS LAST, cv.id
  LIMIT 1)`;

function parse(raw: unknown): InstagramBroadcastInput {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) invalid('Invalid Instagram campaign');
  return parsed.data;
}

async function assertMember(tx: TenantTransaction, scope: TenantContext): Promise<void> {
  const membership = await tx.$queryRaw<{ role: string }[]>`SELECT role FROM account_memberships
    WHERE account_id=${scope.accountId}::uuid AND user_id=${scope.userId}::uuid`;
  if (!membership[0] || !['agent', 'admin', 'owner'].includes(membership[0].role))
    throw new ForbiddenError('Campaign creation requires an active agent membership');
}

export interface InstagramAudienceCount {
  /** Contacts of the audience with an Instagram conversation (opted-out and blocked left out). */
  onInstagram: number;
  /** Of those, the ones whose 24-hour window is open now: who would get it. */
  eligible: number;
}

/** How many contacts an Instagram campaign would reach now. Read-only; CSV audiences are refused. */
export async function countInstagramAudience(scope: TenantContext, raw: unknown): Promise<InstagramAudienceCount> {
  const parsed = audience.safeParse((raw as { audience?: unknown } | null)?.audience);
  if (!parsed.success) invalid('Invalid audience');
  return withTenant(scope, async (tx) => {
    const { from, where } = await audienceSource(tx, scope, { audience: parsed.data }, 'instagram');
    const [row] = await tx.$queryRaw<{ on_instagram: number; eligible: number }[]>(Prisma.sql`
      SELECT count(*)::int AS on_instagram, count(*) FILTER (WHERE ${openConversation(scope.accountId)} IS NOT NULL)::int AS eligible
      FROM (SELECT c.* FROM ${from} WHERE ${where} LIMIT ${CAMPAIGN_LIMITS.recipients + 1}) c`);
    return { onInstagram: row?.on_instagram ?? 0, eligible: row?.eligible ?? 0 };
  }, getWorkerPrisma());
}

/**
 * Create an Instagram campaign and queue its first pass. Recipients are the
 * audience's contacts whose Instagram window is open now; each is frozen with
 * its conversation and first name.
 */
export async function createInstagramBroadcast(scope: TenantContext, raw: unknown): Promise<{ id: string; recipients: number }> {
  if (!scope.userId || !scope.role || !hasMinRole(scope.role, 'agent')) throw new ForbiddenError('Campaign creation requires an agent role');
  const input = parse(raw);
  const text = input.text.trim();
  if (!text) invalid('Write the message');
  // The longest a personalised message can get still has to fit Instagram's limit.
  if (!validInstagramText(personalizeInstagramText(text, 'x'.repeat(40)))) invalid('The message is too long for Instagram');
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  return withTenant(scope, async (tx) => {
    await assertMember(tx, scope);
    await requireSendingAllowed(tx, scope.accountId);
    const { from, where, order } = await audienceSource(tx, scope, { audience: input.audience }, 'instagram');
    const { csvContacts: _csv, ...audienceFilter } = input.audience;
    void _csv;
    const [created] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,
        audience_filter,status,total_recipients,channel,message_text)
      VALUES(${scope.accountId}::uuid,${scope.userId}::uuid,${input.name},'','en_US',${JSON.stringify(audienceFilter)}::jsonb,'sending',0,'instagram',${text})
      RETURNING id::text AS id`;
    const id = created.id;
    const total = await tx.$executeRaw(Prisma.sql`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params,conversation_id)
      SELECT ${scope.accountId}::uuid,${id}::uuid,c.id,'pending',jsonb_build_array(left(split_part(btrim(COALESCE(c.name,'')),' ',1),60)),w.conversation_id
      FROM ${from} CROSS JOIN LATERAL (SELECT ${openConversation(scope.accountId)} AS conversation_id) w
      WHERE ${where} AND w.conversation_id IS NOT NULL
      ORDER BY ${order} LIMIT ${CAMPAIGN_LIMITS.recipients + 1}`);
    if (!total) invalid('Nobody in this audience wrote to you on Instagram in the last 24 hours');
    if (total > CAMPAIGN_LIMITS.recipients) invalid(`Campaigns support at most ${CAMPAIGN_LIMITS.recipients.toLocaleString('en')} recipients`);
    await requireWithinLimit(tx, scope.accountId, 'campaign_recipients', total);
    await requireCampaignSendRoom(tx, scope.accountId, total);
    await tx.$executeRaw`UPDATE broadcasts SET total_recipients=${total} WHERE account_id=${scope.accountId}::uuid AND id=${id}::uuid`;
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES('broadcast.dispatch',${scope.accountId}::uuid,${JSON.stringify({ broadcastId: id, scope: 'pending' })}::jsonb,${`broadcast:${id}:initial`})`;
    return { id, recipients: total };
  }, getWorkerPrisma());
}

/** 'instagram' or 'whatsapp' (also for an unknown id, so the WhatsApp path keeps its own errors). */
export async function broadcastChannel(accountId: string, broadcastId: string): Promise<'whatsapp' | 'instagram'> {
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ channel: string }[]>`
    SELECT channel FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`, getWorkerPrisma());
  return rows[0]?.channel === 'instagram' ? 'instagram' : 'whatsapp';
}

interface PendingRow {
  id: string;
  conversation_id: string | null;
  template_params: unknown;
  retry_generation: number;
  opted_out: boolean;
}

export interface InstagramPassResult {
  sent: number;
  failed: number;
  /** In-scope recipients beyond this pass. */
  remaining: number;
  /** A member paused the campaign mid-pass. */
  stopped: boolean;
}

const tenant = <T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>) =>
  withTenant({ accountId, role: 'owner' }, work, getWorkerPrisma());

/** Never downgrades a row another pass already marked sent. */
async function markFailed(accountId: string, rowId: string, reason: string, uncertain: boolean): Promise<void> {
  await tenant(accountId, (tx) => tx.$executeRaw`UPDATE broadcast_recipients SET status='failed', error_message=${reason},
      outcome_uncertain_at=${uncertain ? new Date() : null}
    WHERE account_id=${accountId}::uuid AND id=${rowId}::uuid AND status<>'sent'`);
}

/**
 * One worker pass of an Instagram campaign. `scope` 'pending' sends the rows
 * not yet tried; 'failed' / 'all' also retry failed rows (never the uncertain
 * ones). Status counts stay trigger-owned; the caller finalises the status.
 */
export async function deliverInstagramBroadcast(accountId: string, broadcastId: string, scope: 'pending' | 'failed' | 'all', options: {
  assertLease: () => void;
  shouldStop?: () => Promise<boolean>;
  /** Pause between sends (ms); 0 in tests. */
  paceMs?: number;
}): Promise<InstagramPassResult> {
  const statuses = scope === 'pending' ? ['pending'] : scope === 'failed' ? ['failed'] : ['pending', 'failed'];
  const { text, rows, inScope } = await tenant(accountId, async (tx) => {
    const [b] = await tx.$queryRaw<{ message_text: string | null; channel: string }[]>`
      SELECT message_text, channel FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`;
    if (!b || b.channel !== 'instagram') return { text: null, rows: [] as PendingRow[], inScope: 0 };
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM broadcast_recipients
      WHERE account_id=${accountId}::uuid AND broadcast_id=${broadcastId}::uuid AND status = ANY(${statuses}::text[]) AND outcome_uncertain_at IS NULL`;
    const rows = await tx.$queryRaw<PendingRow[]>`SELECT r.id::text AS id, r.conversation_id::text AS conversation_id, r.template_params, r.retry_generation,
        (c.id IS NULL OR c.opted_out_at IS NOT NULL OR c.instagram_opted_out_at IS NOT NULL OR c.blocked_at IS NOT NULL) AS opted_out
      FROM broadcast_recipients r LEFT JOIN contacts c ON c.account_id=r.account_id AND c.id=r.contact_id
      WHERE r.account_id=${accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid AND r.status = ANY(${statuses}::text[]) AND r.outcome_uncertain_at IS NULL
      ORDER BY r.created_at ASC, r.id ASC LIMIT ${INSTAGRAM_PASS_MAX}`;
    return { text: b.message_text, rows, inScope: n };
  });
  const result: InstagramPassResult = { sent: 0, failed: 0, remaining: Math.max(0, inScope - rows.length), stopped: false };
  if (!text) return result;
  const pace = options.paceMs ?? 150;

  for (const [index, row] of rows.entries()) {
    if (options.shouldStop && index % 10 === 0 && await options.shouldStop()) {
      result.stopped = true;
      result.remaining += rows.length - index;
      return result;
    }
    // Outside the try: a lost lease aborts the pass and leaves recipients pending, not failed.
    options.assertLease();
    if (pace) await new Promise((resolve) => setTimeout(resolve, pace));
    const fail = async (reason: string, uncertain = false) => {
      await markFailed(accountId, row.id, reason, uncertain);
      result.failed++;
    };
    if (row.opted_out) { await fail(IG_FAILURE.optedOut); continue; }
    if (!row.conversation_id) { await fail(IG_FAILURE.noConversation); continue; }
    const firstName = Array.isArray(row.template_params) && typeof row.template_params[0] === 'string' ? row.template_params[0] : null;
    const message = personalizeInstagramText(text, firstName);
    const ctx: InstagramSendContext = { sender: 'automated', now: new Date() };
    const conversationId = row.conversation_id;

    // Target, window and content are checked before any intent exists, so a refusal never leaves one behind.
    let target;
    try {
      target = await tenant(accountId, (tx) => loadInstagramTarget(tx, accountId, conversationId));
      // Broadcasts use the standard 24-hour window only (no ad or Human Agent extension).
      const last = target.lastCustomerAt?.getTime() ?? NaN;
      if (!(Number.isFinite(last) && ctx.now.getTime() - last < STANDARD_WINDOW_MS)) throw new InstagramError('instagram_window_closed');
      checkInstagramText(target, message, ctx);
    } catch (error) {
      if (!(error instanceof InstagramError)) throw error;
      await fail(error.code === 'instagram_window_closed' ? IG_FAILURE.windowClosed
        : error.code === 'contact_blocked' ? IG_FAILURE.optedOut
          : error.code === 'not_found' || error.code === 'channel_not_supported' ? IG_FAILURE.noConversation
            : IG_FAILURE.unavailable);
      continue;
    }
    const sendTarget = target;
    let mid: string | null;
    try {
      const sent = await dispatchOnce(accountId, broadcastIntentKey(broadcastId, row.id, 'ig', row.retry_generation),
        () => sendInstagramText(sendTarget, message, ctx), { retryRejected: true });
      // An intent staff reconciled as sent carries no provider result.
      mid = sent?.messageId ?? null;
    } catch (error) {
      if (error instanceof UncertainDispatchError) { await fail(UNCERTAIN_SEND_MESSAGE, true); continue; }
      // Meta refused it (4xx) or a local check refused it before Meta: nothing went out.
      if (error instanceof MetaApiError || error instanceof InstagramError || (error instanceof Error && error.name === 'InstagramGraphInputError')) {
        await fail(IG_FAILURE.rejected);
        continue;
      }
      throw error;
    }
    // After a send, a storage failure throws (the job retries; the accepted intent replays, never resends).
    if (mid) {
      const sentMid = mid;
      await tenant(accountId, async (tx) => {
        await storeInstagramSentMessage(tx, { accountId, conversationId, senderType: 'bot', senderId: null, contentType: 'text',
          contentText: message, interactivePayload: { broadcast_id: broadcastId }, messageId: sentMid });
        await tx.$executeRaw`UPDATE conversations SET last_message_text=${message}, last_message_at=now(), updated_at=now()
          WHERE account_id=${accountId}::uuid AND id=${conversationId}::uuid`;
      });
    }
    await tenant(accountId, (tx) => tx.$executeRaw`UPDATE broadcast_recipients SET status='sent', sent_at=COALESCE(sent_at, now()),
        whatsapp_message_id=COALESCE(${mid}, whatsapp_message_id), error_message=NULL, outcome_uncertain_at=NULL
      WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`);
    result.sent++;
  }
  return result;
}
