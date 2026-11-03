// GET   /api/appointments/[id] — one appointment with history, customer-message outcomes and tasks
//   (any member). 200 { appointment, events, messages, tasks }. The staff note only with appointments.manage.
// PATCH /api/appointments/[id] — agents and above with appointments.manage. Body by action:
//   { action:'reschedule', expected_version, start_at, staff_id? }  move and/or reassign (version + 1)
//   { action:'cancel', expected_version, reason?: 'customer'|'staff'|'other' }
//   { action:'outcome', expected_version, outcome:'completed'|'no_show', note? }  only after the start
//   { action:'details', outcome_note?, feedback_score? }  no version change
//   200 { appointment }; 409 conflict (stale expected_version or wrong status), slot_unavailable, customer_conflict.
// Another workspace's id is a 404.
export const runtime = 'nodejs';

import { can } from '@/lib/auth/permissions';
import {
  cancelAppointment, markOutcome, rescheduleAppointment, updateAppointmentDetails,
} from '@/lib/appointments/booking';
import { getAppointmentDetail } from '@/lib/appointments/listing';
import { AppointmentError, type AppointmentRow } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, mutationLimit, publicRow, readJson, staffCaller } from '../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'viewer' });
    if (!isId(id)) throw new AppointmentError('not_found');
    const { detail, manage } = await inTenant(caller, async (tx) => ({
      detail: await getAppointmentDetail(tx, caller.accountId, id),
      manage: await can(tx, caller, 'appointments.manage'),
    }));
    return json({ ...detail, appointment: publicRow(detail.appointment, manage) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}

function version(body: Record<string, unknown>): number {
  const v = body.expected_version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new AppointmentError('invalid');
  return v;
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent', mutation: true, permission: 'appointments.manage' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    if (!isId(id)) throw new AppointmentError('not_found');
    const body = (await readJson(request)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new AppointmentError('invalid');
    const base = { accountId: caller.accountId, appointmentId: id };
    const appointment = await inTenant(caller, async (tx): Promise<AppointmentRow> => {
      switch (body.action) {
        case 'reschedule': {
          const startAt = typeof body.start_at === 'string' ? new Date(body.start_at) : null;
          if (!startAt || Number.isNaN(startAt.getTime()) || (body.staff_id != null && !isId(body.staff_id))) throw new AppointmentError('invalid');
          const row = await rescheduleAppointment(tx, { ...base, startAt, staffId: (body.staff_id as string | undefined) ?? null,
            expectedVersion: version(body), actor: 'staff', actorUserId: caller.userId });
          await audit(tx, caller, 'appointments.appointment.rescheduled', id);
          return row;
        }
        case 'cancel': {
          const reason = body.reason ?? 'staff';
          if (reason !== 'customer' && reason !== 'staff' && reason !== 'other') throw new AppointmentError('invalid');
          const row = await cancelAppointment(tx, { ...base, reason, expectedVersion: version(body), actor: 'staff', actorUserId: caller.userId });
          await audit(tx, caller, 'appointments.appointment.cancelled', id, { reason });
          return row;
        }
        case 'outcome': {
          if (body.outcome !== 'completed' && body.outcome !== 'no_show') throw new AppointmentError('invalid');
          if (body.note != null && typeof body.note !== 'string') throw new AppointmentError('invalid');
          return markOutcome(tx, { ...base, outcome: body.outcome, note: body.note as string | null | undefined,
            expectedVersion: version(body), actorUserId: caller.userId });
        }
        case 'details': {
          if (body.outcome_note != null && typeof body.outcome_note !== 'string') throw new AppointmentError('invalid');
          if (body.feedback_score != null && typeof body.feedback_score !== 'number') throw new AppointmentError('invalid');
          return updateAppointmentDetails(tx, { ...base, outcomeNote: body.outcome_note as string | null | undefined,
            feedbackScore: body.feedback_score as number | null | undefined, actorUserId: caller.userId });
        }
        default:
          throw new AppointmentError('invalid');
      }
    });
    return json({ appointment: publicRow(appointment, true) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}

async function audit(
  tx: Parameters<Parameters<typeof inTenant>[1]>[0],
  caller: { accountId: string; userId: string },
  action: string,
  id: string,
  metadata: object = {},
) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${caller.accountId}::uuid,${caller.userId}::uuid,${action},${id},${JSON.stringify(metadata)}::jsonb)`;
}
