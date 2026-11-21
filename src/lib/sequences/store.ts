// Sequences (Stage 5, 5H; WhatsApp and "Exit when" in batch 7): what members
// read and change.
//
// Every query runs in the member's tenant transaction, so RLS confines it to
// the workspace and refuses writes below the agent role. An Instagram sequence
// message is an Instagram automation (a flow of the same workspace) the worker
// starts when it falls due; a WhatsApp message is its own text and/or media,
// plus an optional approved template sent instead when the contact's 24-hour
// window is closed (worker.ts). Instagram sequences are refused while
// Instagram is off; WhatsApp sequences always work. The channel can change
// only while the sequence has no messages. Message positions stay 0..n-1: a
// reorder or a removal rewrites them in one transaction (the unique key is
// checked at commit).
import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { instagramConfig } from '@/lib/instagram/config';
import { InstagramError } from '@/lib/instagram/errors';
import {
  STAGE5_LIMITS,
  type SequenceDelayUnit,
  type SequenceStatus,
  type SequenceSubscriptionStatus,
} from '@/types';
import { delayMs, dueAt, parseDelay, ratePercent, reorderPositions, type SequenceDelay } from './schedule';
import { subscribeInTx, unsubscribeInTx } from './subscriptions';
import { loadStepTemplate, stepTemplateRefusal } from './templates';
import {
  parseExitPatch,
  parseWhatsAppStep,
  SEQUENCE_CHANNELS,
  type ExitSettings,
  type SequenceChannel,
  type SubscriptionEndReason,
  type WaMediaType,
  type WhatsAppStep,
} from './whatsapp';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SEQUENCE_WRITE_LIMIT = { limit: 60, windowMs: 60_000 };
export const sequenceHeaders = { 'Cache-Control': 'private, no-store' };

/** Codes match Instagram.sequences.errors.*; the client maps them to text. */
export type SequenceErrorCode = 'invalid_request' | 'notFound' | 'tooManyMessages' | 'flowNotFound' | 'busy' | 'forbidden'
  | 'channelLocked' | 'tagNotFound' | 'templateNotFound' | 'templateUnusable';

export class SequenceError extends Error {
  constructor(readonly code: SequenceErrorCode, readonly status: 400 | 403 | 404 | 409) {
    super(code);
    this.name = 'SequenceError';
  }
}

export function sequenceErrorResponse(error: unknown): NextResponse {
  if (error instanceof SequenceError || error instanceof InstagramError)
    return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: sequenceHeaders });
  // RLS refused the write (a viewer, or a session whose role changed).
  const code = (error as { code?: string; meta?: { code?: string } } | null)?.meta?.code ?? (error as { code?: string } | null)?.code;
  if (code === '42501') return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: sequenceHeaders });
  return toErrorResponse(error);
}

/** Instagram sequences are refused while Instagram is off. */
export function requireInstagram(): void {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
}

/** The channels whose sequences members see right now (WhatsApp always; Instagram while it is on). */
function visibleChannels(): SequenceChannel[] {
  return instagramConfig() ? [...SEQUENCE_CHANNELS] : ['whatsapp'];
}

const invalid = () => new SequenceError('invalid_request', 400);
const notFound = () => new SequenceError('notFound', 404);
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function assertId(id: string): void {
  if (!UUID.test(id)) throw notFound();
}

// ------------------------------------------------------------------ types

export interface SequenceStats { sent: number; clicks: number; open_rate: number | null; ctr: number | null }

export interface SequenceSummary extends SequenceStats, ExitSettings {
  id: string;
  name: string;
  channel: SequenceChannel;
  status: SequenceStatus;
  subscribers: number;
  messages: number;
  created_at: string;
  updated_at: string;
}

