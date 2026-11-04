// GET  /api/appointments/staff — practitioners, archived last (any member). 200 { staff }.
//   meeting_host_email (a staff member's Zoom login) is returned to agents and above only;
//   viewers get the row without it (Phase 9: members below agent read nothing new).
// POST /api/appointments/staff { display_name, user_id? (a current member), meeting_host_email? } — admins with
//   appointments.settings, within the plan's appointment_staff limit (402 when reached). 201 { item }.
export const runtime = 'nodejs';

import { hasMinRole } from '@/lib/auth/roles';
import { createStaff, listStaff } from '@/lib/appointments/config';
import { appointmentErrorResponse, configCollection, inTenant, json, staffCaller } from '../_lib/http';

// Only POST is taken from the factory; its list never runs (GET below is role-aware).
const handlers = configCollection({ key: 'staff', list: (tx, accountId) => listStaff(tx, accountId, { withHost: false }), create: createStaff });

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    const withHost = hasMinRole(caller.role, 'agent');
    const staff = await inTenant(caller, (tx) => listStaff(tx, caller.accountId, { withHost }));
    return json({ staff });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}

export const POST = handlers.POST;
