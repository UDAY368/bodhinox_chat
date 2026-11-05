import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { requestMeter, ROUTE_GENERATION_TOKENS } from '@/lib/ai/budget'
import { AiError } from '@/lib/ai/types'
import {
  CAMPAIGN_AUDIENCE_MAX,
  CAMPAIGN_GOAL_MAX,
  safeTimeZone,
  suggestCampaign,
  type CampaignTemplate,
} from '@/lib/ai/campaign-assistant'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const TEMPLATE_COLUMNS = 'id,name,language,category,body_text,header_type,header_content,buttons,template_kind,cards,lto'

/**
 * POST /api/ai/campaign-assistant  (agent+, the same role that creates campaigns)
 *
 * Body: { goal: string, audience?: string, timezone?: IANA zone }
 * Returns { draft, template, issues } — a suggestion only. It never creates,
 * schedules or sends a campaign and never saves a segment; the wizard
 * applies the draft and the user reviews every step. Each request is billed
 * as one AI message (its retry included). Goal, prompt and output are never logged.
 */
export async function POST(request: Request) {
  try {
    const { db, accountId, userId } = await requireRole('agent')

    const userLimit = checkRateLimit(`ai-campaign-assistant:${userId}`, RATE_LIMITS.aiDraft)
    if (!userLimit.success) return rateLimitResponse(userLimit)
    const accountLimit = checkRateLimit(`ai-draft-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const goal = body && typeof body.goal === 'string' ? body.goal.trim() : ''
    const audience = body && typeof body.audience === 'string' ? body.audience.trim() : ''
    if (!goal) {
      return NextResponse.json({ error: t('aiAssist.goalRequired'), code: 'goal_required' }, { status: 400 })
    }
    if (goal.length > CAMPAIGN_GOAL_MAX || audience.length > CAMPAIGN_AUDIENCE_MAX) {
      return NextResponse.json(
        { error: t('aiAssist.goalTooLong', { max: CAMPAIGN_GOAL_MAX }), code: 'goal_too_long' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(db, accountId, { requireActive: false }).catch(() => {
      throw new AiError(t('ai.storedKeyUndecryptable'), { code: 'key_decrypt_failed', status: 400 })
    })
    if (!config) {
      return NextResponse.json({ error: t('ai.noAgentConfigured'), code: 'ai_not_configured' }, { status: 400 })
    }

    // RLS scopes every read to the caller's workspace.
    const [templatesRes, tagsRes, listsRes, fieldsRes] = await Promise.all([
      db.from('message_templates').select(TEMPLATE_COLUMNS).eq('status', 'APPROVED').order('created_at', { ascending: false }).limit(50),
      db.from('tags').select('id,name').is('archived_at', null).limit(100),
      db.from('contact_lists').select('id,name').is('archived_at', null).limit(100),
      db.from('custom_fields').select('id,field_name').limit(100),
    ])
    if (templatesRes.error) {
      return NextResponse.json({ error: t('aiAssist.loadFailed'), code: 'load_failed' }, { status: 500 })
    }
    const templates = (templatesRes.data ?? []) as CampaignTemplate[]
    if (templates.length === 0) {
      return NextResponse.json({ error: t('aiAssist.noApprovedTemplates'), code: 'no_approved_templates' }, { status: 400 })
    }

    // One AI message per request (a corrective retry included), held before the
    // first model call and settled once with every attempt's tokens.
    const meter = requestMeter(accountId, ROUTE_GENERATION_TOKENS, { conversationId: null, mode: 'draft', provider: config.provider, model: config.model })
    const { draft, issues } = await suggestCampaign({
      config,
      goal,
      audience,
      context: {
        templates,
        tags: (tagsRes.data ?? []) as Array<{ id: string; name: string }>,
        lists: (listsRes.data ?? []) as Array<{ id: string; name: string }>,
        customFields: (fieldsRes.data ?? []) as Array<{ id: string; field_name: string }>,
        now: new Date(),
        timezone: safeTimeZone(body?.timezone),
      },
      hooks: meter.hooks,
    }).catch(async (error: unknown) => {
      await meter.finish(error)
      throw error
    })
    await meter.finish()

    // The full approved row, so the wizard can select it like a manual pick.
    const { data: template } = await db.from('message_templates').select('*').eq('id', draft.templateId).eq('status', 'APPROVED').maybeSingle()
    if (!template) {
      return NextResponse.json({ error: t('aiAssist.noApprovedTemplates'), code: 'no_approved_templates' }, { status: 409 })
    }
    return NextResponse.json({ draft, template, issues })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