export interface SequenceMessageView extends SequenceStats {
  id: string;
  position: number;
  delay_amount: number;
  delay_unit: SequenceDelayUnit;
  active: boolean;
  flow_id: string | null;
  flow_name: string | null;
  /** The message's automation status (draft, active, paused, archived); null when it was removed. */
  flow_status: string | null;
  /** WhatsApp steps: the message, and the template sent when the 24-hour window is closed. */
  wa_text: string | null;
  wa_media_type: WaMediaType | null;
  wa_media_url: string | null;
  wa_media_filename: string | null;
  template_name: string | null;
  template_language: string | null;
  template_params: string[];
  /** Times this step was skipped: outside the 24-hour window with no template. */
  skipped_no_template: number;
}

export interface SequenceDetail extends SequenceSummary { items: SequenceMessageView[] }

export interface SequenceSubscriber {
  contact_id: string;
  name: string | null;
  status: SequenceSubscriptionStatus;
  subscribed_at: string;
  next_due_at: string | null;
  /** Why "Exit when" or consent stopped them; null otherwise. */
  exit_reason: SubscriptionEndReason | null;
}

// ------------------------------------------------------------------ input

export function parseName(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  const name = value.trim();
  if (!name || name.length > STAGE5_LIMITS.sequenceNameChars) throw invalid();
  return name;
}

export type SequencePatch = { name?: string; status?: 'active' | 'paused'; channel?: SequenceChannel } & Partial<ExitSettings>;

const PATCH_KEYS = ['name', 'status', 'channel', 'exit_on_reply', 'exit_on_tag_id', 'exit_on_purchase'];

export function parseChannel(value: unknown): SequenceChannel {
  if (typeof value !== 'string' || !(SEQUENCE_CHANNELS as readonly string[]).includes(value)) throw invalid();
  return value as SequenceChannel;
}

export function parseSequencePatch(body: unknown): SequencePatch {
  if (!isObject(body)) throw invalid();
  for (const key of Object.keys(body)) if (!PATCH_KEYS.includes(key)) throw invalid();
  const exit = parseExitPatch(body);
  if (!exit) throw invalid();
  const patch: SequencePatch = { ...exit };
  if ('name' in body) patch.name = parseName(body.name);
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'paused') throw invalid();
    patch.status = body.status;
  }
  if ('channel' in body) patch.channel = parseChannel(body.channel);
  if (!Object.keys(patch).length) throw invalid();
  return patch;
}

/**
 * POST /messages: on Instagram an existing automation or a new draft one with
 * this name; on WhatsApp the step itself ({ whatsapp: { text?, media?, template? } })
 * and, optionally, when it is sent (delay_amount + delay_unit).
 */
export type MessageCreate = { kind: 'existing'; flowId: string } | { kind: 'new'; name: string }
  | { kind: 'whatsapp'; step: WhatsAppStep; delay?: SequenceDelay };

function parseStep(value: unknown): WhatsAppStep {
  const step = parseWhatsAppStep(value);
  if (!step) throw invalid();
  return step;
}

export function parseMessageCreate(body: unknown): MessageCreate {
  if (!isObject(body)) throw invalid();
  const keys = Object.keys(body);
  if ('whatsapp' in body) {
    if (keys.some((key) => !['whatsapp', 'delay_amount', 'delay_unit'].includes(key))) throw invalid();
    if (!('delay_amount' in body) && !('delay_unit' in body)) return { kind: 'whatsapp', step: parseStep(body.whatsapp) };
    const delay = parseDelay(body.delay_amount, body.delay_unit);
    if (!delay) throw invalid();
    return { kind: 'whatsapp', step: parseStep(body.whatsapp), delay };
  }
  if (typeof body.flow_id === 'string' && UUID.test(body.flow_id) && !('create' in body)) return { kind: 'existing', flowId: body.flow_id };
  if (isObject(body.create) && !('flow_id' in body)) return { kind: 'new', name: parseName(body.create.name) };
  throw invalid();
}

export type MessagePatch = { delay?: SequenceDelay; active?: boolean; flowId?: string; whatsapp?: WhatsAppStep };

