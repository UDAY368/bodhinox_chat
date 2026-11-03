/**
 * Paid appointments (design E15, T6). A public hold of a paid service is
 * confirmed only after settlement verified its payment; confirmPaidHoldTx is
 * called by settlePaymentTx under the payment and appointment row locks and
 * re-checks capacity when the hold's time ran out. The payment-link job
 * creates the link (reference ap_..., appointment_id set at insert, expireBy at least
 * the hold's end) and sends it once.
 *
 * Sending: every refusal is decided before the send and recorded in
 * appointment_messages (kind payment_link) for this hold version; the send
 * goes through sendPaymentLinkMessage's outbound intent, so an ambiguous
 * outcome is recorded outcome_unknown and never re-sent. Logs carry ids and
 * codes only.
 */
import { createHash } from 'node:crypto';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isSuspended } from '@/lib/billing/suspension';
import { formatMoney } from '@/lib/commerce/money';
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import {
  createPaymentLinkRecord, MIN_EXPIRE_MINUTES, PaymentLinkError, sendPaymentLinkMessage, type PaymentLinkView,
} from '@/lib/payments/links';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { confirmPaidHold, getAppointment, type ConfirmPaidHoldOutcome } from './booking';
import { formatAppointmentTime, settleMessage } from './customer-send';
import { APPOINTMENT_PAYMENT_LINK_JOB as JOB_TYPE, type AppointmentMessageStatus, type AppointmentRow } from './types';

export const APPOINTMENT_PAYMENT_LINK_JOB = JOB_TYPE;
export { paidBookingReady, paymentLinkJobKey, PAID_HOLD_MIN_MINUTES } from './booking';
export type { ConfirmPaidHoldOutcome } from './booking';

/** Dedupe appt-link:<appointmentId>:<version>, queued by confirmHold. */
export interface AppointmentPaymentLinkJobPayload {
  appointmentId: string;
  version: number;
}

const MINUTE = 60_000;

/** Razorpay reference for one hold version (prefix ap_, 35 characters): a replayed job finds the same link. */
export function appointmentPaymentReference(appointmentId: string, version: number): string {
  return `ap_${createHash('sha256').update(`appointment:${appointmentId}:${version}`).digest('base64url').slice(0, 32)}`;
}

/** dispatchOnce key of the payment-link message for one hold version. */
export const appointmentPaymentIntentKey = (appointmentId: string, version: number) => `appt-plink:${appointmentId}:v${version}`;

export async function confirmPaidHoldTx(tx: TenantTransaction, input: {
  accountId: string;
  appointmentId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
}): Promise<ConfirmPaidHoldOutcome> {
  return confirmPaidHold(tx, input);
}

type Outcome = { status: AppointmentMessageStatus; reason: string | null };

type Plan =
  | { kind: 'done' }
  | { kind: 'settle'; outcome: Outcome; uncertain?: boolean }
  | { kind: 'send'; row: AppointmentRow; contactId: string; conversationId: string };

/** Why a link can no longer be sent for this job, as a skip code, or null. */
export function paymentLinkApplies(
  row: Pick<AppointmentRow, 'version' | 'status' | 'payment_status' | 'hold_expires_at' | 'contact_id'>, version: number, now: Date,
): string | null {
  if (row.version !== version || row.status !== 'held' || row.payment_status !== 'pending') return 'stale_version';
  if (!row.hold_expires_at || row.hold_expires_at.getTime() <= now.getTime()) return 'hold_expired';
  if (!row.contact_id) return 'contact_missing';
  return null;
}

