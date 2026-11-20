/**
 * Intake form (batch 3): when a booking is confirmed and its service has an
 * intake form (appointment_services.intake_form_id), the customer gets that
 * WhatsApp form once.
 *
 * notify-customer.ts queues appointments.intake_form after the confirmation
 * notice, keyed per (appointment, version), so a retried notice job never
 * queues a second one. The job records its outcome in appointment_messages
 * (kind intake_form) like every customer message: refusals are decided before
 * any intent, the send is sendForm's outbound intent (keyed per appointment
 * and version), an ambiguous send is recorded outcome_unknown and never
 * re-sent. Forms are interactive, so they need an open customer window and an
 * unpaused bot; otherwise the row says why it was skipped. Logs carry ids only.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { isSuspended } from '@/lib/billing/suspension';
import { getT } from '@/lib/i18n/translate';
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { FormSendError, sendForm } from '@/lib/whatsapp/forms/send';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { getAppointment } from './booking';
import { formatAppointmentTime, OPEN_WINDOW_MS, settleMessage } from './customer-send';
import { insertJob } from './schedule-jobs';
import { APPOINTMENT_JOB_TYPES, type AppointmentMessageStatus, type AppointmentRow, type IntakeFormJobPayload } from './types';

type Outcome = { status: AppointmentMessageStatus; reason: string | null };

/** appointments.intake_form job dedupe key and its outbound-intent key. */
export const intakeFormKey = (appointmentId: string, version: number) => `appt-intake:${appointmentId}:v${version}`;

/** Why the form no longer applies to this booking, else null (pure; tested). */
export function intakeApplies(row: Pick<AppointmentRow, 'status' | 'contact_id'> | null, formId: string | null): string | null {
  if (!row || row.status !== 'confirmed') return 'stale_version';
  if (!row.contact_id) return 'contact_missing';
  if (!formId) return 'disabled';
  return null;
}

/** The outcome a form refusal is recorded as (pure; tested). */
export function intakeRefusalOutcome(code: FormSendError['code']): Outcome {
  if (code === 'window_closed') return { status: 'skipped', reason: 'window_closed' };
  if (code === 'contact_blocked') return { status: 'skipped', reason: 'contact_blocked' };
  if (code === 'no_address') return { status: 'failed', reason: 'no_address' };
  if (code === 'not_configured') return { status: 'failed', reason: 'number_unavailable' };
  return { status: 'failed', reason: 'form_unavailable' };
}

/**
 * Queue the intake form of a just-confirmed booking when its service has one.
 * Idempotent (ON CONFLICT on the dedupe key).
 */
export async function enqueueIntakeForm(accountId: string, appointmentId: string, version: number): Promise<boolean> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [row] = await tx.$queryRaw<{ intake_form_id: string | null }[]>`
      SELECT s.intake_form_id::text AS intake_form_id FROM appointments a
      JOIN appointment_services s ON s.account_id=a.account_id AND s.id=a.service_id
      WHERE a.account_id=${accountId}::uuid AND a.id=${appointmentId}::uuid AND a.status='confirmed'`;
    if (!row?.intake_form_id) return false;
    const payload: IntakeFormJobPayload = { appointmentId, version };
    return insertJob(tx, accountId, APPOINTMENT_JOB_TYPES.intakeForm, payload, intakeFormKey(appointmentId, version));
  }, getWorkerPrisma());
}

type Plan =
  | { kind: 'done' }
  | { kind: 'settle'; outcome: Outcome; uncertain?: boolean }
  | { kind: 'send'; conversationId: string; formId: string; serviceName: string; time: string };

const settleWith = (outcome: Outcome): Plan => ({ kind: 'settle', outcome });