export function parseMessagePatch(body: unknown): MessagePatch {
  if (!isObject(body)) throw invalid();
  const patch: MessagePatch = {};
  for (const key of Object.keys(body))
    if (!['delay_amount', 'delay_unit', 'active', 'flow_id', 'whatsapp'].includes(key)) throw invalid();
  if ('delay_amount' in body || 'delay_unit' in body) {
    const delay = parseDelay(body.delay_amount, body.delay_unit);
    if (!delay) throw invalid();
    patch.delay = delay;
  }
  if ('active' in body) {
    if (typeof body.active !== 'boolean') throw invalid();
    patch.active = body.active;
  }
  if ('flow_id' in body) {
    if (typeof body.flow_id !== 'string' || !UUID.test(body.flow_id)) throw invalid();
    patch.flowId = body.flow_id;
  }
  if ('whatsapp' in body) patch.whatsapp = parseStep(body.whatsapp);
  if (patch.flowId && patch.whatsapp) throw invalid();
  if (!patch.delay && patch.active === undefined && !patch.flowId && !patch.whatsapp) throw invalid();
  return patch;
}

export type SubscriberAction = { action: 'subscribe' | 'unsubscribe'; contactId: string };

export function parseSubscriberAction(body: unknown): SubscriberAction {
  if (!isObject(body) || (body.action !== 'subscribe' && body.action !== 'unsubscribe')
    || typeof body.contact_id !== 'string' || !UUID.test(body.contact_id)) throw invalid();
  return { action: body.action, contactId: body.contact_id };
}

// ------------------------------------------------------------------ reads

interface StatsRow { sent: number; clicks: number; linked: number; opened: number; skipped_no_template: number }
const toStats = (row: StatsRow | undefined): SequenceStats => ({
  sent: row?.sent ?? 0,
  clicks: row?.clicks ?? 0,
  open_rate: ratePercent(row?.opened ?? 0, row?.sent ?? 0),
  // A message that never carried a tracked link has no CTR (a dash, not 0%).
  ctr: ratePercent(row?.clicks ?? 0, row?.linked ?? 0),
});

/**
 * Delivery stats of sent messages, grouped by `groupBy`. A click is a tracked
 * link of the message's run that was opened; "opened" is a read receipt where
 * the channel reports one, or the person writing back within a day (Instagram
 * does not report reads to Bodhinox).
 */
function statsSql(accountId: string, groupBy: 'sequence_id' | 'sequence_message_id', sequenceId: string | null): Prisma.Sql {
  return Prisma.sql`
    SELECT s.${Prisma.raw(groupBy)}::text AS key,
      count(*) FILTER (WHERE s.status = 'sent')::int AS sent,
      count(*) FILTER (WHERE s.status = 'sent' AND EXISTS (SELECT 1 FROM flow_tracked_links l WHERE l.account_id = s.account_id
        AND l.flow_run_id = s.flow_run_id AND l.click_count > 0))::int AS clicks,
      count(*) FILTER (WHERE s.status = 'sent' AND EXISTS (SELECT 1 FROM flow_tracked_links l WHERE l.account_id = s.account_id
        AND l.flow_run_id = s.flow_run_id))::int AS linked,
      count(*) FILTER (WHERE s.status = 'sent' AND EXISTS (SELECT 1 FROM messages x WHERE x.account_id = s.account_id
        AND x.conversation_id = s.conversation_id
        AND x.created_at >= s.created_at AND x.created_at < s.created_at + interval '1 day'
        AND (x.sender_type = 'customer' OR (x.sender_type = 'bot' AND x.status = 'read'))))::int AS opened,
      count(*) FILTER (WHERE s.status = 'skipped' AND s.reason = 'outside_window_no_template')::int AS skipped_no_template
    FROM sequence_message_sends s
    WHERE s.account_id = ${accountId}::uuid AND (s.status = 'sent' OR (s.status = 'skipped' AND s.reason = 'outside_window_no_template'))
      ${sequenceId ? Prisma.sql`AND s.sequence_id = ${sequenceId}::uuid` : Prisma.empty}
    GROUP BY 1`;
}

interface SummaryRow extends ExitSettings {
  id: string; name: string; channel: SequenceChannel; status: SequenceStatus; subscribers: number; messages: number;
  created_at: Date; updated_at: Date;
}

