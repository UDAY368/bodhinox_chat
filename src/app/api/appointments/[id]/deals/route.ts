// GET /api/appointments/[id]/deals?q=&after= — open deals this booking can be linked to (the booking's
//   customer's own when it has one), newest first, 20 per page. Agents and above with appointments.manage.
//   200 { deals: [{ id, title, status, stage_name, contact_id }], next }. Another workspace's id is a 404.
export const runtime = 'nodejs';

import { dealOptions } from '@/lib/appointments/deals';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, staffCaller } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent', permission: 'appointments.manage' });
    if (!isId(id)) throw new AppointmentError('not_found');
    const params = new URL(request.url).searchParams;
    const result = await inTenant(caller, (tx) => dealOptions(tx, caller.accountId, id, { q: params.get('q'), after: params.get('after') }));
    return json(result);
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
