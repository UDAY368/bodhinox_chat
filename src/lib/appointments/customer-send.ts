/**
 * One customer message about an appointment (design sections 6 and 9): the
 * shared pipeline behind reminders, notices and follow-ups.
 *
 * Every refusal is decided before dispatchOnce (D14) and recorded in
 * appointment_messages, so a plain refusal is never mistaken for an ambiguous
 * send. The send itself goes through an outbound intent keyed by keys.ts: an
 * accepted intent settles 'sent', a rejected one 'failed', anything else
 * 'outcome_unknown' and throws UncertainDispatchError for reconciliation; it
 * is never re-sent. settle() never overwrites a row an admin resolved.
 *
 * Consent (D5): refused when the contact is blocked, or opted out after the
 * appointment was confirmed. Human takeover does not hold these back
 * (serviceMessage, D13); a suspended workspace does. Templates must be
 * approved UTILITY templates that pass appointmentTemplateRefusal (D15).
 * Logs carry ids and codes only.
 */
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { appOrigin } from '@/lib/auth/csrf';
import { isSuspended } from '@/lib/billing/suspension';
import { getT } from '@/lib/i18n/translate';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { assertTemplateOnNumber } from '@/lib/whatsapp/sender-config';
import { templateSendRefusal } from '@/lib/whatsapp/template-send-params';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import type { MessageTemplate } from '@/types';
import { loadSettings } from './availability';
import { getAppointment } from './booking';
import { appointmentTemplateRefusal, manageButtonIndex, type AppointmentCheckedTemplate } from './template-check';
import { zoneLabel } from './time';
import { deriveManageToken, manageUrl } from './tokens';
import type {
  AppointmentMessageKind, AppointmentMessageStatus, AppointmentRow, AppointmentSettingsRow, AppointmentTemplateSlot,
} from './types';

/** The customer window counts as open only below 23h, a 1h margin against it closing mid-send (D6). */
export const OPEN_WINDOW_MS = 23 * 3_600_000;

type Outcome = { status: AppointmentMessageStatus; reason: string | null };

export interface CustomerMessageSpec {
  accountId: string;
  appointmentId: string;
  /** The version the job was queued for. */
  version: number;
  kind: AppointmentMessageKind;
  /** dispatchOnce key (keys.ts). */
  intentKey: string;
  /** Settings template slot used outside the window (or always, when freeForm is absent). */
  templateSlot: AppointmentTemplateSlot;
  /** Skip code when this job no longer applies to the row (stale_version, past_due ...), else null. */
  applies: (row: AppointmentRow, now: Date) => string | null;
  /** Settings toggle; false records skipped/disabled. */
  enabled?: (settings: AppointmentSettingsRow) => boolean;
  /** Free-form text when the window is open; absent = template only. */
  freeForm?: (ctx: MessageContext) => string;
  now?: Date;
}

export interface MessageContext {
  serviceName: string;
  /** Local date and time in the appointment's zone, with the zone label. */
  time: string;
  /** Location name, or the translated "online". */
  location: string;
  /** The customer's manage link (manage page plus token). */
  manageLink: () => string;
}

interface TemplateRow extends AppointmentCheckedTemplate {
  name: string;
  language: string | null;
  status: string | null;
  waba_id: string | null;
}

type Plan =
  | { kind: 'done' }
  | { kind: 'settle'; outcome: Outcome; uncertain?: boolean }
  | {
    kind: 'send';
    row: AppointmentRow;
    contactId: string;
    contactPhone: string | null;
    conversationId: string | null;
    configId: string;
    windowOpen: boolean;
    template: TemplateRow | null;
    ctx: Omit<MessageContext, 'manageLink'>;
  };

function appLocale(): string {
  const env = process.env.NEXT_PUBLIC_APP_LOCALE ?? '';
  return ['en', 'pt', 'es', 'ko'].includes(env) ? env : 'en';
}