const SUMMARY = (accountId: string) => Prisma.sql`
  SELECT q.id::text AS id, q.name, q.channel, q.status, q.created_at, q.updated_at,
    q.exit_on_reply, q.exit_on_tag_id::text AS exit_on_tag_id, q.exit_on_purchase,
    (SELECT count(*) FROM sequence_subscriptions s WHERE s.account_id = q.account_id AND s.sequence_id = q.id
       AND s.status IN ('active','sending'))::int AS subscribers,
    (SELECT count(*) FROM sequence_messages m WHERE m.account_id = q.account_id AND m.sequence_id = q.id)::int AS messages
  FROM sequences q
  WHERE q.account_id = ${accountId}::uuid AND q.channel = ANY(${visibleChannels()}::text[]) AND q.status <> 'archived'`;

const toSummary = (row: SummaryRow, stats: StatsRow | undefined): SequenceSummary => ({
  id: row.id, name: row.name, channel: row.channel, status: row.status, subscribers: row.subscribers, messages: row.messages,
  exit_on_reply: row.exit_on_reply, exit_on_tag_id: row.exit_on_tag_id, exit_on_purchase: row.exit_on_purchase,
  created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(), ...toStats(stats),
});

export async function listSequences(ctx: TenantContext): Promise<SequenceSummary[]> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<SummaryRow[]>(Prisma.sql`${SUMMARY(ctx.accountId)} ORDER BY q.created_at DESC, q.id LIMIT 200`);
    const stats = await tx.$queryRaw<(StatsRow & { key: string })[]>(statsSql(ctx.accountId, 'sequence_id', null));
    const byId = new Map(stats.map((s) => [s.key, s]));
    return rows.map((row) => toSummary(row, byId.get(row.id)));
  });
}

async function loadDetail(tx: TenantTransaction, accountId: string, id: string): Promise<SequenceDetail> {
  const [row] = await tx.$queryRaw<SummaryRow[]>(Prisma.sql`${SUMMARY(accountId)} AND q.id = ${id}::uuid`);
  if (!row) throw notFound();
  const items = await tx.$queryRaw<(Omit<SequenceMessageView, keyof SequenceStats | 'skipped_no_template'>)[]>`
    SELECT m.id::text AS id, m.position, m.delay_amount, m.delay_unit, m.active, m.flow_id::text AS flow_id,
      f.name AS flow_name, f.status AS flow_status, m.wa_text, m.wa_media_type, m.wa_media_url, m.wa_media_filename,
      m.template_name, m.template_language, m.template_params
    FROM sequence_messages m
    LEFT JOIN flows f ON f.account_id = m.account_id AND f.id = m.flow_id
    WHERE m.account_id = ${accountId}::uuid AND m.sequence_id = ${id}::uuid
    ORDER BY m.position`;
  const stats = await tx.$queryRaw<(StatsRow & { key: string })[]>(statsSql(accountId, 'sequence_message_id', id));
  const byMessage = new Map(stats.map((s) => [s.key, s]));
  const total = stats.reduce<StatsRow>((sum, s) => ({
    sent: sum.sent + s.sent, clicks: sum.clicks + s.clicks, linked: sum.linked + s.linked, opened: sum.opened + s.opened,
    skipped_no_template: sum.skipped_no_template + s.skipped_no_template,
  }), { sent: 0, clicks: 0, linked: 0, opened: 0, skipped_no_template: 0 });
  return {
    ...toSummary(row, total),
    items: items.map((item) => ({
      ...item, ...toStats(byMessage.get(item.id)), skipped_no_template: byMessage.get(item.id)?.skipped_no_template ?? 0,
    })),
  };
}

export async function getSequence(ctx: TenantContext, id: string): Promise<SequenceDetail> {
  assertId(id);
  return withTenant(ctx, (tx) => loadDetail(tx, ctx.accountId, id));
}

