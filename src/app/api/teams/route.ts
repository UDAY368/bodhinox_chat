// GET /api/teams (any member) — 200 { teams: [{ id, name, member_ids, created_at }] }.
//   Agents need it for the inbox "My team" filter; it carries no contact data.
// POST /api/teams (admins and owners) — { name, member_ids? }. 201 { team };
//   400 { error, code }; 409 { code: 'duplicate_name' | 'limit' }.

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { createTeam, listTeams, parseTeamInput } from '@/lib/teams/teams';
import { noStore, teamError } from '@/lib/teams/http';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({ teams: await listTeams(tenantOf(ctx)) }, { headers: noStore });
  } catch (error) {
    return teamError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`teams:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseTeamInput(await request.json().catch(() => null), false);
    return NextResponse.json({ team: await createTeam(tenantOf(ctx), input) }, { status: 201, headers: noStore });
  } catch (error) {
    return teamError(error);
  }
}