/** "Mon, 9 Nov, 16:00 GMT+5:30" in the appointment's own zone (never the viewer's). */
export function formatAppointmentTime(instant: Date, timeZone: string, locale = appLocale()): string {
  const text = new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(instant);
  return `${text} ${zoneLabel(instant, timeZone, locale)}`;
}

/** Positional body values: {{1}} service, {{2}} local time, {{3}} location; cut to what the template uses. */
export function templateBodyValues(template: Pick<MessageTemplate, 'body_text'>, ctx: Omit<MessageContext, 'manageLink'>): string[] {
  const indices = extractVariableIndices(template.body_text ?? '');
  const count = indices.length ? Math.max(...indices) : 0;
  const values = [ctx.serviceName, ctx.time, ctx.location];
  return Array.from({ length: count }, (_, i) => (values[i] ?? '-').slice(0, 1000) || '-');
}

/** Record the outcome once per (appointment, version, kind); an admin's resolution is final. */
export async function settleMessage(
  tx: TenantTransaction, accountId: string, spec: { appointmentId: string; version: number; kind: AppointmentMessageKind }, outcome: Outcome,
): Promise<void> {
  await tx.$executeRaw`INSERT INTO appointment_messages(account_id,appointment_id,version,kind,status,reason)
    VALUES(${accountId}::uuid,${spec.appointmentId}::uuid,${spec.version},${spec.kind},${outcome.status},${outcome.reason})
    ON CONFLICT(account_id,appointment_id,version,kind) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,updated_at=now()
    WHERE appointment_messages.resolved_at IS NULL`;
}

async function settle(spec: CustomerMessageSpec, outcome: Outcome): Promise<void> {
  await withTenant({ accountId: spec.accountId, role: 'owner' },
    (tx) => settleMessage(tx, spec.accountId, spec, outcome), getWorkerPrisma());
}

const skip = (reason: string): Plan => ({ kind: 'settle', outcome: { status: 'skipped', reason } });
const block = (reason: string): Plan => ({ kind: 'settle', outcome: { status: 'blocked', reason } });
const fail = (reason: string): Plan => ({ kind: 'settle', outcome: { status: 'failed', reason } });

async function loadTemplate(tx: TenantTransaction, accountId: string, name: string, language: string | null): Promise<TemplateRow | null> {
  const rows = await tx.$queryRaw<TemplateRow[]>`
    SELECT name, language, status, category, body_text, header_type, header_content, header_media_url, buttons,
      template_kind, cards, lto, waba_id
    FROM message_templates WHERE account_id=${accountId}::uuid AND name=${name}
      AND (${language}::text IS NULL OR lower(language)=lower(${language}::text))
    ORDER BY (upper(coalesce(status,''))='APPROVED') DESC, language LIMIT 1`;
  return rows[0] ?? null;
}

/** Why this template cannot carry the message (blocked), or null. */
export function templateOutcome(template: TemplateRow | null, origin: string, number: object): Outcome | null {
  if (!template) return { status: 'blocked', reason: 'template_not_found' };
  if (String(template.status ?? '').toUpperCase() !== 'APPROVED') return { status: 'blocked', reason: 'template_not_approved' };
  const refusal = appointmentTemplateRefusal(template, origin);
  // Meta can recategorise a template; a MARKETING appointment message is never sent (D5, SEC-05).
  if (refusal === 'not_utility') return { status: 'blocked', reason: 'category' };
  if (refusal) return { status: 'blocked', reason: 'template_refused' };
  if (templateSendRefusal(template as { template_kind?: MessageTemplate['template_kind'] }, 'automation'))
    return { status: 'blocked', reason: 'template_refused' };
  try {
    assertTemplateOnNumber(template, number);
  } catch {
    return { status: 'blocked', reason: 'template_wrong_number' };
  }
  return null;
}