async function plan(accountId: string, payload: AppointmentPaymentLinkJobPayload, now: Date): Promise<Plan> {
  const { appointmentId, version } = payload;
  return withTenant({ accountId, role: 'owner' }, async (tx): Promise<Plan> => {
    const row = await getAppointment(tx, accountId, appointmentId);
    if (!row) return { kind: 'done' };
    const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM appointment_messages
      WHERE account_id=${accountId}::uuid AND appointment_id=${row.id}::uuid AND version=${version} AND kind='payment_link'`;
    if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };
    // An earlier attempt already claimed the send: its intent decides, never a fresh send.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM outbound_intents
      WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${appointmentPaymentIntentKey(row.id, version)}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', outcome: { status: 'sent', reason: null } };
    if (intent?.status === 'failed') return { kind: 'settle', outcome: { status: 'failed', reason: 'provider_rejected' } };
    if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

    const skip = paymentLinkApplies(row, version, now);
    if (skip) return { kind: 'settle', outcome: { status: 'skipped', reason: skip } };
    const [contact] = await tx.$queryRaw<{ blocked_at: Date | null }[]>`SELECT blocked_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${row.contact_id}::uuid`;
    if (!contact) return { kind: 'settle', outcome: { status: 'skipped', reason: 'contact_missing' } };
    if (contact.blocked_at) return { kind: 'settle', outcome: { status: 'skipped', reason: 'contact_blocked' } };
    if (await isSuspended(tx, accountId)) return { kind: 'settle', outcome: { status: 'blocked', reason: 'workspace_suspended' } };
    // The conversation the BOOK code arrived in: on the page's number first, then the latest customer message.
    const [page] = row.booking_page_id ? await tx.$queryRaw<{ whatsapp_config_id: string | null }[]>`
      SELECT whatsapp_config_id::text AS whatsapp_config_id FROM booking_pages
      WHERE account_id=${accountId}::uuid AND id=${row.booking_page_id}::uuid` : [];
    const [conversation] = await tx.$queryRaw<{ id: string }[]>`
      SELECT c.id::text AS id FROM conversations c WHERE c.account_id=${accountId}::uuid AND c.contact_id=${row.contact_id}::uuid
      ORDER BY (c.whatsapp_config_id IS NOT NULL AND c.whatsapp_config_id=${page?.whatsapp_config_id ?? null}::uuid) DESC,
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
          AND m.sender_type='customer') DESC NULLS LAST, c.created_at DESC LIMIT 1`;
    if (!conversation) return { kind: 'settle', outcome: { status: 'failed', reason: 'conversation_not_found' } };
    return { kind: 'send', row, contactId: row.contact_id as string, conversationId: conversation.id };
  }, getWorkerPrisma());
}

async function settle(accountId: string, payload: AppointmentPaymentLinkJobPayload, outcome: Outcome): Promise<Outcome> {
  await withTenant({ accountId, role: 'owner' }, (tx) => settleMessage(tx, accountId,
    { appointmentId: payload.appointmentId, version: payload.version, kind: 'payment_link' }, outcome), getWorkerPrisma());
  return outcome;
}

/** A link refusal recorded on the message: the customer's own state is a skip or block, anything else a failure. */
function linkRefusal(code: PaymentLinkError['code']): Outcome {
  if (code === 'contact_blocked') return { status: 'skipped', reason: code };
  if (code === 'window_closed') return { status: 'blocked', reason: code };
  return { status: 'failed', reason: code };
}

/**
 * appointments.payment_link job: create the hold's payment link and send it
 * once on the customer's conversation. The hold already reserves the slot;
 * the customer pays on Razorpay's page and settlement (never this job, nor
 * any success page) confirms the booking. Returns the recorded outcome, or
 * null when nothing was left to do.
 */
export async function handleAppointmentPaymentLinkJob(
  accountId: string,
  payload: AppointmentPaymentLinkJobPayload,
  meta: { attempts: number; maxAttempts: number },
  now = new Date(),
): Promise<Outcome | null> {
  const p = await plan(accountId, payload, now);
  if (p.kind === 'done') return null;
  if (p.kind === 'settle') {
    await settle(accountId, payload, p.outcome);
    if (p.uncertain) throw new UncertainDispatchError();
    return p.outcome;
  }

  const { row } = p;
  const amountMinor = Number(row.price_minor);
  const currency = row.currency as string;
  // Razorpay needs at least 15 minutes; a hold ending sooner keeps its own end,
  // and a capture after it takes the late-payment path (confirmPaidHold).
  const expireBy = new Date(Math.max((row.hold_expires_at as Date).getTime(), now.getTime() + MIN_EXPIRE_MINUTES * MINUTE));
  let link: PaymentLinkView;
  try {
    const created = await createPaymentLinkRecord({
      accountId,
      actor: { kind: 'bot' },
      amountMinor,
      currency,
      description: row.service_name.slice(0, 200),
      contactId: p.contactId,
      conversationId: p.conversationId,
      appointmentId: row.id,
      expireBy,
      referenceId: appointmentPaymentReference(row.id, payload.version),
    });
    if (created.outcome === 'rejected') return settle(accountId, payload, { status: 'failed', reason: 'provider_rejected' });
    if (created.outcome === 'unknown') {
      // Retried: a replay reconciles the stored row by reference before creating anything.
      if (meta.attempts < meta.maxAttempts) throw new Error('appointment payment link outcome unknown');
      return settle(accountId, payload, { status: 'failed', reason: 'link_unknown' });
    }
    link = created.link;
  } catch (error) {
    if (error instanceof PaymentLinkError) return settle(accountId, payload, linkRefusal(error.code));
    throw error;
  }
  if (link.status !== 'created' || !link.short_url) {
    return settle(accountId, payload, link.status === 'paid'
      ? { status: 'skipped', reason: 'already_paid' }
      : { status: 'failed', reason: 'link_not_ready' });
  }

  const t = getT('AppointmentNotices');
  const message = t('paymentLink', {
    service: row.service_name,
    time: formatAppointmentTime(row.start_at, row.timezone),
    amount: formatMoney(amountMinor, currency),
  });
  try {
    const userId = await resolveAuditUserId(createAdminClient({ accountId, role: 'owner' }), accountId);
    await sendPaymentLinkMessage({
      accountId, userId, role: 'owner', linkId: link.id, message: message.slice(0, 900),
      intentKey: appointmentPaymentIntentKey(row.id, payload.version),
    });
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await settle(accountId, payload, { status: 'outcome_unknown', reason: 'uncertain' });
      throw error;
    }
    if (error instanceof PaymentLinkError) return settle(accountId, payload, linkRefusal(error.code));
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500)
      return settle(accountId, payload, { status: 'failed', reason: 'provider_rejected' });
    throw error;
  }
  return settle(accountId, payload, { status: 'sent', reason: null });
}
