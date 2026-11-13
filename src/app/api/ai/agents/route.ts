// GET  /api/ai/agents — the workspace's AI agents in answering order (any member). An admin's
//   first visit creates the default agent (the original single agent). Admins also get each
//   agent's last-30-day numbers from the AI activity log.
//   200 { agents: [{ id, name, role, instructions, tone, channels, hours: { mode, from, to },
//         handoff_rules, enabled, is_default, position, stats: { handled, solved } | null }], profile_saved }
// POST /api/ai/agents — add an agent, switched off (admin, rate limited, audited 'ai.agent_created').
//   { name, instructions, role?, tone?, channels?, hours?, handoff_rules?, enabled? }
//   201 { agent }; 400 invalid; 409 name taken or 20 agents already.
// Session and CSRF for mutations are enforced by the proxy.

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createAgent, listAgents, parseAgentInput } from '@/lib/ai/agents'
import { agentErrorResponse, NO_STORE } from '@/lib/ai/agents-http'

export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    return NextResponse.json(await listAgents(tenantOf(ctx)), { headers: NO_STORE })
  } catch (error) {
    return agentErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const limit = checkRateLimit(`ai-agents:write:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const input = parseAgentInput(await request.json().catch(() => null), true)
    return NextResponse.json({ agent: await createAgent(tenantOf(ctx), input) }, { status: 201, headers: NO_STORE })
  } catch (error) {
    return agentErrorResponse(error)
  }
}