export async function listSubscribers(ctx: TenantContext, id: string): Promise<SequenceSubscriber[]> {
  assertId(id);
  return withTenant(ctx, async (tx) => {
    await lockSequence(tx, ctx.accountId, id, false);
    const rows = await tx.$queryRaw<(Omit<SequenceSubscriber, 'subscribed_at' | 'next_due_at'> & { subscribed_at: Date; next_due_at: Date | null })[]>`
      SELECT s.contact_id::text AS contact_id, c.name, s.status, s.subscribed_at, s.next_due_at, s.exit_reason
      FROM sequence_subscriptions s
      JOIN contacts c ON c.account_id = s.account_id AND c.id = s.contact_id
      WHERE s.account_id = ${ctx.accountId}::uuid AND s.sequence_id = ${id}::uuid
      ORDER BY (s.status IN ('active','sending')) DESC, s.subscribed_at DESC
      LIMIT 200`;
    return rows.map((r) => ({
      ...r, subscribed_at: r.subscribed_at.toISOString(), next_due_at: r.next_due_at ? r.next_due_at.toISOString() : null,
    }));
  });
}

// ----------------------------------------------------------------- writes

/**
 * The sequence row (locked for a write so concurrent message edits queue), or
 * not-found. An Instagram sequence is refused while Instagram is off.
 */
async function lockSequence(tx: TenantTransaction, accountId: string, id: string, forUpdate = true):
  Promise<{ status: SequenceStatus; channel: SequenceChannel }> {
  const rows = await tx.$queryRaw<{ status: SequenceStatus; channel: SequenceChannel }[]>(Prisma.sql`
    SELECT status, channel FROM sequences WHERE account_id = ${accountId}::uuid AND id = ${id}::uuid
      AND status <> 'archived' ${forUpdate ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
  if (!rows.length) throw notFound();
  if (rows[0].channel === 'instagram') requireInstagram();
  return rows[0];
}

export async function createSequence(ctx: TenantContext, name: string, channel: SequenceChannel = 'instagram'): Promise<SequenceDetail> {
  if (channel === 'instagram') requireInstagram();
  return withTenant(ctx, async (tx) => {
    // New sequences send as soon as they have live messages and subscribers; Pause holds them.
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO sequences(account_id, channel, name, status, created_by)
      VALUES(${ctx.accountId}::uuid, ${channel}, ${name}, 'active', ${ctx.userId ?? null}::uuid)
      RETURNING id::text AS id`;
    return loadDetail(tx, ctx.accountId, row.id);
  });
}

async function messageCount(tx: TenantTransaction, accountId: string, id: string): Promise<number> {
  const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM sequence_messages WHERE account_id = ${accountId}::uuid AND sequence_id = ${id}::uuid`;
  return count;
}

export async function updateSequence(ctx: TenantContext, id: string, patch: SequencePatch): Promise<SequenceDetail> {
  assertId(id);
  return withTenant(ctx, async (tx) => {
    const current = await lockSequence(tx, ctx.accountId, id);
    // The steps of the two channels differ (an automation vs. a message), so the channel changes only while there are none.
    if (patch.channel && patch.channel !== current.channel) {
      if (patch.channel === 'instagram') requireInstagram();
      if (await messageCount(tx, ctx.accountId, id) > 0) throw new SequenceError('channelLocked', 409);
    }
    if (patch.exit_on_tag_id) {
      const [tag] = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT true AS ok FROM tags WHERE account_id = ${ctx.accountId}::uuid AND id = ${patch.exit_on_tag_id}::uuid`;
      if (!tag) throw new SequenceError('tagNotFound', 404);
    }
    const clearTag = patch.exit_on_tag_id === null;
    await tx.$executeRaw`UPDATE sequences SET
        name = COALESCE(${patch.name ?? null}::text, name),
        status = COALESCE(${patch.status ?? null}::text, status),
        channel = COALESCE(${patch.channel ?? null}::text, channel),
        exit_on_reply = COALESCE(${patch.exit_on_reply ?? null}::boolean, exit_on_reply),
        exit_on_purchase = COALESCE(${patch.exit_on_purchase ?? null}::boolean, exit_on_purchase),
        exit_on_tag_id = CASE WHEN ${clearTag} THEN NULL ELSE COALESCE(${patch.exit_on_tag_id ?? null}::uuid, exit_on_tag_id) END
      WHERE account_id = ${ctx.accountId}::uuid AND id = ${id}::uuid`;
    return loadDetail(tx, ctx.accountId, id);
  });
}

