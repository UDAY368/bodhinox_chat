// POST /api/ai/assist/replies (agents and above, 'ai.assist')
//   Body { conversationId, count?: 1-3 }. Suggested replies to the latest
//   customer message, for a member to review, edit and send themselves:
//   200 { ok: true, options: [{ suggestionId, text }], citations, guardFlags,
//   routeToStaff: null } — or, when the latest customer message is a health or
//   other sensitive topic, no text at all and
//   routeToStaff: { suggestionId, categories }. 200 { ok: false, reason } for a
//   fallback (AiFallback.<reason>). 404 when the conversation is not the
//   caller's, 400 when the customer has not written. Nothing is ever sent from
//   here. Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { suggestReplies } from '@/lib/ai/assist/assist';
import { assistCaller, failureResponse, invalidRequest, NO_STORE, UUID } from '@/lib/ai/assist/http';
import { MAX_REPLY_OPTIONS } from '@/lib/ai/assist/prompts';

export async function POST(request: Request) {
  try {
    const caller = await assistCaller({ rateLimited: true });
    if ('response' in caller) return caller.response;
    const { ctx } = caller;
    const body = await request.json().catch(() => null);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    const count = body?.count === undefined ? MAX_REPLY_OPTIONS : body.count;
    if (!UUID.test(conversationId) || !Number.isInteger(count) || count < 1 || count > MAX_REPLY_OPTIONS) return invalidRequest();
    const result = await suggestReplies({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, conversationId, count);
    if (!result.ok) return failureResponse(result);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
