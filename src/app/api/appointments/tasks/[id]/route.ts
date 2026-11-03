// PATCH /api/appointments/tasks/[id] { title?, due_at?, assigned_to?, status? } — agents and above with
//   appointments.manage. 200 { item }.
export const runtime = 'nodejs';

import { updateTask } from '@/lib/appointments/tasks';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, mutationLimit, readJson, staffCaller } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent', mutation: true, permission: 'appointments.manage' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    if (!isId(id)) throw new AppointmentError('not_found');
    const body = await readJson(request);
    return json({ item: await inTenant(caller, (tx) => updateTask(tx, caller.accountId, id, body)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
