// GET /api/appointments/slots?service_id=&location_id=&from=YYYY-MM-DD&days=1..14&staff_id=&exclude=<appointment id>
//   Bookable starts for staff (any member). `from` is a local date in the location's zone (default
//   today there); `exclude` ignores one appointment's own time when rescheduling it.
//   200 { timezone, slots: [{ startAt, endAt, localDate, hhmm, staffIds, remaining }] }.
//   Slots are a preview: booking re-checks them under the locks.
export const runtime = 'nodejs';

import { listSlots } from '@/lib/appointments/availability';
import { AppointmentError, STAFF_SLOT_DAYS_MAX } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    const params = new URL(request.url).searchParams;
    const serviceId = params.get('service_id'), locationId = params.get('location_id');
    const staffId = params.get('staff_id') || undefined, exclude = params.get('exclude') || undefined;
    const from = params.get('from') || undefined;
    const days = Number(params.get('days') ?? '7');
    if (!isId(serviceId) || !isId(locationId) || (staffId && !isId(staffId)) || (exclude && !isId(exclude))
      || (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || !Number.isInteger(days) || days < 1 || days > STAFF_SLOT_DAYS_MAX)
      throw new AppointmentError('invalid');
    const result = await inTenant(caller, (tx) => listSlots(tx, caller.accountId, {
      serviceId, locationId, fromDay: from, days, staffId, excludeAppointmentId: exclude,
    }));
    return json(result);
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
