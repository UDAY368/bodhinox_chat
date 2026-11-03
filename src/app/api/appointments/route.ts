// GET  /api/appointments?from=<ISO>&to=<ISO>&status=&staff_id=&location_id=&service_id=&needs_outcome=1
//   The schedule (any member; at most 62 days, 500 rows). 200 { appointments }. The staff note is
//   returned only to members with appointments.manage; contacts appear as id + name only.
// POST /api/appointments { contact_id, service_id, location_id, staff_id?, start_at }
//   Staff booking (agents and above with appointments.manage): confirmed at once; the customer's
//   confirmation and reminders are queued in the same transaction. 201 { appointment };
//   409 slot_unavailable | customer_conflict, 422 day_not_allowed, 429 too_many.
export const runtime = 'nodejs';

import { can } from '@/lib/auth/permissions';
import { bookAppointment } from '@/lib/appointments/booking';
import { listSchedule, parseScheduleFilter } from '@/lib/appointments/listing';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, mutationLimit, publicRow, readJson, staffCaller } from './_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    const filter = parseScheduleFilter(new URL(request.url).searchParams);
    const { rows, manage } = await inTenant(caller, async (tx) => ({
      rows: await listSchedule(tx, caller.accountId, filter),
      manage: await can(tx, caller, 'appointments.manage'),
    }));
    return json({ appointments: rows.map((r) => publicRow(r, manage)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent', mutation: true, permission: 'appointments.manage' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = (await readJson(request)) as Record<string, unknown> | null;
    const startAt = typeof body?.start_at === 'string' ? new Date(body.start_at) : null;
    if (!body || !isId(body.contact_id) || !isId(body.service_id) || !isId(body.location_id) || !startAt
      || Number.isNaN(startAt.getTime()) || (body.staff_id != null && !isId(body.staff_id))) throw new AppointmentError('invalid');
    const result = await inTenant(caller, async (tx) => {
      const [contact] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM contacts
        WHERE account_id=${caller.accountId}::uuid AND id=${body.contact_id as string}::uuid`;
      if (!contact) throw new AppointmentError('not_found');
      return bookAppointment(tx, {
        accountId: caller.accountId, source: 'staff', contactId: contact.id, serviceId: body.service_id as string,
        locationId: body.location_id as string, staffId: (body.staff_id as string | null | undefined) ?? null, startAt,
        actorUserId: caller.userId,
      });
    });
    return json({ appointment: publicRow(result.appointment, true) }, 201);
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
