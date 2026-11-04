// GET /api/ai/assist/availability (agents and above, 'ai.assist')
//   Which assistant features this member can use right now:
//   200 { summary: { ok, reason }, suggest: { ok, reason } } where reason is an
//   AiFallback code when ok is false. Read-only: no provider call. The inbox
//   uses it to show Summarize and Suggest replies, and to keep the classic AI
//   draft when suggested replies are off.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { assistAvailability } from '@/lib/ai/assist/assist';
import { assistCaller, NO_STORE } from '@/lib/ai/assist/http';

export async function GET() {
  try {
    const caller = await assistCaller({ rateLimited: false });
    if ('response' in caller) return caller.response;
    const { ctx } = caller;
    return NextResponse.json(await assistAvailability({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }), { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
