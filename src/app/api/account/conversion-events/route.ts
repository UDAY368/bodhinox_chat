// GET  /api/account/conversion-events  — every member: the workspace's
//      conversion event types with their count over the last 30 days.
// POST /api/account/conversion-events  — admins (Origin + CSRF): { name }
//      adds a type. 409 name_taken, 422 invalid_name / limit_reached.
// Stage 5 (5F). Types are tenant rows under FORCE RLS; see
// src/lib/analytics/conversion-events.ts.

import { NextResponse } from 'next/server';
import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { conversionEventErrorResponse, createConversionEventType, listConversionEventTypes } from '@/lib/analytics/conversion-events';

export const runtime = 'nodejs';
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const types = await listConversionEventTypes({ accountId: session.accountId, userId: session.userId, role: session.role });
    return NextResponse.json({ types }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    const type = await createConversionEventType({ accountId: session.accountId, userId: session.userId, role: session.role }, body?.name);
    return NextResponse.json({ type }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return conversionEventErrorResponse(error) ?? toErrorResponse(error);
  }
}
