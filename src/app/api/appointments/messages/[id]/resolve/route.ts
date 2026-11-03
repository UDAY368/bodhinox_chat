// POST /api/appointments/messages/[id]/resolve — admins with appointments.manage mark a blocked,
//   failed or outcome-unknown customer message as reconciled. Nothing is re-sent. 200 { message };
//   404 when unknown, already resolved, or not in a resolvable state.
export const runtime = 'nodejs';

import { resolveMessage } from '@/lib/appointments/listing';
import { appointmentErrorResponse, inTenant, json, mutationLimit, staffCaller } from '../../../_lib/http';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'appointments.manage' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const message = await inTenant(caller, (tx) => resolveMessage(tx, caller.accountId, caller.userId, id));
    return json({ message });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
