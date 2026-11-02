import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { recordTemplateEvents } from '@/lib/whatsapp/template-events'
import { parseTemplateDraft } from '@/lib/whatsapp/template-draft'
import { templateRowFields } from '@/lib/whatsapp/template-row'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/whatsapp/templates/draft — save a template locally as
 * status DRAFT without calling Meta.
 *
 * Body: a TemplatePayload, plus `id` to update an existing draft.
 * Drafts may be incomplete, so only name, language, category and kind
 * are validated (with field shapes checked so nothing malformed is
 * stored); the full validators run when the draft is submitted via
 * POST /api/whatsapp/templates/submit with the same `id`.
 *
 * A template that has a meta_template_id is no longer a draft: it
 * changes only through PATCH /api/whatsapp/templates/[id] (409 here).
 * A new draft never overwrites another template with the same
 * (name, language) — that is a 409 too.
 *
 * Same role as creating templates: 'admin'. Records a 'draft' status
 * event when the template's status history changes.
 *
 * 200 { success: true, template }
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const { db, accountId, userId } = ctx

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: t('templates.invalidJsonBody') }, { status: 400 })
    }

    const parsed = parseTemplateDraft(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const { id, payload } = parsed
    if (id !== null && !UUID_RE.test(id)) {
      return NextResponse.json({ error: t('templates.invalidId') }, { status: 400 })
    }

    if (id) {
      const { data: existing, error: lookupErr } = await db
        .from('message_templates')
        .select('id, meta_template_id')
        .eq('id', id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (lookupErr || !existing) {
        return NextResponse.json({ error: t('templates.notFound') }, { status: 404 })
      }
      if (existing.meta_template_id) {
        return NextResponse.json(
          { error: t('templates.draft.alreadySubmitted') },
          { status: 409 },
        )
      }
    }

    const { data: clash, error: clashErr } = await db
      .from('message_templates')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', payload.name)
      .eq('language', payload.language)
      .maybeSingle()
    if (clashErr) {
      return NextResponse.json({ error: t('templates.draft.saveFailed') }, { status: 500 })
    }
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: t('templates.draft.nameTaken') }, { status: 409 })
    }

    const fields = {
      name: payload.name,
      language: payload.language,
      ...templateRowFields(payload),
      status: 'DRAFT',
    }
    const { data: row, error: saveErr } = id
      ? await db
          .from('message_templates')
          .update(fields)
          .eq('id', id)
          .eq('account_id', accountId)
          // A submit that lands between the check above and this write
          // wins; the draft save then matches no row and fails.
          .is('meta_template_id', null)
          .select()
          .single()
      : await db
          .from('message_templates')
          .insert({ ...fields, account_id: accountId, user_id: userId })
          .select()
          .single()
    if (saveErr || !row) {
      // A concurrent save can still win the (account, name, language) race.
      const conflict = (saveErr as { code?: string } | null)?.code === '23505'
      return NextResponse.json(
        { error: t(conflict ? 'templates.draft.nameTaken' : 'templates.draft.saveFailed') },
        { status: conflict ? 409 : 500 },
      )
    }

    await recordTemplateEvents(tenantOf(ctx), [
      { templateId: row.id, status: 'DRAFT', source: 'draft' },
    ])

    return NextResponse.json({ success: true, template: row })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error saving template draft:', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({ error: t('templates.draft.saveFailed') }, { status: 500 })
  }
}
