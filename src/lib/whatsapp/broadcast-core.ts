import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { providerMediaUrl } from '@/lib/storage/server';
// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast while the worker fans out:
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending') + the dispatch job,
//                        return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { DataClient } from '@/lib/data/types';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { marketingSuppression } from '@/lib/contacts/consent';

import { MetaApiError, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { assertNumberConnected, NoNumberError } from '@/lib/whatsapp/numbers';
import {
  assertTemplateOnNumber,
  loadSenderConfig,
  loadSenderConfigByPhoneNumberId,
  numberErrorText,
  TemplateNumberMismatchError,
  type SenderConfigRow,
} from '@/lib/whatsapp/sender-config';
import {
  parseInternationalPhone,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import { templateKindOf } from '@/lib/whatsapp/template-validators';
import {
  splitFrozenParams,
  templateSendRefusal,
  type CampaignSendExtras,
} from '@/lib/whatsapp/template-send-params';
import { resolveTemplateMediaParams } from '@/lib/whatsapp/template-media';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { trackedButtonIndex } from '@/lib/broadcasts/tracking';
import { PlanLimitError, requireWithinLimit } from '@/lib/billing/entitlements';
import { templateFlowTokens } from '@/lib/whatsapp/forms/send';
import { notifyCampaignFinished, type FinishedCampaign } from '@/lib/notifications/emit';

/** Map a sending-number failure to a BroadcastError (the old message when none is connected). */
export function broadcastNumberError(error: unknown): unknown {
  if (error instanceof NoNumberError) {
    // Held, not moved: the campaign waits until its own number is reconnected.
    if (error.reason === 'disconnected') {
      return new BroadcastError('whatsapp_number_disconnected', numberErrorText(error), 409);
    }
    return error.reason === 'none'
      ? new BroadcastError(
          'whatsapp_not_configured',
          'WhatsApp not configured. Please set up your WhatsApp integration first.',
          400
        )
      : new BroadcastError('whatsapp_number_unavailable', numberErrorText(error), 400);
  }
  if (error instanceof TemplateNumberMismatchError) {
    return new BroadcastError(error.code, numberErrorText(error), 422);
  }
  return error;
}

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /** The number to send from (whatsapp_config.id); the default when omitted. */
  whatsappConfigId?: string | null;
  /** The number to send from by its Meta phone_number_id (public API); the default when omitted. */
  phoneNumberId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  /** Fills a trackable template's link button (lib/broadcasts/tracking). */
  clickToken?: string | null;
  /** The recipient's contact; ties a FLOW button's form session to them. */
  contactId?: string | null;
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Values fixed for every recipient (location, offer end, coupon); dashboard campaigns only. */
  sendExtras?: CampaignSendExtras;
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: DataClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // The sending number (fail fast): the one asked for, else the default.
  // Meta send needs phone_number_id + decrypted token.
  let config: SenderConfigRow;
  try {
    config = assertNumberConnected(params.phoneNumberId
      ? await loadSenderConfigByPhoneNumberId(db, accountId, params.phoneNumberId)
      : await loadSenderConfig(db, accountId, params.whatsappConfigId));
  } catch (error) {
    throw broadcastNumberError(error);
  }
  const accessToken = decrypt(config.access_token);

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;
  // A template synced from another WABA cannot go out from this number.
  try {
    assertTemplateOnNumber(templateRow, config);
  } catch (error) {
    throw broadcastNumberError(error);
  }
  // API recipients carry body values only. An authentication template
  // needs a per-person code, and a location header, an offer end or
  // card values cannot be given here either, so refuse those templates
  // up front instead of failing every recipient. Standard templates keep
  // their old behaviour (no pre-check).
  const refusal = templateSendRefusal(templateRow, 'campaign');
  if (refusal) throw new BroadcastError('template_kind_not_allowed', refusal, 422);
  if (templateRow && (templateKindOf(templateRow) !== 'standard' || templateRow.header_type === 'location')) {
    try {
      buildSendComponents(templateRow, { body: Array.from({ length: 99 }, () => 'x') });
    } catch (error) {
      throw new BroadcastError('bad_request', error instanceof Error ? error.message : 'Template needs values this endpoint cannot supply', 400);
    }
  }

  const { deduped, rejected } = await resolveApiRecipients(db, accountId, auditUserId, recipients);

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // The parent, its recipients (frozen params, so a resume can rebuild
  // {{1}}) and the dispatch job commit in ONE transaction: a failure leaves
  // no orphaned 'sending' campaign (issue #370), and success always has a
  // queued job behind it.
  let createdRows: { broadcast_id: string; recipient_id: string; contact_id: string }[];
  try {
    createdRows = await withTenant({ accountId, role: 'owner' }, async (tx) => {
      await requireWithinLimit(tx, accountId, 'campaign_recipients', deduped.length);
      const rows = await tx.$queryRaw<{ broadcast_id: string; recipient_id: string; contact_id: string }[]>`
        SELECT broadcast_id::text, recipient_id::text, contact_id::text FROM create_broadcast_with_recipients(
          ${accountId}::uuid, ${auditUserId}::uuid, ${name || `API broadcast (${templateName})`},
          ${templateName}, ${resolvedTemplate.language}, ${deduped.length}::integer,
          ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(deduped.map((r) => r.contactId))}::jsonb)),
          ARRAY(SELECT value FROM jsonb_array_elements(${JSON.stringify(deduped.map((r) => r.params))}::jsonb)))`;
      const id = rows[0]?.broadcast_id;
      if (!id) throw new Error('Broadcast creation returned no rows');
      // The number this campaign sends from (resumes and retries reuse it).
      if (config.id) {
        await tx.$executeRaw`UPDATE broadcasts SET whatsapp_config_id=${config.id}::uuid
          WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
      }
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES('broadcast.dispatch',${accountId}::uuid,${JSON.stringify({ broadcastId: id })}::jsonb,${`broadcast:${id}:initial`})`;
      return rows;
    }, getWorkerPrisma());
  } catch (error) {
    if (error instanceof PlanLimitError) throw new BroadcastError('plan_limit', error.message, 402);
    console.error('[broadcast-core] create broadcast failed', error instanceof Error ? error.name : 'unknown');
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params, contactId: row.contact_id };
    }
  );

  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Resolve public-API recipients to contacts: invalid numbers, repeats and
 * opted-out/blocked contacts are dropped and counted as rejected. Throws
 * BroadcastError when nobody is left to send to.
 */
export async function resolveApiRecipients(
  db: DataClient,
  accountId: string,
  auditUserId: string,
  recipients: BroadcastRecipientInput[]
): Promise<{ deduped: { contactId: string; phone: string; params: string[] }[]; rejected: number }> {
  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  // `to` is raw integrator input, so the leading `+` is required — a
  // national-format number would otherwise be delivered to whichever
  // country its leading digits spell (issue #586).
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const to = typeof r.to === 'string' ? r.to : '';
    const sanitized = parseInternationalPhone(to);
    if (!sanitized) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: to,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const unique = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  // Opted-out and blocked contacts never receive broadcasts; they count
  // as rejected (lib/contacts/consent).
  const { data: consentRows, error: consentError } = unique.length
    ? await db
        .from('contacts')
        .select('id,opted_out_at,blocked_at')
        .eq('account_id', accountId)
        .in('id', unique.map((r) => r.contactId))
    : { data: [], error: null };
  if (consentError) throw new BroadcastError('internal', 'Failed to check contact consent', 500);
  const suppressed = new Set(
    ((consentRows ?? []) as { id: string; opted_out_at: string | null; blocked_at: string | null }[])
      .filter((row) => marketingSuppression(row))
      .map((row) => row.id)
  );
  rejected += suppressed.size;
  const deduped = unique.filter((r) => !suppressed.has(r.contactId));

  if (deduped.length === 0 && suppressed.size > 0) {
    throw new BroadcastError('bad_request', 'Every valid recipient has opted out or is blocked', 400);
  }
  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid international phone number (leading + and country code, e.g. +14155550123)',
      400
    );
  }
  return { deduped, rejected };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: DataClient,
  plan: BroadcastPlan,
  options?: {
    accountId: string; assertLease: () => void; headerMediaUrl?: string; attemptId: string; retryRejected?: boolean;
  }
): Promise<{ throttled: boolean; sent: number }> {
  let sent = 0;
  const tracked = trackedButtonIndex(plan.templateRow);
  // Location, offer end and coupon are the same for every recipient.
  const extras = plan.sendExtras ?? {};
  const carousel = !!plan.templateRow && templateKindOf(plan.templateRow) === 'carousel';
  const flowButtons = (plan.templateRow?.buttons ?? []).some((b) => b.type === 'FLOW');
  for (const recipient of plan.planned) {
    // shortcut: fixed ~6 sends/s; pace by the number's messaging tier once the health job (Phase 2c) reports it.
    if (options) await new Promise(resolve => setTimeout(resolve, 150));
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;
    let throttled = false;
    // A FLOW button gets this recipient's own form session. Its key is the
    // recipient's (not the variant's), so every variant, retry and resumed
    // pass reuses the same sessions; they are made before the send intent.
    let flowTokens: Record<number, string> | undefined;
    let flowTokensReady = !(options && flowButtons);

    for (const variant of variants) {
      // Outside the try: a lost lease aborts the pass and leaves recipients pending, not failed.
      options?.assertLease();
      try {
        const headerMediaUrl = options?.headerMediaUrl || plan.templateRow?.header_media_url;
        // Carousels freeze each card's values after the top body values;
        // cut them apart and sign every card's media like the header's.
        const frozen = carousel ? splitFrozenParams(plan.templateRow!, recipient.params) : null;
        const cards = frozen && options
          ? (await resolveTemplateMediaParams(options.accountId, plan.templateRow, { cards: frozen.cards }))?.cards
          : frozen?.cards;
        if (!flowTokensReady && options) {
          flowTokens = await templateFlowTokens({ accountId: options.accountId, buttons: plan.templateRow?.buttons,
            contactId: recipient.contactId ?? null, conversationId: null,
            intentKey: `broadcast:${plan.broadcastId}:${recipient.recipientRowId}:form-sessions` });
          flowTokensReady = true;
        }
        const send = async () => sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: frozen?.body ?? recipient.params,
          ...((options && (headerMediaUrl || (tracked >= 0 && recipient.clickToken))) || cards || flowTokens || Object.keys(extras).length
            ? { messageParams: {
                ...extras,
                ...(cards ? { cards } : {}),
                ...(flowTokens ? { flowTokens } : {}),
                ...(options && headerMediaUrl && !carousel ? { headerMediaUrl: await providerMediaUrl(options.accountId, headerMediaUrl) } : {}),
                ...(options && tracked >= 0 && recipient.clickToken ? { buttonParams: { [tracked]: recipient.clickToken } } : {}),
              } }
            : {}),
        });
        const result = options ? await dispatchOnce(options.accountId, `broadcast:${plan.broadcastId}:${recipient.recipientRowId}:${variant}`, send, { retryRejected: options.retryRejected }) : await send();
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = error instanceof UncertainDispatchError ? 'Send outcome uncertain; reconcile with Meta before retrying' : message;
        // Meta refused for rate reasons: nothing was sent, so pause and retry the same recipient later.
        if (options && isThrottled(error)) {
          throttled = true;
          break;
        }
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    // The recipient stays pending; the dispatcher schedules the next pass with backoff.
    if (throttled) return { throttled: true, sent };

    if (sentMessageId) {
      sent++;
      const persisted = await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
      if (persisted.error) throw new Error('Broadcast recipient persistence failed');
    } else {
      // Never downgrade a row another pass already marked sent: a pass that lost the send
      // intent to it sees the intent mid-flight (uncertain) and would otherwise overwrite it.
      const persisted = await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId)
        .neq('status', 'sent');
      if (persisted.error) throw new Error('Broadcast recipient persistence failed');
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
  return { throttled: false, sent };
}

/**
 * Meta's documented throughput limits (application, account, cloud API
 * and per-recipient pair rate). Only these are retried automatically;
 * any other rejection is final and an uncertain outcome is never resent.
 */
export const THROTTLE_CODES: ReadonlySet<number> = new Set([4, 80007, 130429, 131056]);
export const MAX_THROTTLE_RETRIES = 6;

export function isThrottled(error: unknown): boolean {
  return error instanceof MetaApiError && error.code !== null && THROTTLE_CODES.has(error.code);
}

/** Backoff before throttled pass `n` (1-based): 1, 2, 4, 8, 16, then 30 minutes. */
export function throttleDelayMs(n: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, n - 1));
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: DataClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count, error } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    if (error) throw new Error('Broadcast counter read failed');
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total, error: totalError } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  if (totalError) throw new Error('Broadcast total read failed');
  const status = failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent';
  // Only a real transition returns a row, so the completion event fires
  // once per finished pass; a failed enqueue fails the job, which retries.
  const final = await db
    .from('broadcasts')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', broadcastId)
    .neq('status', status)
    .select('id,account_id,name,status,kind,total_recipients,sent_count,delivered_count,read_count,replied_count,failed_count');
  if (final.error) throw new Error('Broadcast completion persistence failed');
  const row = (final.data as Record<string, unknown>[] | null)?.[0];
  // An API campaign settles after every batch and never "completes", so it fires no completion event.
  // The creator's in-app/email alert never throws, so it cannot fail the job after the commit above.
  if (row && row.kind !== 'api') await notifyCampaignFinished(row as unknown as FinishedCampaign);
  if (row && row.kind !== 'api')
    await dispatchWebhookEvent(db, row.account_id as string, 'broadcast.completed', {
      broadcast_id: row.id,
      name: row.name,
      status: row.status,
      total_recipients: row.total_recipients,
      sent: row.sent_count,
      delivered: row.delivered_count,
      read: row.read_count,
      replied: row.replied_count,
      failed: row.failed_count,
    });
}
