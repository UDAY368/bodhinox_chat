// GET /api/appointments/hours — weekly hours per (practitioner or pool) x location (any member). 200 { hours }.
// PUT /api/appointments/hours { location_id, staff_id? (omit/null = pool), hours: WorkingHours | null }
//   Same shape as inbox working hours ({"mon":[{"start":"09:00","end":"13:00"}]}, end may be "24:00",
//   at most 4 ranges a day); null clears. Admins with appointments.settings. 200 { item }.
export const runtime = 'nodejs';

import { listHours, setHours } from '@/lib/appointments/config';
import { appointmentErrorResponse, configCollection, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export const GET = configCollection({ key: 'hours', list: listHours }).GET;

export async function PUT(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'appointments.settings' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ item: await inTenant(caller, (tx) => setHours(tx, caller.accountId, caller.userId, body)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
