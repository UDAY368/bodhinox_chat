import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import {
  ensureCarouselCardHandles,
  ensureMediaHeaderHandle,
} from '@/lib/whatsapp/template-header-handle'
import { recordTemplateEvents } from '@/lib/whatsapp/template-events'
import { templateRowFields } from '@/lib/whatsapp/template-row'
import { tenantOf } from '@/lib/audience/http'
import { requirePermission } from '@/lib/auth/permissions'
import { getT } from '@/lib/i18n/translate'
import { loadTemplateNumberConfig } from '@/lib/whatsapp/template-number'

const t = getT('Api')

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 *
 * Both handlers require 'admin' (GHSA-m4fx-g6pr-hrw8): message
 * templates are settings-class data, and the Meta call happens before
 * the local mutation, so the admin-only message_templates_update /
 * _delete RLS policies were no backstop at all — a viewer or agent got
 * the remote edit or delete through and only the local write bounced.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: t('templates.invalidId') },
        { status: 400 },
      )
    }
    // Editing a template pushes a component replacement to Meta before
    // anything is written locally, so the role has to be checked here.
    const ctx = await requireRole('admin')
    // An edit re-submits the template to Meta for review, so it needs the
    // same 'templates.submit' permission as the first submission.
    await requirePermission(tenantOf(ctx), 'templates.submit')
    const { db, accountId } = ctx

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: t('templates.invalidJsonBody') }, { status: 400 })
    }

    // RLS handles ownership, but we need the existing row to read
    // meta_template_id and status — fetch explicitly.
    const { data: existing, error: lookupErr } = await db
      .from('message_templates')
      .select('id, name, status, meta_template_id, language, template_kind, waba_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: t('templates.notFound') }, { status: 404 })
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            t('templates.neverSubmitted'),
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: t('templates.statusNotEditable', { status: String(existing.status) }),
        },
        { status: 400 },
      )
    }

    // Authentication-category templates are editable only as the
    // authentication kind (synced legacy ones stay in WhatsApp Manager).
    if (
      payload.category === 'Authentication' &&
      payload.template_kind !== 'authentication'
    ) {
      return NextResponse.json(
        {
          error:
            t('templates.authNotEditable'),
        },
        { status: 400 },
      )
    }

    // Meta replaces components but not the template's structure: a
    // carousel stays a carousel. Name and language are fixed on Meta's
    // side too, so the stored ones are kept regardless of the payload.
    if ((payload.template_kind ?? 'standard') !== (existing.template_kind ?? 'standard')) {
      return NextResponse.json(
        { error: t('templates.draft.kindLocked') },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : t('templates.validationFailed') },
        { status: 400 },
      )
    }

    if (!isDryRun()) {
      // The template lives in one WABA: edit it with a number from there.
      const config = await loadTemplateNumberConfig(db, accountId, existing.waba_id as string | null).catch(() => null)
      if (!config) {
        return NextResponse.json(
          { error: t('common.whatsappNotConfiguredDot') },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)

      // Media headers (image/video/document) need a fresh Resumable-Upload
      // handle on every edit (Meta replaces components wholesale). Derive
      // from header_media_url.
      try {
        await ensureMediaHeaderHandle(payload, accessToken, accountId)
        await ensureCarouselCardHandles(payload, accessToken, accountId)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : t('templates.headerUploadFailed') },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : t('templates.metaEditFailed')
        await db
          .from('message_templates')
          .update({
            submission_error: message,
            last_submitted_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('account_id', accountId)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // Meta accepted the edit — status flips back to PENDING for review.
    const { data: row, error: updErr } = await db
      .from('message_templates')
      .update({
        ...templateRowFields(payload),
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .single()

    if (updErr) {
      return NextResponse.json(
        {
          error: t('templates.editedSaveFailed', { message: updErr.message }),
        },
        { status: 500 },
      )
    }

    await recordTemplateEvents(tenantOf(ctx), [
      { templateId: id, status: 'PENDING', source: 'edit' },
    ])

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
    })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : t('templates.editFailed'),
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: t('templates.invalidId') },
        { status: 400 },
      )
    }
    // Deleting removes the template on Meta first; same reasoning as
    // the PATCH handler above.
    const { db, accountId } = await requireRole('admin')

    const { data: existing, error: lookupErr } = await db
      .from('message_templates')
      .select('id, name, meta_template_id, waba_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: t('templates.notFound') }, { status: 404 })
    }

    if (existing.meta_template_id && !isDryRun()) {
      const config = await loadTemplateNumberConfig(db, accountId, existing.waba_id as string | null).catch(() => null)
      if (!config || !config.waba_id) {
        return NextResponse.json(
          { error: t('templates.notConfiguredDelete') },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : t('templates.metaDeleteFailed')
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    const { error: delErr } = await db
      .from('message_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (delErr) {
      return NextResponse.json(
        {
          error: t('templates.deletedLocalFailed', { message: delErr.message }),
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, dry_run: isDryRun() })
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error)
    }
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : t('templates.deleteFailed'),
      },
      { status: 500 },
    )
  }
}
