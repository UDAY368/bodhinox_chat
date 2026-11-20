// GET /api/public/booking/manage/<token>/ics  the booking as a calendar file.
// Token-checked exactly like the manage route (format, per-token durable
// limit, sha256 lookup, plan and suspension). Only confirmed (or finished)
// bookings get a file; the event carries service, place and the manage link,
// never customer data.

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { icsForAppointment } from '@/lib/appointments/calendar';
import { isManageTokenFormat, manageUrl } from '@/lib/appointments/tokens';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  burstAllowed, enforceManageLimit, inPublicTenant, NO_STORE, notFound, publicError, resolveToken, tooMany,
} from '../../../_lib/public';
import { loadManageView } from '../../../_lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!(await burstAllowed('manage', request, RATE_LIMITS.bookingManage))) return tooMany();
  try {
    const { token } = await params;
    if (!isManageTokenFormat(token)) return notFound();
    await enforceManageLimit(token);
    const ref = await resolveToken(token);
    if (!ref) return notFound();
    const view = await inPublicTenant(ref.accountId, (tx) => loadManageView(tx, ref.accountId, ref.appointmentId));
    if (!view || (view.status !== 'confirmed' && view.status !== 'completed')) return notFound();
    const place = view.online ? null : [view.location?.name, view.location?.address].filter(Boolean).join(', ') || null;
    const link = manageUrl(token);
    const body = icsForAppointment({
      // Stable per booking (re-importing updates the event) without exposing the id.
      uid: `${createHash('sha256').update(`appointment-ics:${ref.appointmentId}`).digest('hex').slice(0, 32)}@bodhinox`,
      title: `${view.serviceName} · ${view.businessName}`,
      start: view.startAt,
      end: view.endAt,
      location: place,
      description: [view.practitioner, view.meetingUrl].filter(Boolean).join('\n') || null,
      url: link,
    });
    return new NextResponse(body, {
      status: 200,
      headers: { ...NO_STORE, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="booking.ics"' },
    });
  } catch (error) {
    return publicError(error, 'manage_ics');
  }
}
