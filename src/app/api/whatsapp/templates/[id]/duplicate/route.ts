import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { recordTemplateEvents } from '@/lib/whatsapp/template-events'
import { duplicateTemplateName } from '@/lib/whatsapp/template-draft'
import { TEMPLATE_CONTENT_COLUMNS } from '@/lib/whatsapp/template-row'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/whatsapp/templates/[id]/duplicate — copy a template into a
 * new local DRAFT named `<name>_copy` (then `_copy_2`, ...) in the same
 * language.
 *
 * Every content column is copied, including kind, carousel cards,
 * authentication options and the limited-time offer. Nothing from the
 * Meta lifecycle is: no meta_template_id, status DRAFT, and no
 * rejection reason, quality score or submission error.
 *
 * Same role as creating templates ('admin'); another account's id is
 * a 404. 200 { success: true, template }.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: t('templates.invalidId') }, { status: 400 })
    }
    const ctx = await requireRole('admin')
    const { db, accountId, userId } = ctx

    const { data: source, error: lookupErr } = await db
      .from('message_templates')
      .select(TEMPLATE_CONTENT_COLUMNS)
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !source) {
      return NextResponse.json({ error: t('templates.notFound') }, { status: 404 })
    }

    // Every candidate keeps at least the first 500 characters of the
    // name, so a 400-character prefix finds them all. Names are
    // [a-z0-9_]; LIKE's `_` wildcard only widens the match.
    const { data: siblings, error: namesErr } = await db
      .from('message_templates')
      .select('name')
      .eq('account_id', accountId)
      .eq('language', source.language)
      .like('name', `${String(source.name).slice(0, 400)}%`)
      .limit(1000)
    if (namesErr) {
      return NextResponse.json({ error: t('templates.draft.duplicateFailed') }, { status: 500 })
    }
    const name = duplicateTemplateName(
      String(source.name),
      new Set((siblings ?? []).map((r) => String(r.name))),
    )
    if (!name) {
      return NextResponse.json({ error: t('templates.draft.nameTaken') }, { status: 409 })
    }

    const content: Record<string, unknown> = { ...source }
    delete content.id
    const { data: row, error: insErr } = await db
      .from('message_templates')
      .insert({
        ...content,
        name,
        account_id: accountId,
        user_id: userId,
        status: 'DRAFT',
        meta_template_id: null,
        rejection_reason: null,
        quality_score: null,
        submission_error: null,
        last_submitted_at: null,
      })
      .select()
      .single()
    if (insErr || !row) {
      const conflict = (insErr as { code?: string } | null)?.code === '23505'
      return NextResponse.json(
        { error: t(conflict ? 'templates.draft.nameTaken' : 'templates.draft.duplicateFailed') },
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
    console.error('Error duplicating template:', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({ error: t('templates.draft.duplicateFailed') }, { status: 500 })
  }
}
