// GET /api/appointments/intake-forms?q=&after= — published WhatsApp forms a service can send after a booking
//   is confirmed, by name, 25 per page (admins with appointments.settings). 200 { forms: [{ id, name, status }], next }.
export const runtime = 'nodejs';

import { intakeFormOptions } from '@/lib/appointments/connections';
import { appointmentErrorResponse, inTenant, json, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', permission: 'appointments.settings' });
    const params = new URL(request.url).searchParams;
    return json(await inTenant(caller, (tx) => intakeFormOptions(tx, caller.accountId, { q: params.get('q'), after: params.get('after') })));
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
