// POST /api/ai/assist/suggestions/:id/decision (agents and above, 'ai.assist')
//   Body { decision: 'rejected' }. Records that the member dismissed a
//   suggestion still shown: 200 { ok: true }; 404 when it is not in the
//   caller's workspace; 409 when it was already used or decided. Accepting
//   happens only through a send (the send route records it). Session and CSRF
//   are enforced by the proxy.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { assistCaller, invalidRequest, NO_STORE, UUID } from '@/lib/ai/assist/http';
import { rejectSuggestion } from '@/lib/ai/assist/suggestions';

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const caller = await assistCaller({ rateLimited: false });
    if ('response' in caller) return caller.response;
    const { ctx } = caller;
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!UUID.test(id) || body?.decision !== 'rejected') return invalidRequest();
    const result = await withTenant(tenantOf(ctx), (tx) => rejectSuggestion(tx, { accountId: ctx.accountId, userId: ctx.userId }, id));
    if (result === 'not_found') return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404, headers: NO_STORE });
    if (result === 'already_decided') return NextResponse.json({ ok: false, reason: 'already_decided' }, { status: 409, headers: NO_STORE });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