/** Archive: the sequence leaves the list and every subscription ends at once (nothing more is sent). */
export async function archiveSequence(ctx: TenantContext, id: string): Promise<void> {
  assertId(id);
  await withTenant(ctx, async (tx) => {
    await lockSequence(tx, ctx.accountId, id);
    await tx.$executeRaw`UPDATE sequence_subscriptions SET status = 'unsubscribed', ended_at = now(), next_due_at = NULL
      WHERE account_id = ${ctx.accountId}::uuid AND sequence_id = ${id}::uuid AND status IN ('active','sending')`;
    await tx.$executeRaw`UPDATE sequences SET status = 'archived' WHERE account_id = ${ctx.accountId}::uuid AND id = ${id}::uuid`;
  });
}

/** The automation must be an Instagram (or legacy both-channel) flow of this workspace that is not archived. */
async function assertMessageFlow(tx: TenantTransaction, accountId: string, flowId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM flows WHERE account_id = ${accountId}::uuid AND id = ${flowId}::uuid
      AND channel_scope IN ('instagram','any') AND status <> 'archived'`;
  if (!rows.length) throw new SequenceError('flowNotFound', 404);
}

/** A WhatsApp step's template must be an approved template of this workspace that a sequence can fill. */
async function assertStepTemplate(tx: TenantTransaction, accountId: string, step: WhatsAppStep): Promise<void> {
  if (!step.template) return;
  const refusal = stepTemplateRefusal(await loadStepTemplate(tx, accountId, step.template.name, step.template.language));
  if (refusal === 'template_not_found') throw new SequenceError('templateNotFound', 404);
  if (refusal) throw new SequenceError('templateUnusable', 400);
}

/** The sequence_messages columns of a WhatsApp step. */
function stepColumns(step: WhatsAppStep) {
  return {
    text: step.text, mediaType: step.media?.type ?? null, mediaUrl: step.media?.url ?? null, filename: step.media?.filename ?? null,
    templateName: step.template?.name ?? null, templateLanguage: step.template?.language ?? null,
    templateParams: JSON.stringify(step.template?.params ?? []),
  };
}

export async function addMessage(ctx: TenantContext, id: string, input: MessageCreate): Promise<SequenceDetail> {
  assertId(id);
  if (!ctx.userId) throw new SequenceError('forbidden', 403);
  return withTenant(ctx, async (tx) => {
    const { channel } = await lockSequence(tx, ctx.accountId, id);
    // An Instagram step is an automation; a WhatsApp step is its own message.
    if ((channel === 'whatsapp') !== (input.kind === 'whatsapp')) throw invalid();
    const count = await messageCount(tx, ctx.accountId, id);
    if (count >= STAGE5_LIMITS.sequenceMessages) throw new SequenceError('tooManyMessages', 409);
    // The first message goes out right after subscribing; later ones a day after the previous one.
    const delay: SequenceDelay = (input.kind === 'whatsapp' && input.delay)
      || (count === 0 ? { amount: 0, unit: 'minutes' } : { amount: 1, unit: 'days' });
    if (input.kind === 'whatsapp') {
      await assertStepTemplate(tx, ctx.accountId, input.step);
      const c = stepColumns(input.step);
      await tx.$executeRaw`INSERT INTO sequence_messages(account_id, sequence_id, position, delay_amount, delay_unit, wa_text, wa_media_type,
          wa_media_url, wa_media_filename, template_name, template_language, template_params)
        VALUES(${ctx.accountId}::uuid, ${id}::uuid, ${count}, ${delay.amount}, ${delay.unit}, ${c.text}, ${c.mediaType}, ${c.mediaUrl},
          ${c.filename}, ${c.templateName}, ${c.templateLanguage}, ${c.templateParams}::jsonb)`;
      await wakeWaiting(tx, ctx.accountId, id, count, delay);
      return loadDetail(tx, ctx.accountId, id);
    }
    let flowId: string;
    if (input.kind === 'existing') {
      await assertMessageFlow(tx, ctx.accountId, input.flowId);
      flowId = input.flowId;
    } else {
      // A new draft Instagram automation the owner builds and sets live; started by the sequence, never by a trigger.
      const [flow] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO flows(account_id, user_id, name, status, trigger_type, trigger_config, channel_scope)
        VALUES(${ctx.accountId}::uuid, ${ctx.userId}::uuid, ${input.name}, 'draft', 'manual', '{}'::jsonb, 'instagram')
        RETURNING id::text AS id`;
      flowId = flow.id;
    }
    await tx.$executeRaw`INSERT INTO sequence_messages(account_id, sequence_id, position, delay_amount, delay_unit, flow_id)
      VALUES(${ctx.accountId}::uuid, ${id}::uuid, ${count}, ${delay.amount}, ${delay.unit}, ${flowId}::uuid)`;
    await wakeWaiting(tx, ctx.accountId, id, count, delay);
    return loadDetail(tx, ctx.accountId, id);
  });
}

