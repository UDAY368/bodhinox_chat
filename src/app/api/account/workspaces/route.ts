// POST /api/account/workspaces { name }: creates another workspace owned by the
// caller (Phase 14) and, for a cookie session, switches the session to it.
// Signed-in users with a verified email; rate limited and capped per owner. The workspace
// starts on NEW_WORKSPACE_PLAN, or the lowest plan when unset (same rule as signup).

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { assertMutation, requireSession } from '@/lib/auth/session';
import { switchTenant } from '@/lib/auth/service';
import { setAccessCookie } from '@/lib/auth/cookies';
import { AccountActionError, accountActionResponse } from '@/lib/account/deletion';
import { createWorkspace } from '@/lib/account/workspaces';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const body = z.object({ name: z.string().max(500) }).strict();

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    const limit = checkRateLimit(`account:createWorkspace:${session.userId}`, { limit: 5, windowMs: 60 * 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AccountActionError('invalid_name', 400);
    const created = await createWorkspace(session, parsed.data.name);
    const response = NextResponse.json({ ok: true, accountId: created.accountId, name: created.name }, { status: 201 });
    // A bearer client switches through /api/auth/switch itself; a cookie session moves now.
    if (!request.headers.get('authorization')) {
      const switched = await switchTenant(session, created.accountId);
      setAccessCookie(response, switched.accessToken);
    }
    return response;
  } catch (error) {
    return accountActionResponse(error);
  }
}
