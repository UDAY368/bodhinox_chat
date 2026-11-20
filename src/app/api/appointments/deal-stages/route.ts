// GET /api/appointments/deal-stages — pipeline stages for the "move the deal when completed" setting
//   (admins with appointments.settings). 200 { stages: [{ id, name, pipeline_id, pipeline_name }] } (at most 500).
export const runtime = 'nodejs';

import { listDealStages } from '@/lib/appointments/deals';
import { appointmentErrorResponse, inTenant, json, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'admin', permission: 'appointments.settings' });
    return json({ stages: await inTenant(caller, (tx) => listDealStages(tx, caller.accountId)) });
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
