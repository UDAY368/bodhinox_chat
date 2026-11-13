// GET  /api/ai/assist/translate (agents and above, 'ai.assist') — whether translation is available
//   to this member now and the team language: 200 { ok, reason, language }. No provider call.
// POST /api/ai/assist/translate (agents and above, 'ai.assist', rate limited)
//   { conversationId, direction: 'incoming' } — the customer's latest messages in the team language;
//   { conversationId, direction: 'outgoing', text } — the member's draft (≤ 4000 characters) in the
//   language the customer writes in.
//   200 { ok: true, text, language, guardFlags } or 200 { ok: false, reason } (AiFallback.<reason>);
//   404 when the conversation is not the caller's; 400 bad input or no customer message.
// Nothing is sent or stored; the member puts the translated draft into the composer and presses Send.
// Session and CSRF are enforced by the proxy.

import { NextResponse } from 'next/server'
import { toErrorResponse } from '@/lib/auth/account'
import { assistCaller, failureResponse, invalidRequest, NO_STORE, UUID } from '@/lib/ai/assist/http'
import { DRAFT_MAX_CHARS, translateAvailability, translateDraft, translateIncoming } from '@/lib/ai/assist/translate'

export async function GET() {
  try {
    const caller = await assistCaller({ rateLimited: false })
    if ('response' in caller) return caller.response
    const { ctx } = caller
    return NextResponse.json(await translateAvailability({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }), { headers: NO_STORE })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const caller = await assistCaller({ rateLimited: true })
    if ('response' in caller) return caller.response
    const { ctx } = caller
    const body = await request.json().catch(() => null)
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!UUID.test(conversationId)) return invalidRequest()
    const member = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }
    let result
    if (body?.direction === 'incoming') result = await translateIncoming(member, conversationId)
    else if (body?.direction === 'outgoing' && typeof body.text === 'string' && body.text.trim() && body.text.length <= DRAFT_MAX_CHARS)
      result = await translateDraft(member, conversationId, body.text.trim())
    else return invalidRequest()
    if (!result.ok) return failureResponse(result)
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    return toErrorResponse(error)
  }
}