async function plan(tx: TenantTransaction, accountId: string, payload: IntakeFormJobPayload, now: Date): Promise<Plan> {
  const { appointmentId, version } = payload;
  const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`
    SELECT status, resolved_at FROM appointment_messages
    WHERE account_id=${accountId}::uuid AND appointment_id=${appointmentId}::uuid AND version=${version} AND kind='intake_form'`;
  if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };
  const [intent] = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM outbound_intents
    WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${intakeFormKey(appointmentId, version)}`}`;
  if (intent?.status === 'accepted') return settleWith({ status: 'sent', reason: null });
  if (intent?.status === 'failed') return settleWith({ status: 'failed', reason: 'provider_rejected' });
  if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

  const row = await getAppointment(tx, accountId, appointmentId);
  if (!row) return { kind: 'done' };
  const [service] = await tx.$queryRaw<{ intake_form_id: string | null }[]>`
    SELECT intake_form_id::text AS intake_form_id FROM appointment_services
    WHERE account_id=${accountId}::uuid AND id=${row.service_id}::uuid`;
  const formId = service?.intake_form_id ?? null;
  const notApplicable = intakeApplies(row, formId);
  if (notApplicable) return settleWith({ status: 'skipped', reason: notApplicable });

  const [contact] = await tx.$queryRaw<{ blocked_at: Date | null; opted_out_at: Date | null }[]>`
    SELECT blocked_at, opted_out_at FROM contacts WHERE account_id=${accountId}::uuid AND id=${row.contact_id}::uuid`;
  if (!contact) return settleWith({ status: 'skipped', reason: 'contact_missing' });
  if (contact.blocked_at) return settleWith({ status: 'skipped', reason: 'contact_blocked' });
  if (contact.opted_out_at && (!row.confirmed_at || contact.opted_out_at.getTime() > row.confirmed_at.getTime()))
    return settleWith({ status: 'skipped', reason: 'opted_out' });
  if (await isSuspended(tx, accountId)) return settleWith({ status: 'blocked', reason: 'workspace_suspended' });

  // The booking's own WhatsApp chat, else the WhatsApp chat the customer wrote in last.
  const [conversation] = await tx.$queryRaw<{ id: string; last_customer_at: Date | null }[]>`
    SELECT c.id::text AS id,
      (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
        AND m.sender_type='customer') AS last_customer_at
    FROM conversations c
    WHERE c.account_id=${accountId}::uuid AND c.contact_id=${row.contact_id}::uuid AND c.channel='whatsapp'
    ORDER BY (c.id=${row.conversation_id ?? null}::uuid) DESC NULLS LAST, last_customer_at DESC NULLS LAST, c.created_at DESC LIMIT 1`;
  const last = conversation?.last_customer_at ? new Date(conversation.last_customer_at).getTime() : NaN;
  if (!conversation || !Number.isFinite(last) || now.getTime() - last >= OPEN_WINDOW_MS)
    return settleWith({ status: 'skipped', reason: 'window_closed' });
  return {
    kind: 'send', conversationId: conversation.id, formId: formId!, serviceName: row.service_name,
    time: formatAppointmentTime(row.start_at, row.timezone),
  };
}

export async function handleIntakeFormJob(accountId: string, payload: IntakeFormJobPayload, now = new Date()): Promise<Outcome | null> {
  const spec = { appointmentId: payload.appointmentId, version: payload.version, kind: 'intake_form' as const };
  const settle = (outcome: Outcome) => withTenant({ accountId, role: 'owner' },
    (tx) => settleMessage(tx, accountId, spec, outcome, 'whatsapp'), getWorkerPrisma());
  const p = await withTenant({ accountId, role: 'owner' }, (tx) => plan(tx, accountId, payload, now), getWorkerPrisma());
  if (p.kind === 'done') return null;
  if (p.kind === 'settle') {
    await settle(p.outcome);
    if (p.uncertain) throw new UncertainDispatchError();
    return p.outcome;
  }
  // sendForm holds a bot send back while an agent paused the bot; decided here so it never becomes an ambiguous intent.
  if (await botRepliesPaused(accountId, p.conversationId)) {
    const outcome: Outcome = { status: 'skipped', reason: 'bot_paused' };
    await settle(outcome);
    return outcome;
  }
  const t = getT('AppointmentNotices');
  try {
    await sendForm({
      accountId, sender: 'bot', role: 'owner', conversationId: p.conversationId, formId: p.formId,
      intentKey: intakeFormKey(payload.appointmentId, payload.version),
      body: t('intakeBody', { service: p.serviceName, time: p.time }), cta: t('intakeCta'),
    });
  } catch (error) {
    let outcome: Outcome;
    if (error instanceof UncertainDispatchError) {
      await settle({ status: 'outcome_unknown', reason: 'uncertain' });
      throw error;
    }
    if (error instanceof FormSendError) outcome = intakeRefusalOutcome(error.code);
    else if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) outcome = { status: 'failed', reason: 'provider_rejected' };
    else throw error;
    console.warn('[appointments] intake form not sent', { accountId, appointmentId: payload.appointmentId, reason: outcome.reason });
    await settle(outcome);
    return outcome;
  }
  const outcome: Outcome = { status: 'sent', reason: null };
  await settle(outcome);
  return outcome;
}
