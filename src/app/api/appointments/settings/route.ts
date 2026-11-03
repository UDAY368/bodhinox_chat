// GET   /api/appointments/settings — booking settings, defaults when unset (any member). 200 { settings }.
// PATCH /api/appointments/settings — any subset of the settings columns. Templates are set as
//   <slot>_template_name + <slot>_template_language (both, or name null to clear) and must be approved
//   UTILITY templates that pass appointmentTemplateRefusal: 400 { field, detail: <refusal code> | 'not_found' |
//   'not_approved' }. Admins with appointments.settings. 200 { settings }.
export const runtime = 'nodejs';

import { getSettings, saveSettings } from '@/lib/appointments/config';
import { appointmentErrorResponse, inTenant, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    return json({ settings: await inTenant(caller, (tx) => getSettings(tx, caller.accountId)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', mutation: true, permission: 'appointments.settings' });
    const limited = mutationLimit(caller);
    if (limited) return limited;
    const body = await readJson(request);
    return json({ settings: await inTenant(caller, (tx) => saveSettings(tx, caller.accountId, caller.userId, body)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
