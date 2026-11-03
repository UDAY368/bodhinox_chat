// GET /api/appointments/stats?from=YYYY-MM-DD&to=YYYY-MM-DD&service_id=
//   Booked / confirmed / cancelled / completed / no-show counts per service per local day (any member;
//   at most 366 days). 200 { rows, totals: { ..., no_show_rate: number | null } } — null shows as N/A.
export const runtime = 'nodejs';

import { appointmentStats } from '@/lib/appointments/stats';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, staffCaller } from '../_lib/http';

export async function GET(request: Request) {
  try {
    const caller = await staffCaller(request, { min: 'viewer' });
    const params = new URL(request.url).searchParams;
    const serviceId = params.get('service_id');
    if (serviceId && !isId(serviceId)) throw new AppointmentError('invalid');
    const result = await inTenant(caller, (tx) => appointmentStats(tx, caller.accountId, {
      from: params.get('from') ?? '', to: params.get('to') ?? '', serviceId,
    }));
    return json(result);
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
