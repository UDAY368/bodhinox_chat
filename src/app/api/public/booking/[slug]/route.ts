// GET  /api/public/booking/<slug>  services, locations and practitioners on an active booking page.
// POST /api/public/booking/<slug>  hold a slot: { serviceId, locationId, staffId?, startAt, requestId, intake? }.
//   The hold has no contact and no phone (design D7); it is confirmed when the
//   customer sends "BOOK <code>" on WhatsApp. Replaying a requestId returns
//   the same hold. Anonymous: the proxy exempts this path, so Origin is
//   checked here.

import { assertOrigin } from '@/lib/auth/csrf';
import { bookAppointment } from '@/lib/appointments/booking';
import { sourceRefs } from '@/lib/appointments/keys';
import type { BookingIntake } from '@/lib/appointments/types';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  burstAllowed, enforceCreateLimit, holdClientHash, inPublicTenant, isId, json, notFound, publicError, readBody, resolvePage, tooMany,
} from '../_lib/public';
import { displayDigits, loadPublicPage, pageNumber, whatsAppLink } from '../_lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!burstAllowed('page', request, RATE_LIMITS.bookingSlots)) return tooMany();
  try {
    const page = await resolvePage((await params).slug);
    if (!page) return notFound();
    const view = await inPublicTenant(page.accountId, (tx) => loadPublicPage(tx, page.accountId, page.pageId));
    return view ? json(view) : notFound();
  } catch (error) {
    return publicError(error, 'page');
  }
}

function parseIntake(value: unknown): BookingIntake | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: BookingIntake = {};
  for (const [key, max] of [['name', 120], ['city', 80], ['state', 80]] as const) {
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined || field === null || field === '') continue;
    if (typeof field !== 'string' || field.length > max) return undefined;
    out[key] = field;
  }
  return out;
}

export async function POST(request: Request, { params }: Params) {
  try {
    assertOrigin(request);
    if (!burstAllowed('create', request, RATE_LIMITS.bookingCreate)) return tooMany();
    const body = await readBody(request);
    const startAt = typeof body?.startAt === 'string' && body.startAt.length <= 40 ? new Date(body.startAt) : null;
    const intake = parseIntake(body?.intake);
    if (!body || !isId(body.serviceId) || !isId(body.locationId) || !isId(body.requestId)
      || (body.staffId !== undefined && body.staffId !== null && !isId(body.staffId))
      || !startAt || Number.isNaN(startAt.getTime()) || intake === undefined) return json({ code: 'invalid' }, 400);
    const page = await resolvePage((await params).slug);
    if (!page) return notFound();
    await enforceCreateLimit(request);
    const result = await inPublicTenant(page.accountId, async (tx) => {
      const { appointment } = await bookAppointment(tx, {
        accountId: page.accountId, source: 'public', serviceId: body.serviceId as string, locationId: body.locationId as string,
        staffId: (body.staffId as string | null | undefined) ?? null, startAt, bookingPageId: page.pageId, clientHash: holdClientHash(request),
        sourceRef: sourceRefs.public(page.pageId, (body.requestId as string).toLowerCase()), intake,
      });
      // A replayed request whose hold has moved on gets no code back.
      if (appointment.status !== 'held' || !appointment.hold_code || !appointment.hold_expires_at) return null;
      return { appointment, number: await pageNumber(tx, page.accountId, page.pageId) };
    });
    if (!result) return json({ code: 'hold_expired' }, 410);
    const { appointment, number } = result;
    const code = appointment.hold_code as string;
    return json({
      holdCode: code,
      holdExpiresAt: (appointment.hold_expires_at as Date).toISOString(),
      startAt: appointment.start_at.toISOString(),
      endAt: appointment.end_at.toISOString(),
      timezone: appointment.timezone,
      whatsappUrl: whatsAppLink(await displayDigits(number), code),
    }, 201);
  } catch (error) {
    return publicError(error, 'hold');
  }
}
