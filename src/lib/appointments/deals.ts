/**
 * Bookings and deals (Batch 3). Staff link one deal to a booking (same
 * workspace and, when the booking has a customer, that customer's deal); a
 * booking marked completed can move its open deal to the workspace's chosen
 * stage, in the same transaction as the outcome. Every query is scoped by
 * account_id inside the caller's withTenant transaction; RLS also applies.
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { getAppointment } from './booking';
import { isUuid } from './config';
import { AppointmentError, type AppointmentRow } from './types';

export interface DealOption { id: string; title: string; status: string | null; stage_name: string | null; contact_id: string | null }

/** Deals a booking may be linked to: open, and the booking's customer's own when it has one. */
export const DEAL_PAGE_ROWS = 20;

async function audit(tx: TenantTransaction, accountId: string, userId: string, action: string, resourceId: string, metadata: object) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;
}

/**
 * Open deals for the booking's link picker, newest first, paged by
 * `after` (the last deal id of the previous page). Title search is plain
 * substring, case-insensitive.
 */
export async function dealOptions(
  tx: TenantTransaction, accountId: string, appointmentId: string, opts: { q?: string | null; after?: string | null } = {},
): Promise<{ deals: DealOption[]; next: string | null }> {
  const row = await getAppointment(tx, accountId, appointmentId);
  if (!row) throw new AppointmentError('not_found');
  if (opts.after != null && !isUuid(opts.after)) throw new AppointmentError('invalid');
  const q = (opts.q ?? '').trim().slice(0, 100);
  const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const rows = await tx.$queryRaw<(DealOption & { created_at: Date })[]>`SELECT d.id, d.title, d.status, s.name AS stage_name,
      d.contact_id, d.created_at
    FROM deals d LEFT JOIN pipeline_stages s ON s.account_id=d.account_id AND s.id=d.stage_id
    WHERE d.account_id=${accountId}::uuid AND coalesce(d.status,'open')='open'
      AND (${row.contact_id}::uuid IS NULL OR d.contact_id=${row.contact_id}::uuid)
      AND (${pattern}::text IS NULL OR d.title ILIKE ${pattern})
      AND (${opts.after ?? null}::uuid IS NULL OR (d.created_at, d.id) < (
        SELECT a.created_at, a.id FROM deals a WHERE a.account_id=${accountId}::uuid AND a.id=${opts.after ?? null}::uuid))
    ORDER BY d.created_at DESC, d.id DESC LIMIT ${DEAL_PAGE_ROWS + 1}`;
  const page = rows.slice(0, DEAL_PAGE_ROWS).map(({ created_at: _c, ...d }) => { void _c; return d; });
  return { deals: page, next: rows.length > DEAL_PAGE_ROWS ? page[page.length - 1].id : null };
}

/**
 * Link a deal to a booking (dealId) or unlink it (null). Not versioned (the
 * reminders stay); a history row records it. The deal must be in this
 * workspace and, when the booking has a customer, belong to that customer.
 * Linking the deal already linked is a no-op.
 */
