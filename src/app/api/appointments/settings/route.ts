// GET   /api/appointments/settings — booking settings, defaults when unset (any member). 200 { settings }.
// PATCH /api/appointments/settings — any subset of the settings columns. Templates are set as
//   <slot>_template_name + <slot>_template_language (both, or name null to clear) and must be approved
//   UTILITY templates that pass appointmentTemplateRefusal: 400 { field, detail: <refusal code> | 'not_found' |
//   'not_approved' }. completed_deal_stage_id: a pipeline stage of this workspace, or null (404 not_found
//   for another workspace's stage). Admins with appointments.settings. 200 { settings }.
export const runtime = 'nodejs';

import { getSettings, saveSettings } from '@/lib/appointments/config';
import { getCompletedDealStage, setCompletedDealStage } from '@/lib/appointments/deals';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, mutationLimit, readJson, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    const settings = await inTenant(caller, async (tx) => ({
      ...(await getSettings(tx, caller.accountId)),
      completed_deal_stage_id: await getCompletedDealStage(tx, caller.accountId),
    }));
    return json({ settings });
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
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppointmentError('invalid');
    const { completed_deal_stage_id: stage, ...rest } = body as Record<string, unknown>;
    const hasStage = 'completed_deal_stage_id' in body;
    if (hasStage && stage !== null && !isId(stage)) throw new AppointmentError('invalid');
    const settings = await inTenant(caller, async (tx) => {
      const saved = Object.keys(rest).length || !hasStage
        ? await saveSettings(tx, caller.accountId, caller.userId, rest)
        : await getSettings(tx, caller.accountId);
      const completed = hasStage
        ? await setCompletedDealStage(tx, caller.accountId, caller.userId, stage as string | null)
        : await getCompletedDealStage(tx, caller.accountId);
      return { ...saved, completed_deal_stage_id: completed };
    });
    return json({ settings });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
