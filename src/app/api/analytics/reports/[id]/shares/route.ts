// /api/analytics/reports/[id]/shares — share one ready report inside the workspace (admins and owners).
//   GET   { shares: ReportShare[] } for the report.
//   POST  { min_role: viewer|agent|admin, expires_in_hours: 1-168 } creates a
//         share; min_role cannot be below the lowest role that sees the same
//         data live, and the share never outlives the report. 201
//         { share: { ...ReportShare, url } }. The link carries only the share
//         id: opening it needs a live session in this workspace at min_role.
// 400 invalid input or role too low, 403 below admin, 404 unknown report,
// 409 report not ready, 429 too many requests.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { createShare, listShares } from '@/lib/analytics/report-shares';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { shareErrorResponse } from './errors';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const { id } = await params;
    try {
      return NextResponse.json({ shares: await listShares(session, id) }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      return shareErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError();
    const limit = checkRateLimit(`analyticsReportShares:${session.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    try {
      const share = await createShare(session, id, { minRole: input.min_role, expiresInHours: input.expires_in_hours });
      return NextResponse.json({ share }, { status: 201 });
    } catch (error) {
      return shareErrorResponse(error);
    }
  } catch (error) {
    return toErrorResponse(error);
  }
}
