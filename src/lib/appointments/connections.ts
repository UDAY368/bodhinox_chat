/**
 * Staff-side connections of a booking (Batch 3): the intake form a service
 * sends after confirmation (WP-B sends it), and the history row for a refund
 * staff asked for through the payments refund path. Nothing here moves money:
 * the refund itself is requested by /api/payments/customer-payments/[id]/refund
 * (admin + commerce.refunds); this only records it on the booking once the
 * refund row exists.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { getAppointment } from './booking';
import { isUuid } from './config';
import { AppointmentError } from './types';

export const FORM_PAGE_ROWS = 25;
export interface FormOption { id: string; name: string; status: string }

/** Published WhatsApp forms for the intake picker, by name, paged by `after` (the last name+id). */
export async function intakeFormOptions(
  tx: TenantTransaction, accountId: string, opts: { q?: string | null; after?: string | null } = {},
): Promise<{ forms: FormOption[]; next: string | null }> {
  if (opts.after != null && !isUuid(opts.after)) throw new AppointmentError('invalid');
  const q = (opts.q ?? '').trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await tx.$queryRaw<FormOption[]>`SELECT f.id, f.name, f.status FROM whatsapp_forms f
    WHERE f.account_id=${accountId}::uuid AND f.status='published'
      AND (${pattern}::text IS NULL OR f.name ILIKE ${pattern})
      AND (${opts.after ?? null}::uuid IS NULL OR (f.name, f.id) > (
        SELECT a.name, a.id FROM whatsapp_forms a WHERE a.account_id=${accountId}::uuid AND a.id=${opts.after ?? null}::uuid))
    ORDER BY f.name, f.id LIMIT ${FORM_PAGE_ROWS + 1}`;
  const page = rows.slice(0, FORM_PAGE_ROWS);
  return { forms: page, next: rows.length > FORM_PAGE_ROWS ? page[page.length - 1].id : null };
}

/** service id -> intake form id, for the services list. */
export async function serviceIntakeForms(tx: TenantTransaction, accountId: string): Promise<Map<string, string>> {
  const rows = await tx.$queryRaw<{ id: string; intake_form_id: string }[]>`SELECT id, intake_form_id FROM appointment_services
    WHERE account_id=${accountId}::uuid AND intake_form_id IS NOT NULL`;
  return new Map(rows.map((r) => [r.id, r.intake_form_id]));
}

/** Set (a published form of this workspace) or clear the service's intake form. */
export async function setServiceIntakeForm(
  tx: TenantTransaction, accountId: string, userId: string, serviceId: string, formId: string | null,
): Promise<string | null> {
  if (formId !== null) {
    if (!isUuid(formId)) throw new AppointmentError('invalid');
    const [form] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM whatsapp_forms
      WHERE account_id=${accountId}::uuid AND id=${formId}::uuid AND status='published'`;
    if (!form) throw new AppointmentError('not_found');
  }
  const updated = await tx.$executeRaw`UPDATE appointment_services SET intake_form_id=${formId}::uuid
    WHERE account_id=${accountId}::uuid AND id=${serviceId}::uuid`;
  if (!updated) throw new AppointmentError('not_found');
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,'appointments.service.updated',${serviceId},${JSON.stringify({ fields: ['intake_form_id'] })}::jsonb)`;
  return formId;
}

/**
 * Record on the booking that staff asked for a refund. The refund must already
 * exist for one of this booking's payments in this workspace; the same refund
 * is recorded once.
 */
export async function recordRefundRequested(
  tx: TenantTransaction, input: { accountId: string; userId: string; appointmentId: string; refundId: string },
): Promise<'recorded' | 'already'> {
  const { accountId } = input;
  if (!isUuid(input.refundId)) throw new AppointmentError('invalid');
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row) throw new AppointmentError('not_found');
  const [refund] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM customer_refunds
    WHERE account_id=${accountId}::uuid AND id=${input.refundId}::uuid AND appointment_id=${row.id}::uuid`;
  if (!refund) throw new AppointmentError('not_found');
  // detail is a code column ([a-z0-9_]): the refund id without hyphens.
  const detail = refund.id.replace(/-/g, '').toLowerCase();
  const [seen] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM appointment_events
    WHERE account_id=${accountId}::uuid AND appointment_id=${row.id}::uuid AND kind='refund_requested' AND detail=${detail}`;
  if (seen?.n) return 'already';
  await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor,actor_user_id,detail)
    VALUES(${row.id}::uuid,${row.version},'refund_requested','staff',${input.userId}::uuid,${detail})`;
  return 'recorded';
}
