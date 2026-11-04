// POST /api/appointments/[id]/meeting — staff actions on an appointment's Zoom
// meeting (design §2, a meeting the sync job could not settle). Agents and above
// with appointments.manage; session CSRF (also enforced by the proxy).
//   { action:'recreate' }  "Create again": the old attempt becomes failed and a
//                           new meeting (new reference) is queued
//   { action:'use_link' }  "Use supplied link": the meeting is set to manual and
//                           the link staff supplied before Zoom is restored
// 200 { status:'ok' }; 404 another workspace's or an unknown appointment; Zoom
// refusals are code-only (Validation.meetings.*). Audited.
export const runtime = 'nodejs';

import { MeetingError } from '@/lib/meetings/types';
// useSuppliedLink is a service, not a React hook; aliased so the hooks lint rule does not misread it.
import { recreateMeeting, useSuppliedLink as restoreSuppliedLink } from '@/lib/meetings/sync';
import { getT } from '@/lib/i18n/translate';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, mutationLimit, readJson, staffCaller } from '../../_lib/http';

type Context = { params: Promise<{ id: string }> };
const tm = getT('Validation.meetings');

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const caller = await staffCaller(request, { min: 'agent', mutation: true, permission: 'appointments.manage' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    if (!isId(id)) throw new AppointmentError('not_found');
    const body = (await readJson(request)) as Record<string, unknown> | null;
    const action = body && typeof body === 'object' ? body.action : null;
    if (action !== 'recreate' && action !== 'use_link') throw new AppointmentError('invalid');
    // The appointment must be this workspace's (and the plan must include appointments) before any meeting work.
    const exists = await inTenant(caller, async (tx) => (await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM appointments WHERE account_id=${caller.accountId}::uuid AND id=${id}::uuid`).length > 0);
    if (!exists) throw new AppointmentError('not_found');
    const actor = { accountId: caller.accountId, userId: caller.userId, role: caller.role };
    if (action === 'recreate') await recreateMeeting(actor, id);
    else await restoreSuppliedLink(actor, id);
    await inTenant(caller, (tx) => tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${caller.accountId}::uuid,${caller.userId}::uuid,${`appointments.meeting.${action}`},${id},'{}'::jsonb)`);
    return json({ status: 'ok' });
  } catch (error) {
    if (error instanceof MeetingError) return json({ error: tm(error.code), code: error.code }, error.status);
    return appointmentErrorResponse(error);
  }
}
