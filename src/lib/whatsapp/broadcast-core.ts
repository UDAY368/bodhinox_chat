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

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  parseInternationalPhone,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';

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
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
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

  // Config (fail fast + provides the audit trail owner already resolved
  // by the caller). Meta send needs phone_number_id + decrypted token.
  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();
  if (configError || !config) {
    throw new BroadcastError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
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
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid international phone number (leading + and country code, e.g. +14155550123)',
      400
    );
  }

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
      const rows = await tx.$queryRaw<{ broadcast_id: string; recipient_id: string; contact_id: string }[]>`
        SELECT broadcast_id::text, recipient_id::text, contact_id::text FROM create_broadcast_with_recipients(
          ${accountId}::uuid, ${auditUserId}::uuid, ${name || `API broadcast (${templateName})`},
          ${templateName}, ${resolvedTemplate.language}, ${deduped.length}::integer,
          ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(deduped.map((r) => r.contactId))}::jsonb)),
          ARRAY(SELECT value FROM jsonb_array_elements(${JSON.stringify(deduped.map((r) => r.params))}::jsonb)))`;
      const id = rows[0]?.broadcast_id;
      if (!id) throw new Error('Broadcast creation returned no rows');
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES('broadcast.dispatch',${accountId}::uuid,${JSON.stringify({ broadcastId: id })}::jsonb,${`broadcast:${id}:initial`})`;
      return rows;
    }, getWorkerPrisma());
  } catch (error) {
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
      return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params };
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
  options?: { accountId: string; assertLease: () => void; headerMediaUrl?: string; attemptId: string; retryRejected?: boolean }
): Promise<void> {
  for (const recipient of plan.planned) {
    if (options) await new Promise(resolve => setTimeout(resolve, 150));
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        options?.assertLease();
        const headerMediaUrl = options?.headerMediaUrl || plan.templateRow?.header_media_url;
        const send = async () => sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
          ...(options && headerMediaUrl ? { messageParams: { headerMediaUrl: await providerMediaUrl(options.accountId, headerMediaUrl) } } : {}),
        });
        const result = options ? await dispatchOnce(options.accountId, `broadcast:${plan.broadcastId}:${recipient.recipientRowId}:${variant}`, send, { retryRejected: options.retryRejected }) : await send();
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = error instanceof UncertainDispatchError ? 'Send outcome uncertain; reconcile with Meta before retrying' : message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
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
      const persisted = await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
      if (persisted.error) throw new Error('Broadcast recipient persistence failed');
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
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
    .select('id,account_id,name,status,total_recipients,sent_count,delivered_count,read_count,replied_count,failed_count');
  if (final.error) throw new Error('Broadcast completion persistence failed');
  const row = (final.data as Record<string, unknown>[] | null)?.[0];
  if (row)
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