export async function setAppointmentDeal(
  tx: TenantTransaction, input: { accountId: string; userId: string; appointmentId: string; dealId: string | null },
): Promise<AppointmentRow> {
  const { accountId } = input;
  if (input.dealId !== null && !isUuid(input.dealId)) throw new AppointmentError('invalid');
  const row = await getAppointment(tx, accountId, input.appointmentId, true);
  if (!row) throw new AppointmentError('not_found');
  if ((row.deal_id ?? null) === input.dealId) return row;
  if (input.dealId) {
    const [deal] = await tx.$queryRaw<{ contact_id: string | null }[]>`SELECT contact_id FROM deals
      WHERE account_id=${accountId}::uuid AND id=${input.dealId}::uuid`;
    if (!deal) throw new AppointmentError('not_found');
    if (row.contact_id && deal.contact_id !== row.contact_id) throw new AppointmentError('invalid');
  }
  await tx.$executeRaw`UPDATE appointments SET deal_id=${input.dealId}::uuid
    WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
  const kind = input.dealId ? 'deal_linked' : 'deal_unlinked';
  await tx.$executeRaw`INSERT INTO appointment_events(appointment_id,version,kind,actor,actor_user_id,detail)
    VALUES(${row.id}::uuid,${row.version},${kind},'staff',${input.userId}::uuid,${input.dealId ?? row.deal_id ?? null})`;
  await audit(tx, accountId, input.userId, `appointments.appointment.${kind}`, row.id, { deal_id: input.dealId ?? row.deal_id ?? null });
  return { ...row, deal_id: input.dealId };
}

/**
 * After an outcome "completed": move the booking's deal to the workspace's
 * completed stage when one is set, the deal is still open and that stage is in
 * the deal's own pipeline. Returns whether the deal moved.
 */
export async function moveDealOnCompleted(
  tx: TenantTransaction, input: { accountId: string; userId: string | null; appointment: Pick<AppointmentRow, 'id' | 'status' | 'deal_id'> },
): Promise<boolean> {
  const { accountId, appointment } = input;
  if (appointment.status !== 'completed' || !appointment.deal_id) return false;
  const stageId = await getCompletedDealStage(tx, accountId);
  if (!stageId) return false;
  const moved = await tx.$queryRaw<{ id: string }[]>`UPDATE deals d SET stage_id=${stageId}::uuid, updated_at=now()
    FROM pipeline_stages s
    WHERE d.account_id=${accountId}::uuid AND d.id=${appointment.deal_id}::uuid AND coalesce(d.status,'open')='open'
      AND d.stage_id <> ${stageId}::uuid
      AND s.account_id=d.account_id AND s.id=${stageId}::uuid AND s.pipeline_id=d.pipeline_id
    RETURNING d.id`;
  if (moved.length && input.userId)
    await audit(tx, accountId, input.userId, 'deals.stage_moved_by_appointment', appointment.deal_id, { appointment_id: appointment.id, stage_id: stageId });
  return moved.length > 0;
}

// ------------------------------------------------------------ settings: the completed-booking stage

export async function getCompletedDealStage(tx: TenantTransaction, accountId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ id: string | null }[]>`SELECT completed_deal_stage_id AS id FROM appointment_settings
    WHERE account_id=${accountId}::uuid`;
  return row?.id ?? null;
}

/** Set (a stage in this workspace) or clear (null) the stage completed bookings move their deal to. */
export async function setCompletedDealStage(tx: TenantTransaction, accountId: string, userId: string, stageId: string | null): Promise<string | null> {
  if (stageId !== null) {
    if (!isUuid(stageId)) throw new AppointmentError('invalid');
    const [stage] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM pipeline_stages WHERE account_id=${accountId}::uuid AND id=${stageId}::uuid`;
    if (!stage) throw new AppointmentError('not_found');
  }
  await tx.$executeRaw`INSERT INTO appointment_settings(account_id, completed_deal_stage_id) VALUES(${accountId}::uuid, ${stageId}::uuid)
    ON CONFLICT (account_id) DO UPDATE SET completed_deal_stage_id=EXCLUDED.completed_deal_stage_id`;
  await audit(tx, accountId, userId, 'appointments.settings.updated', accountId, { fields: ['completed_deal_stage_id'] });
  return stageId;
}

export interface StageOption { id: string; name: string; pipeline_id: string; pipeline_name: string }

/** Every pipeline stage for the settings picker (bounded: a workspace has a handful of pipelines). */
export async function listDealStages(tx: TenantTransaction, accountId: string): Promise<StageOption[]> {
  return tx.$queryRaw<StageOption[]>`SELECT s.id, s.name, s.pipeline_id, p.name AS pipeline_name
    FROM pipeline_stages s JOIN pipelines p ON p.account_id=s.account_id AND p.id=s.pipeline_id
    WHERE s.account_id=${accountId}::uuid ORDER BY p.name, p.id, s.position, s.id LIMIT 500`;
}