/** Subscribers waiting for a message (subscribed while the sequence was empty, or past its end) get the new one at `position`. */
async function wakeWaiting(tx: TenantTransaction, accountId: string, id: string, position: number, delay: SequenceDelay): Promise<void> {
  await tx.$executeRaw`UPDATE sequence_subscriptions SET next_due_at = ${dueAt(new Date(), delay)}
    WHERE account_id = ${accountId}::uuid AND sequence_id = ${id}::uuid AND status = 'active'
      AND next_due_at IS NULL AND next_position <= ${position}`;
}

interface LockedMessage { position: number; delay_amount: number; delay_unit: SequenceDelayUnit }

async function lockMessage(tx: TenantTransaction, accountId: string, id: string, messageId: string):
  Promise<LockedMessage & { channel: SequenceChannel }> {
  assertId(messageId);
  const { channel } = await lockSequence(tx, accountId, id);
  const rows = await tx.$queryRaw<LockedMessage[]>`
    SELECT position, delay_amount, delay_unit FROM sequence_messages
    WHERE account_id = ${accountId}::uuid AND sequence_id = ${id}::uuid AND id = ${messageId}::uuid`;
  if (!rows.length) throw notFound();
  return { ...rows[0], channel };
}

export async function updateMessage(ctx: TenantContext, id: string, messageId: string, patch: MessagePatch): Promise<SequenceDetail> {
  assertId(id);
  return withTenant(ctx, async (tx) => {
    const current = await lockMessage(tx, ctx.accountId, id, messageId);
    if ((patch.flowId && current.channel !== 'instagram') || (patch.whatsapp && current.channel !== 'whatsapp')) throw invalid();
    if (patch.flowId) await assertMessageFlow(tx, ctx.accountId, patch.flowId);
    if (patch.whatsapp) {
      await assertStepTemplate(tx, ctx.accountId, patch.whatsapp);
      const c = stepColumns(patch.whatsapp);
      await tx.$executeRaw`UPDATE sequence_messages SET wa_text = ${c.text}, wa_media_type = ${c.mediaType}, wa_media_url = ${c.mediaUrl},
          wa_media_filename = ${c.filename}, template_name = ${c.templateName}, template_language = ${c.templateLanguage},
          template_params = ${c.templateParams}::jsonb
        WHERE account_id = ${ctx.accountId}::uuid AND id = ${messageId}::uuid`;
    }
    await tx.$executeRaw`UPDATE sequence_messages SET
        delay_amount = COALESCE(${patch.delay?.amount ?? null}::int, delay_amount),
        delay_unit = COALESCE(${patch.delay?.unit ?? null}::text, delay_unit),
        active = COALESCE(${patch.active ?? null}::boolean, active),
        flow_id = COALESCE(${patch.flowId ?? null}::uuid, flow_id)
      WHERE account_id = ${ctx.accountId}::uuid AND id = ${messageId}::uuid`;
    // Subscribers waiting for this message move by the change, so a new delay applies to them too (the worker
    // re-checks the 24-hour window when it falls due). A due time in the past is simply due now.
    const shiftMs = patch.delay
      ? delayMs(patch.delay) - delayMs({ amount: current.delay_amount, unit: current.delay_unit })
      : 0;
    if (shiftMs !== 0)
      await tx.$executeRaw`UPDATE sequence_subscriptions SET next_due_at = next_due_at + ${shiftMs / 1000}::double precision * interval '1 second'
        WHERE account_id = ${ctx.accountId}::uuid AND sequence_id = ${id}::uuid AND status = 'active'
          AND next_position = ${current.position} AND next_due_at IS NOT NULL`;
    return loadDetail(tx, ctx.accountId, id);
  });
}

