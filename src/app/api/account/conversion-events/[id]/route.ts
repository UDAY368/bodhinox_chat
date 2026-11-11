// PATCH /api/account/conversion-events/[id] — admins (Origin + CSRF):
//   { name?, archived? } renames, archives (true) or restores (false) a type.
// Another workspace's id is 404 (RLS hides it). Stage 5 (5F).

import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { ConversionEventError, conversionEventErrorResponse, updateConversionEventType } from '@/lib/analytics/conversion-events';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
    if (!UUID.test(id)) throw new ConversionEventError('not_found');
    const body = (await request.json().catch(() => null)) as { name?: unknown; archived?: unknown } | null;
    if (!body || typeof body !== 'object' || (body.name === undefined && body.archived === undefined))
      throw new ConversionEventError('invalid_name');
    await updateConversionEventType({ accountId: session.accountId, userId: session.userId, role: session.role }, id, body);
    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return conversionEventErrorResponse(error) ?? toErrorResponse(error);
  }
}