async function plan(spec: CustomerMessageSpec, now: Date): Promise<Plan> {
  const { accountId } = spec;
  return withTenant({ accountId, role: 'owner' }, async (tx): Promise<Plan> => {
    const row = await getAppointment(tx, accountId, spec.appointmentId);
    if (!row) return { kind: 'done' }; // deleted with its messages
    const [existing] = await tx.$queryRaw<{ status: string; resolved_at: Date | null }[]>`
      SELECT status, resolved_at FROM appointment_messages
      WHERE account_id=${accountId}::uuid AND appointment_id=${row.id}::uuid AND version=${spec.version} AND kind=${spec.kind}`;
    if (existing?.resolved_at || existing?.status === 'sent') return { kind: 'done' };

    // An earlier attempt already claimed the send: its intent decides, never a fresh plan.
    const [intent] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM outbound_intents WHERE account_id=${accountId}::uuid AND idempotency_key=${`${accountId}:${spec.intentKey}`}`;
    if (intent?.status === 'accepted') return { kind: 'settle', outcome: { status: 'sent', reason: null } };
    if (intent?.status === 'failed') return fail('provider_rejected');
    if (intent) return { kind: 'settle', outcome: { status: 'outcome_unknown', reason: 'uncertain' }, uncertain: true };

    const notApplicable = spec.applies(row, now);
    if (notApplicable) return skip(notApplicable);
    if (!row.contact_id) return skip('contact_missing');
    const settings = await loadSettings(tx, accountId);
    if (spec.enabled && !spec.enabled(settings)) return skip('disabled');

    const [contact] = await tx.$queryRaw<{ id: string; phone: string | null; wa_user_id: string | null;
      blocked_at: Date | null; opted_out_at: Date | null }[]>`
      SELECT id, phone, wa_user_id, blocked_at, opted_out_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${row.contact_id}::uuid`;
    if (!contact) return skip('contact_missing');
    if (contact.blocked_at) return skip('contact_blocked');
    // A pre-booking opt-out does not block service messages; one after confirmation does (D5).
    if (contact.opted_out_at && (!row.confirmed_at || contact.opted_out_at.getTime() > row.confirmed_at.getTime()))
      return skip('opted_out');
    if (await isSuspended(tx, accountId)) return block('workspace_suspended');
    if (!resolveContactSendTarget(contact)) return fail('no_address');

    // The contact's conversation: on the booking page's number first, else the most recent one.
    const [page] = row.booking_page_id ? await tx.$queryRaw<{ whatsapp_config_id: string | null }[]>`
      SELECT whatsapp_config_id::text AS whatsapp_config_id FROM booking_pages
      WHERE account_id=${accountId}::uuid AND id=${row.booking_page_id}::uuid` : [];
    const preferred = page?.whatsapp_config_id ?? null;
    const [conversation] = await tx.$queryRaw<{ id: string; whatsapp_config_id: string | null; last_customer_at: Date | null }[]>`
      SELECT c.id::text AS id, c.whatsapp_config_id::text AS whatsapp_config_id,
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
          AND m.sender_type='customer') AS last_customer_at
      FROM conversations c WHERE c.account_id=${accountId}::uuid AND c.contact_id=${contact.id}::uuid
      ORDER BY (c.whatsapp_config_id IS NOT NULL AND c.whatsapp_config_id=${preferred}::uuid) DESC,
        last_customer_at DESC NULLS LAST, c.created_at DESC LIMIT 1`;
    let config;
    try {
      config = await getNumberConfig(tx, accountId, conversation?.whatsapp_config_id ?? null);
    } catch (error) {
      if (error instanceof NoNumberError) return fail('number_unavailable');
      throw error;
    }
    if (isNumberDisconnected(config)) return fail('number_unavailable');
    const last = conversation?.last_customer_at ? new Date(conversation.last_customer_at).getTime() : NaN;
    const windowOpen = Number.isFinite(last) && now.getTime() - last < OPEN_WINDOW_MS;

    const [location] = await tx.$queryRaw<{ name: string; kind: string }[]>`
      SELECT name, kind FROM appointment_locations WHERE account_id=${accountId}::uuid AND id=${row.location_id}::uuid`;
    const ctx = {
      serviceName: row.service_name,
      time: formatAppointmentTime(row.start_at, row.timezone),
      location: !location || location.kind === 'online' ? getT('AppointmentNotices')('online') : location.name,
    };

    let template: TemplateRow | null = null;
    if (!(spec.freeForm && windowOpen)) {
      const name = settings[`${spec.templateSlot}_template_name`];
      const language = settings[`${spec.templateSlot}_template_language`];
      if (!name) return block('no_template');
      template = await loadTemplate(tx, accountId, name, language);
      const refusal = templateOutcome(template, appOrigin(), config);
      if (refusal) return { kind: 'settle', outcome: refusal };
    }
    return {
      kind: 'send', row, contactId: contact.id, contactPhone: contact.phone, conversationId: conversation?.id ?? null,
      configId: config.id, windowOpen, template, ctx,
    };
  }, getWorkerPrisma());
}

/**
 * Run one customer message job. Returns the recorded outcome (or null when
 * nothing was left to do). Throws UncertainDispatchError for an ambiguous
 * send, after recording 'outcome_unknown'.
 */
export async function sendCustomerMessage(spec: CustomerMessageSpec): Promise<Outcome | null> {
  const now = spec.now ?? new Date();
  const p = await plan(spec, now);
  if (p.kind === 'done') return null;
  if (p.kind === 'settle') {
    await settle(spec, p.outcome);
    if (p.uncertain) throw new UncertainDispatchError();
    return p.outcome;
  }

  const { accountId } = spec;
  const db = createAdminClient({ accountId, role: 'owner' });
  let conversationId = p.conversationId;
  if (!conversationId) {
    // No conversation yet (a staff booking for a contact who never wrote): open one on that number.
    const digits = normalizePhone(p.contactPhone ?? '');
    if (!digits) {
      const outcome: Outcome = { status: 'failed', reason: 'no_address' };
      await settle(spec, outcome);
      return outcome;
    }
    try {
      conversationId = (await resolveConversationByPhone(db, accountId, `+${digits}`, null, { whatsappConfigId: p.configId })).conversationId;
    } catch {
      const outcome: Outcome = { status: 'failed', reason: 'number_unavailable' };
      await settle(spec, outcome);
      return outcome;
    }
  }
  const userId = await resolveAuditUserId(db, accountId);
  const manageLink = () => manageUrl(deriveManageToken(p.row.id, p.row.token_epoch));
  const base = { accountId, userId, conversationId, contactId: p.contactId, serviceMessage: true as const };

  try {
    if (!p.template) {
      const text = spec.freeForm!({ ...p.ctx, manageLink });
      await dispatchOnce(accountId, spec.intentKey, () => engineSendText({ ...base, text }));
    } else {
      const template = p.template;
      const body = templateBodyValues(template, p.ctx);
      const buttonIndex = manageButtonIndex(template);
      const headerVar = template.header_type === 'text' && extractVariableIndices(template.header_content ?? '').length > 0;
      await dispatchOnce(accountId, spec.intentKey, () => engineSendTemplate({
        ...base,
        templateName: template.name,
        language: template.language ?? undefined,
        params: body,
        bodyValuesOnly: false,
        messageParams: {
          body,
          ...(headerVar ? { headerText: p.ctx.serviceName.slice(0, 60) } : {}),
          ...(buttonIndex !== null ? { buttonParams: { [buttonIndex]: deriveManageToken(p.row.id, p.row.token_epoch) } } : {}),
        },
      }));
    }
  } catch (error) {
    if (error instanceof UncertainDispatchError) {
      await settle(spec, { status: 'outcome_unknown', reason: 'uncertain' });
      throw error;
    }
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      const outcome: Outcome = { status: 'failed', reason: 'provider_rejected' };
      await settle(spec, outcome);
      return outcome;
    }
    throw error;
  }
  const outcome: Outcome = { status: 'sent', reason: null };
  await settle(spec, outcome);
  return outcome;
}
