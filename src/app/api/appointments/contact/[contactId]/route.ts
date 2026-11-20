// GET /api/appointments/contact/[contactId]  one contact's bookings for the contact card (any member).
//   No kind: 200 { upcoming: { items, next }, past: { items, next } }, each the first `limit` (default 3, max 20).
//   ?kind=upcoming|past&cursor=<next>&limit=  200 { items, next } for one list's next page.
//   Items carry id, service_name, start_at, end_at, timezone, status, payment_status only.
// Another workspace's contact is a 404.
export const runtime = 'nodejs';

import { clampLimit, contactBookings } from '@/lib/appointments/contact-bookings';
import { AppointmentError } from '@/lib/appointments/types';
import { appointmentErrorResponse, inTenant, isId, json, staffCaller } from '../../_lib/http';

type Context = { params: Promise<{ contactId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { contactId } = await context.params;
    const caller = await staffCaller(request, { min: 'viewer' });
    if (!isId(contactId)) throw new AppointmentError('not_found');
    const params = new URL(request.url).searchParams;
    const kind = params.get('kind');
    const limit = clampLimit(params.get('limit'));
    if (kind !== null && kind !== 'upcoming' && kind !== 'past') throw new AppointmentError('invalid');
    if (!kind && params.get('cursor')) throw new AppointmentError('invalid');
    const result = await inTenant(caller, async (tx) => {
      if (kind) return contactBookings(tx, caller.accountId, contactId, { kind, limit, cursor: params.get('cursor') });
      const upcoming = await contactBookings(tx, caller.accountId, contactId, { kind: 'upcoming', limit });
      const past = await contactBookings(tx, caller.accountId, contactId, { kind: 'past', limit });
      return { upcoming, past };
    });
    return json(result);
  } catch (error) {
    return appointmentErrorResponse(error);
  }
}
