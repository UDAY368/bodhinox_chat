// PUT /api/teams/[id] (admins and owners) — { name?, member_ids? }; member_ids replaces
//   the whole list. 200 { team }; 400/404/409 { error, code }.
// DELETE /api/teams/[id] (admins and owners) — 200 { success: true }; 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { deleteTeam, parseTeamInput, updateTeam } from '@/lib/teams/teams';
import { noStore, teamError } from '@/lib/teams/http';

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`teams:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const input = parseTeamInput(await request.json().catch(() => null), true);
    return NextResponse.json({ team: await updateTeam(tenantOf(ctx), id, input) }, { headers: noStore });
  } catch (error) {
    return teamError(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;
    await deleteTeam(tenantOf(ctx), id);
    return NextResponse.json({ success: true }, { headers: noStore });
  } catch (error) {
    return teamError(error);
  }
}
