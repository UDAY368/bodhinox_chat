// GET /api/public/booking/<slug>/slots?service=&location=&staff=&from=YYYY-MM-DD&days=1..7
// Free times for one service the page lists, in the location's zone. Times
// and remaining capacity only. Read-only: booking re-checks under locks.

import { listSlots } from '@/lib/appointments/availability';
import { PUBLIC_SLOT_DAYS_MAX } from '@/lib/appointments/types';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  burstAllowed, inPublicTenant, isId, isLocalDate, json, notFound, publicError, publicSlots, resolvePage, tooMany,
} from '../../_lib/public';
import { pageOffers } from '../../_lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!burstAllowed('slots', request, RATE_LIMITS.bookingSlots)) return tooMany();
  const query = new URL(request.url).searchParams;
  const serviceId = query.get('service');
  const locationId = query.get('location');
  const staffId = query.get('staff') || undefined;
  const from = query.get('from') || undefined;
  const days = Number(query.get('days') ?? PUBLIC_SLOT_DAYS_MAX);
  if (!isId(serviceId) || !isId(locationId) || (staffId !== undefined && !isId(staffId)) || (from !== undefined && !isLocalDate(from))
    || !Number.isInteger(days) || days < 1 || days > PUBLIC_SLOT_DAYS_MAX) return json({ code: 'invalid' }, 400);
  try {
    const page = await resolvePage((await params).slug);
    if (!page) return notFound();
    const result = await inPublicTenant(page.accountId, async (tx) => {
      if (!await pageOffers(tx, page.accountId, page.pageId, serviceId, locationId)) return null;
      return listSlots(tx, page.accountId, { serviceId, locationId, staffId, fromDay: from, days });
    });
    if (!result) return notFound();
    return json({ timezone: result.timezone, slots: publicSlots(result.slots) });
  } catch (error) {
    return publicError(error, 'slots');
  }
}
