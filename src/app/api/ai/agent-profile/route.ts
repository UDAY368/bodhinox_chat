import { NextResponse } from 'next/server'
import { getT } from '@/lib/i18n/translate'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AgentProfileError, emptyAgentProfile, loadAgentProfile, saveAgentProfile } from '@/lib/ai/agent-profile'

const t = getT('Api')

/**
 * GET /api/ai/agent-profile (any member)
 *
 * The workspace's AI agent profile. `saved` is false until an admin
 * saves it once; the profile then holds the defaults.
 */
export async function GET() {
  try {
    const { accountId, userId, role } = await getCurrentAccount()
    const profile = await loadAgentProfile({ accountId, userId, role })
    return NextResponse.json({ saved: profile !== null, profile: profile ?? emptyAgentProfile() })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PUT /api/ai/agent-profile (admin+)
 *
 * Partial update: fields left out keep their stored value and
 * handoff_rules merges over the stored rules. `complete_setup: true`
 * stamps setup_completed_at the first time.
 */
export async function PUT(request: Request) {
  try {
    const { accountId, userId, role } = await requireRole('admin')
    const limit = checkRateLimit(`ai-agent-profile:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => undefined)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 })
    }
    const profile = await saveAgentProfile({ accountId, userId, role }, body)
    return NextResponse.json({ saved: true, profile })
  } catch (err) {
    if (err instanceof AgentProfileError) return NextResponse.json({ error: err.message }, { status: err.status })
    return toErrorResponse(err)
  }
}
