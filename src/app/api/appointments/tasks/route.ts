// GET  /api/appointments/tasks?status=open|done|cancelled&appointment_id=&assigned_to=&limit= — (any member). 200 { tasks }.
// POST /api/appointments/tasks { title, kind?: 'manual'|'next_step'|'rebook', due_at?, assigned_to?, contact_id?, appointment_id? }
//   Agents and above with appointments.manage. A task on an appointment takes that appointment's contact. 201 { item }.
export const runtime = 'nodejs';

import { createTask, listTasks } from '@/lib/appointments/tasks';
import type { TaskStatus } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    const params = new URL(request.url).searchParams;
    const tasks = await inTenant(caller, (tx) => listTasks(tx, caller.accountId, {
      status: (params.get('status') as TaskStatus | null) ?? undefined,
      appointmentId: params.get('appointment_id') ?? undefined,
      assignedTo: params.get('assigned_to') ?? undefined,
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
    }));
    return json({ tasks });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'agent', mutation: true, permission: 'appointments.manage' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ item: await inTenant(caller, (tx) => createTask(tx, caller.accountId, caller.userId, body)) }, 201);
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
