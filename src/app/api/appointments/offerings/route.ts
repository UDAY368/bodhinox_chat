// GET /api/appointments/offerings — who offers which service where (any member). 200 { offerings }.
// PUT /api/appointments/offerings { service_id, location_id, pooled: boolean, staff_ids?: uuid[] }
//   Replace one (service, location): a shared pool, or the listed practitioners, never both.
//   Admins with appointments.settings. 200 { offerings } for that pair.
export const runtime = 'nodejs';

import { listOfferings, setOfferings } from '@/lib/appointments/config';
import { appointmentErrorResponse, configCollection, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export const GET = configCollection({ key: 'offerings', list: listOfferings }).GET;

export async function PUT(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'appointments.settings' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ offerings: await inTenant(caller, (tx) => setOfferings(tx, caller.accountId, caller.userId, body)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
