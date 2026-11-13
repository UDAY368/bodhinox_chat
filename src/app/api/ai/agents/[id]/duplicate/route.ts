// POST /api/ai/agents/:id/duplicate — copy an agent with a free "<name> copy" name, switched off
//   (admin, rate limited, audited 'ai.agent_created'). 201 { agent }; 404; 409 20 agents already.

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { duplicateAgent } from '@/lib/ai/agents'
import { agentErrorResponse, NO_STORE } from '@/lib/ai/agents-http'

type Params = { params: Promise<{ id: string }> }

export async function POST(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    return NextResponse.json({ agent: await duplicateAgent(tenantOf(ctx), (await params).id) }, { status: 201, headers: NO_STORE })
  } catch (error) {
    return agentErrorResponse(error)
  }
}