/**
 * Removes a message and closes the gap. Subscribers past it keep their place;
 * refused while the worker is sending this sequence to someone (try again).
 */
export async function deleteMessage(ctx: TenantContext, id: string, messageId: string): Promise<SequenceDetail> {
  assertId(id);
  return withTenant(ctx, async (tx) => {
    const { position } = await lockMessage(tx, ctx.accountId, id, messageId);
    const [busy] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM sequence_subscriptions
      WHERE account_id = ${ctx.accountId}::uuid AND sequence_id = ${id}::uuid AND status = 'sending'`;
    if (busy.n > 0) throw new SequenceError('busy', 409);
    await tx.$executeRaw`DELETE FROM sequence_messages WHERE account_id = ${ctx.accountId}::uuid AND id = ${messageId}::uuid`;
    await tx.$executeRaw`UPDATE sequence_messages SET position = position - 1
      WHERE account_id = ${ctx.accountId}::uuid AND sequence_id = ${id}::uuid AND position > ${position}`;
    await tx.$executeRaw`UPDATE sequence_subscriptions SET next_position = next_position - 1
      WHERE account_id = ${ctx.accountId}::uuid AND sequence_id = ${id}::uuid AND status = 'active' AND next_position > ${position}`;
    return loadDetail(tx, ctx.accountId, id);
  });
}

export async function reorderMessages(ctx: TenantContext, id: string, order: unknown): Promise<SequenceDetail> {
  assertId(id);
  return withTenant(ctx, async (tx) => {
    await lockSequence(tx, ctx.accountId, id);
    const current = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM sequence_messages
      WHERE account_id = ${ctx.accountId}::uuid AND sequence_id = ${id}::uuid ORDER BY position`;
    const positions = reorderPositions(current.map((r) => r.id), order);
    if (!positions) throw invalid();
    // Positions are unique per sequence, checked at commit, so a swap passes.
    for (const [messageId, position] of positions)
      await tx.$executeRaw`UPDATE sequence_messages SET position = ${position}
        WHERE account_id = ${ctx.accountId}::uuid AND id = ${messageId}::uuid AND position <> ${position}`;
    return loadDetail(tx, ctx.accountId, id);
  });
}

/** A member subscribes or unsubscribes one contact of the workspace by hand. */
export async function changeSubscriber(ctx: TenantContext, id: string, input: SubscriberAction): Promise<{ status: string }> {
  assertId(id);
  return withTenant(ctx, async (tx) => {
    await lockSequence(tx, ctx.accountId, id, false);
    const [contact] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM contacts
      WHERE account_id = ${ctx.accountId}::uuid AND id = ${input.contactId}::uuid`;
    if (!contact) throw notFound();
    if (input.action === 'unsubscribe')
      return { status: (await unsubscribeInTx(tx, ctx.accountId, input.contactId, id)) ? 'unsubscribed' : 'not_subscribed' };
    return { status: await subscribeInTx(tx, ctx.accountId, input.contactId, id) };
  });
}
