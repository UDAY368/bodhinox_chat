// POST /api/ai/assist/summary (agents and above, 'ai.assist')
//   Body { conversationId }. A staff-facing summary of the conversation:
//   200 { ok: true, suggestionId, summary, openQuestions, nextSteps, dataAsOf,
//   guardFlags, sensitive } or 200 { ok: false, reason } (AiFallback.<reason>:
//   switched off, not configured, limit reached, provider failure...).
//   404 when the conversation is not the caller's, 400 when it has no messages.
//   Needs the workspace's summaries switch and a configured key; nothing is
//   sent to the customer. Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { summarizeConversation } from '@/lib/ai/assist/assist';
import { assistCaller, failureResponse, invalidRequest, NO_STORE, UUID } from '@/lib/ai/assist/http';

export async function POST(request: Request) {
  try {
    const caller = await assistCaller({ rateLimited: true });
    if ('response' in caller) return caller.response;
    const { ctx } = caller;
    const body = await request.json().catch(() => null);
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
    if (!UUID.test(conversationId)) return invalidRequest();
    const result = await summarizeConversation({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, conversationId);
    if (!result.ok) return failureResponse(result);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
