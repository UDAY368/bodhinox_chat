// GET /api/public/booking/manage/<token>/slots?from=YYYY-MM-DD&days=1..7
// Free times to move a confirmed booking to: same service, location and
// practitioner, excluding the booking itself. Refused (conflict) once the
// booking can no longer be changed online.

import { listSlots } from '@/lib/appointments/availability';
import { isManageTokenFormat } from '@/lib/appointments/tokens';
import { AppointmentError, PUBLIC_SLOT_DAYS_MAX } from '@/lib/appointments/types';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  burstAllowed, enforceManageLimit, inPublicTenant, isLocalDate, json, notFound, publicError, publicSlots, resolveToken, tooMany,
} from '../../../_lib/public';
import { loadManageView, manageRow } from '../../../_lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!burstAllowed('manage', request, RATE_LIMITS.bookingManage)) return tooMany();
  const query = new URL(request.url).searchParams;
  const from = query.get('from') || undefined;
  const days = Number(query.get('days') ?? PUBLIC_SLOT_DAYS_MAX);
  if ((from !== undefined && !isLocalDate(from)) || !Number.isInteger(days) || days < 1 || days > PUBLIC_SLOT_DAYS_MAX)
    return json({ code: 'invalid' }, 400);
  try {
    const { token } = await params;
    if (!isManageTokenFormat(token)) return notFound();
    await enforceManageLimit(token);
    const ref = await resolveToken(token);
    if (!ref) return notFound();
    const result = await inPublicTenant(ref.accountId, async (tx) => {
      const row = await manageRow(tx, ref.accountId, ref.appointmentId);
      if (!row) return null;
      const view = await loadManageView(tx, ref.accountId, ref.appointmentId);
      if (!view?.canChange) throw new AppointmentError('conflict');
      return listSlots(tx, ref.accountId, { serviceId: row.service_id, locationId: row.location_id, staffId: row.staff_id ?? undefined,
        fromDay: from, days, excludeAppointmentId: row.id });
    });
    if (!result) return notFound();
    return json({ timezone: result.timezone, slots: publicSlots(result.slots) });
  } catch (error) {
    return publicError(error, 'manage_slots');
  }
}
