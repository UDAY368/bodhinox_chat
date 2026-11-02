import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { listTemplateEvents } from '@/lib/whatsapp/template-events'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/whatsapp/templates/[id]/events — the template's status
 * history, newest first (at most TEMPLATE_EVENTS_LIMIT rows).
 *
 * Any member may read it, like the template list itself. The template
 * is looked up in the caller's account first so another account's id
 * is a 404 rather than an empty list; RLS scopes the events too.
 *
 * 200 { events: [{ id, status, reason, quality_score, source, created_at }] }
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: t('templates.invalidId') }, { status: 400 })
    }
    const ctx = await requireRole('viewer')

    const { data: template, error } = await ctx.db
      .from('message_templates')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error || !template) {
      return NextResponse.json({ error: t('templates.notFound') }, { status: 404 })
    }

    const events = await listTemplateEvents(tenantOf(ctx), id)
    return NextResponse.json({ events })
  } catch (error) {
    return toErrorResponse(error)
  }
}
