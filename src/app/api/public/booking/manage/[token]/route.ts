// GET  /api/public/booking/manage/<token>  the customer's booking (no customer data; tokens get forwarded).
// POST /api/public/booking/manage/<token>  { action: 'cancel' | 'reschedule', startAt?, expectedVersion }.
// The token is the manage-link token (design D8); only its sha256 reaches the
// database. Customer changes respect the workspace's cancel cutoff.

import { assertOrigin } from '@/lib/auth/csrf';
import { cancelAppointment, rescheduleAppointment } from '@/lib/appointments/booking';
import { isManageTokenFormat } from '@/lib/appointments/tokens';
import { RATE_LIMITS } from '@/lib/rate-limit';
import {
  burstAllowed, enforceManageLimit, inPublicTenant, json, notFound, publicError, readBody, resolveToken, tooMany,
} from '../../_lib/public';
import { loadManageView } from '../../_lib/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ token: string }> };

export async function GET(request: Request, { params }: Params) {
  if (!burstAllowed('manage', request, RATE_LIMITS.bookingManage)) return tooMany();
  try {
    const { token } = await params;
    if (!isManageTokenFormat(token)) return notFound();
    await enforceManageLimit(token);
    const ref = await resolveToken(token);
    if (!ref) return notFound();
    const view = await inPublicTenant(ref.accountId, (tx) => loadManageView(tx, ref.accountId, ref.appointmentId));
    return view ? json(view) : notFound();
  } catch (error) {
    return publicError(error, 'manage');
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    assertOrigin(request);
    if (!burstAllowed('manage', request, RATE_LIMITS.bookingManage)) return tooMany();
    const { token } = await params;
    if (!isManageTokenFormat(token)) return notFound();
    const body = await readBody(request);
    const action = body?.action;
    const expectedVersion = body?.expectedVersion;
    const startAt = typeof body?.startAt === 'string' && body.startAt.length <= 40 ? new Date(body.startAt) : null;
    if (!body || (action !== 'cancel' && action !== 'reschedule') || typeof expectedVersion !== 'number'
      || !Number.isInteger(expectedVersion) || expectedVersion < 1
      || (action === 'reschedule' && (!startAt || Number.isNaN(startAt.getTime())))) return json({ code: 'invalid' }, 400);
    await enforceManageLimit(token);
    const ref = await resolveToken(token);
    if (!ref) return notFound();
    const view = await inPublicTenant(ref.accountId, async (tx) => {
      const base = { accountId: ref.accountId, appointmentId: ref.appointmentId, actor: 'customer' as const, expectedVersion };
      if (action === 'cancel') await cancelAppointment(tx, { ...base, reason: 'customer' });
      // The practitioner stays the same; only the time moves.
      else await rescheduleAppointment(tx, { ...base, startAt: startAt as Date });
      return loadManageView(tx, ref.accountId, ref.appointmentId);
    });
    return view ? json(view) : notFound();
  } catch (error) {
    return publicError(error, 'manage_change');
  }
}
