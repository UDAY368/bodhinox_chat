/**
 * appointments.notify job (design section 6, "Customer notices"):
 * confirmation, rescheduled and cancelled notices, plus the one reply to an
 * unrecognised or late "BOOK <CODE>".
 *
 * Inside the customer window (< 23h, D6) a notice is free-form text from
 * AppointmentNotices.*; outside it, the confirm/change template, or
 * blocked/no_template. A confirmation or rescheduled notice is skipped as
 * stale_version once the version moved on; a cancelled notice needs its own
 * version and status 'cancelled'.
 */
import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { engineSendText } from '@/lib/automations/meta-send';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { isSuspended } from '@/lib/billing/suspension';
import { getT } from '@/lib/i18n/translate';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { appointmentKeys } from './keys';
import { OPEN_WINDOW_MS, sendCustomerMessage } from './customer-send';
import type { AppointmentRow, NotifyJobPayload } from './types';

type Notice = Exclude<NotifyJobPayload['kind'], 'hold_reply'>;

export function noticeApplies(row: AppointmentRow, version: number, kind: Notice, startAt?: string): string | null {
  // A confirmation/rescheduled notice that recorded its start stays valid across later
  // bumps that keep the time (e.g. a practitioner reassign), so it is not lost.
  const sameTime = kind !== 'cancelled' && startAt !== undefined
    && row.version >= version && row.start_at.getTime() === new Date(startAt).getTime();
  if (row.version !== version && !sameTime) return 'stale_version';
  if (kind === 'cancelled' ? row.status !== 'cancelled' : row.status !== 'confirmed') return 'stale_version';
  if (!row.contact_id) return 'contact_missing';
  return null;
}

export async function handleAppointmentNoticeJob(
  accountId: string, payload: { appointmentId: string; version: number; kind: Notice; startAt?: string }, now = new Date(),
) {
  const { appointmentId, version, kind, startAt } = payload;
  const t = getT('AppointmentNotices');
  return sendCustomerMessage({
    accountId,
    appointmentId,
    version,
    kind,
    intentKey: appointmentKeys.notify(appointmentId, version, kind),
    templateSlot: kind === 'confirmation' ? 'confirm' : 'change',
    applies: (row) => noticeApplies(row, version, kind, startAt),
    freeForm: (ctx) => kind === 'cancelled'
      ? t('cancelled', { service: ctx.serviceName, time: ctx.time })
      : t(kind, { service: ctx.serviceName, time: ctx.time, location: ctx.location, link: ctx.manageLink() }),
    now,
  });
}

const HOLD_REPLY_TEXT: Record<NonNullable<NotifyJobPayload['reason']>, string> = {
  code_unknown: 'holdUnknownCode',
  slot_unavailable: 'holdUnavailable',
  hold_expired: 'holdUnavailable',
  customer_conflict: 'holdConflict',
};

export type HoldReplyResult = 'sent' | 'skipped' | 'failed';

/**
 * The one free-form reply to a "BOOK <CODE>" that could not confirm a hold,
 * on the conversation the code arrived in. Keyed per inbound message, so a
 * retried job never answers twice. No appointment_messages row (there may be
 * no appointment); refusals are logged with ids only.
 */
export async function handleHoldReplyJob(accountId: string, payload: NotifyJobPayload, now = new Date()): Promise<HoldReplyResult> {
  const { contactId, messageId, reason } = payload;
  if (!contactId || !messageId || !reason || !(reason in HOLD_REPLY_TEXT)) throw new Error('Invalid hold reply job');
  const prepared = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const [row] = await tx.$queryRaw<{ conversation_id: string; whatsapp_config_id: string | null; phone: string | null;
      wa_user_id: string | null; blocked_at: Date | null; last_customer_at: Date | null }[]>`
      SELECT c.id::text AS conversation_id, c.whatsapp_config_id::text AS whatsapp_config_id, ct.phone, ct.wa_user_id, ct.blocked_at,
        (SELECT max(m2.created_at) FROM messages m2 WHERE m2.account_id=c.account_id AND m2.conversation_id=c.id
          AND m2.sender_type='customer') AS last_customer_at
      FROM messages m JOIN conversations c ON c.account_id=m.account_id AND c.id=m.conversation_id
      JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
      WHERE m.account_id=${accountId}::uuid AND m.id=${messageId}::uuid AND ct.id=${contactId}::uuid`;
    if (!row || row.blocked_at) return null;
    if (await isSuspended(tx, accountId)) return null;
    if (!resolveContactSendTarget(row)) return null;
    const last = row.last_customer_at ? new Date(row.last_customer_at).getTime() : NaN;
    if (!Number.isFinite(last) || now.getTime() - last >= OPEN_WINDOW_MS) return null;
    try {
      if (isNumberDisconnected(await getNumberConfig(tx, accountId, row.whatsapp_config_id))) return null;
    } catch (error) {
      if (error instanceof NoNumberError) return null;
      throw error;
    }
    return { conversationId: row.conversation_id };
  }, getWorkerPrisma());
  if (!prepared) {
    console.warn('[appointments] hold reply skipped', { accountId, messageId });
    return 'skipped';
  }
  const db = createAdminClient({ accountId, role: 'owner' });
  const userId = await resolveAuditUserId(db, accountId);
  try {
    await dispatchOnce(accountId, appointmentKeys.holdReply(accountId, messageId), () => engineSendText({
      accountId, userId, conversationId: prepared.conversationId, contactId, serviceMessage: true,
      text: getT('AppointmentNotices')(HOLD_REPLY_TEXT[reason]),
    }));
  } catch (error) {
    if (error instanceof UncertainDispatchError) throw error;
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) {
      console.warn('[appointments] hold reply rejected', { accountId, messageId });
      return 'failed';
    }
    throw error;
  }
  return 'sent';
}
