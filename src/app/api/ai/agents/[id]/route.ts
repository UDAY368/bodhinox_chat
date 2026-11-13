// GET    /api/ai/agents/:id — one agent (any member). 200 { agent }; 404 (also for another workspace's id).
// PATCH  /api/ai/agents/:id — edit any of { name, role, instructions, tone, channels, hours, handoff_rules,
//   enabled } and/or move it in the answering order { move: 'up' | 'down' } (admin, rate limited, audited
//   'ai.agent_updated'). The default agent's instructions, tone and handoff rules are the workspace profile.
//   200 { agent }; 400; 404; 409 name taken.
// DELETE /api/ai/agents/:id — delete an agent (admin, audited 'ai.agent_deleted'). 200 { success }; 404;
//   409 for the default agent.

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AgentError, deleteAgent, getAgent, parseAgentInput, updateAgent } from '@/lib/ai/agents'
import { agentErrorResponse, NO_STORE } from '@/lib/ai/agents-http'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('viewer')
    const agent = await getAgent(tenantOf(ctx), (await params).id)
    if (!agent) throw new AgentError('not_found')
    return NextResponse.json({ agent }, { headers: NO_STORE })
  } catch (error) {
    return agentErrorResponse(error)
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const body = await request.json().catch(() => null)
    const { move, ...rest } = (body && typeof body === 'object' && !Array.isArray(body) ? body : { invalid: true }) as Record<string, unknown>
    if (move !== undefined && move !== 'up' && move !== 'down') throw new AgentError('invalid_input')
    const input = move && Object.keys(rest).length === 0 ? {} : parseAgentInput(rest, false)
    const agent = await updateAgent(tenantOf(ctx), (await params).id, { ...input, ...(move ? { move } : {}) })
    return NextResponse.json({ agent }, { headers: NO_STORE })
  } catch (error) {
    return agentErrorResponse(error)
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    await deleteAgent(tenantOf(ctx), (await params).id)
    return NextResponse.json({ success: true })
  } catch (error) {
    return agentErrorResponse(error)
  }
}
