import { NextResponse } from 'next/server'
import type { DataClient } from '@/lib/data/types'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { requirePermission } from '@/lib/auth/permissions'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import {
  ensureCarouselCardHandles,
  ensureMediaHeaderHandle,
} from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import { recordTemplateEvents } from '@/lib/whatsapp/template-events'
import { templateRowFields } from '@/lib/whatsapp/template-row'
import { getT } from '@/lib/i18n/translate'
import { NoNumberError } from '@/lib/whatsapp/numbers'
import { loadSenderConfig, numberErrorText } from '@/lib/whatsapp/sender-config'

const t = getT('Api')

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows; dropping the shared
 * fields here means adding a column later only touches one spot.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
    /** The WABA the template was submitted to; omitted leaves the row's as is. */
    wabaId?: string | null
  },
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // Original author — kept as audit only.
    user_id: userId,
    name: payload.name,
    language: payload.language,
    ...templateRowFields(payload),
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    ...(extras.wabaId ? { waba_id: extras.wabaId } : {}),
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(
  db: DataClient,
  row: ReturnType<typeof buildUpsertRow>,
  draftId: string | null,
) {
  // An existing row (a saved draft, or an unsubmitted row found by name)
  // is updated in place by id, and only while it has never reached Meta:
  // a concurrent submit that already linked it wins, and this write then
  // matches no row instead of wiping that link. Otherwise the row is new;
  // a plain insert (not an upsert by name) means a concurrent request
  // that created the same (account, name, language) first is never
  // overwritten — this insert fails on the unique key instead.
  if (draftId) {
    return db
      .from('message_templates')
      .update(row)
      .eq('id', draftId)
      .eq('account_id', row.account_id)
      .is('meta_template_id', null)
      .select()
      .maybeSingle()
  }
  return db.from('message_templates').insert(row).select().single()
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → write the local row (update the unsubmitted row by id,
 * or insert a new one) with status, meta_template_id, sample_values,
 * last_submitted_at. A name already used by a submitted template is 409.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, we skip the network call and
 * insert a row with a synthetic `dry-run-<uuid>` meta_template_id so
 * CI / local dev can exercise the full UI without a real Meta App.
 *
 * On the Meta side this is a one-way trip — a row can only be
 * submitted; editing or deleting requires hsm_id and lives in PR 4.
 *
 * Submitting a saved draft: send the draft's `id` with the full
 * payload. The draft must belong to the account and must never have
 * reached Meta (no meta_template_id) — submitted templates change
 * through PATCH /api/whatsapp/templates/[id]. The draft row is then
 * updated in place by id instead of upserted by name.
 *
 * Every outcome that persists a row records a status event (source
 * 'submit'): the new status on success, DRAFT with the Meta error as
 * the reason on failure.
 */
export async function POST(request: Request) {
  try {
    // Message templates are settings-class data: `canEditSettings` and the
    // message_templates_insert/update RLS policies (migration 017) both
    // require 'admin'. Resolving account_id off the profile only proved
    // membership, so a viewer or agent could push a template to Meta for
    // approval — an external side effect RLS can't roll back — before the
    // local upsert was refused.
    const ctx = await requireRole('admin')
    await requirePermission(tenantOf(ctx), 'templates.submit')
    const { db, accountId, userId } = ctx

    let body: (TemplatePayload & { id?: unknown; whatsapp_config_id?: unknown }) | null
    try {
      body = (await request.json()) as (TemplatePayload & { id?: unknown; whatsapp_config_id?: unknown }) | null
    } catch {
      return NextResponse.json({ error: t('templates.invalidJsonBody') }, { status: 400 })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: t('templates.invalidJsonBody') }, { status: 400 })
    }

    // `whatsapp_config_id` picks the number (and so the WABA) the template
    // is submitted to; omitted means the workspace default, as before.
    const { id: rawDraftId, whatsapp_config_id: rawNumberId, ...rest } = body
    if (rawNumberId !== undefined && rawNumberId !== null && (typeof rawNumberId !== 'string' || !UUID_RE.test(rawNumberId))) {
      return NextResponse.json({ error: numberErrorText(new NoNumberError('not_found')) }, { status: 400 })
    }
    const payload: TemplatePayload = rest
    let draftId: string | null = null
    if (rawDraftId !== undefined && rawDraftId !== null) {
      if (typeof rawDraftId !== 'string' || !UUID_RE.test(rawDraftId)) {
        return NextResponse.json({ error: t('templates.invalidId') }, { status: 400 })
      }
      draftId = rawDraftId
    }

    // Authentication-category templates are only supported as the
    // authentication kind, whose OTP body Meta writes itself.
    if (
      payload.category === 'Authentication' &&
      payload.template_kind !== 'authentication'
    ) {
      return NextResponse.json(
        {
          error:
            t('templates.authKindRequired'),
        },
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

    if (draftId) {
      const { data: draft, error: draftErr } = await db
        .from('message_templates')
        .select('id, meta_template_id')
        .eq('id', draftId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (draftErr || !draft) {
        return NextResponse.json({ error: t('templates.notFound') }, { status: 404 })
      }
      if (draft.meta_template_id) {
        return NextResponse.json(
          { error: t('templates.draft.alreadySubmitted') },
          { status: 409 },
        )
      }
    }

    // A (name, language) already taken by another template would only
    // fail after Meta had answered — refuse up front. Without a draft id,
    // an unsubmitted row with this name is adopted as the draft (updated
    // in place by id); a submitted one is never turned back into a DRAFT.
    const { data: clash, error: clashErr } = await db
      .from('message_templates')
      .select('id, meta_template_id')
      .eq('account_id', accountId)
      .eq('name', payload.name)
      .eq('language', payload.language)
      .maybeSingle()
    if (clashErr) {
      return NextResponse.json({ error: t('templates.submitFailed') }, { status: 500 })
    }
    if (clash && clash.id !== draftId) {
      if (draftId || clash.meta_template_id) {
        return NextResponse.json(
          { error: t('templates.draft.nameTaken') },
          { status: 409 },
        )
      }
      draftId = clash.id as string
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'

    let metaTemplateId: string
    let metaStatus: string
    let wabaId: string | null = null

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      let config
      try {
        config = await loadSenderConfig(db, accountId, (rawNumberId as string | null | undefined) ?? null)
      } catch (e) {
        if (!(e instanceof NoNumberError)) throw e
        if (e.reason === 'disconnected') {
          return NextResponse.json({ error: numberErrorText(e), code: 'whatsapp_number_disconnected' }, { status: 409 })
        }
        return NextResponse.json(
          { error: e.reason === 'none' ? t('common.whatsappNotConfiguredConnect') : numberErrorText(e) },
          { status: 400 },
        )
      }
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              t('common.wabaIdMissing'),
          },
          { status: 400 },
        )
      }

      wabaId = config.waba_id ?? null
      const accessToken = decrypt(config.access_token)

      // Media headers (image/video/document) need a Resumable-Upload
      // handle (Meta rejects a plain URL at creation). Derive it from
      // header_media_url before building the payload; carousel cards
      // each need one too. Surfaces a 400 with an actionable message
      // (missing META_APP_ID, unreachable URL, wrong type/size).
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
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        })
        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message = e instanceof Error ? e.message : t('templates.metaSubmitFailed')
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit.
        const { data: failedRow } = await upsertTemplateRow(
          db,
          buildUpsertRow(accountId, userId, payload, {
            status: 'DRAFT',
            metaTemplateId: null,
            submissionError: message,
            wabaId,
          }),
          draftId,
        )
        if (failedRow?.id) {
          await recordTemplateEvents(tenantOf(ctx), [
            { templateId: failedRow.id, status: 'DRAFT', reason: message, source: 'submit' },
          ])
        } else if (draftId) {
          // A concurrent submit linked this draft to Meta while this one
          // was failing; that link is kept, and the Meta error is likely
          // the duplicate it caused.
          return NextResponse.json(
            { error: t('templates.submitRaced'), meta_error: message },
            { status: 409 },
          )
        }
        const isRateLimit = /\b429\b/.test(message)
        return NextResponse.json(
          {
            error: isRateLimit
              ? t('templates.rateLimit')
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    const status = normalizeStatus(metaStatus)
    const { data: row, error: upsertErr } = await upsertTemplateRow(
      db,
      buildUpsertRow(accountId, userId, payload, {
        status,
        metaTemplateId,
        submissionError: null,
        wabaId,
      }),
      draftId,
    )

    if (upsertErr) {
      // The submit succeeded on Meta's side but we failed to persist
      // locally. That's a data-drift state — surface the meta_template_id
      // so the user can recover via "Sync from Meta".
      return NextResponse.json(
        {
          error: t('templates.submittedSaveFailed', { message: upsertErr.message }),
          meta_template_id: metaTemplateId,
        },
        { status: 500 },
      )
    }

    if (!row) {
      // Meta accepted this submit, but a concurrent one had already linked
      // the draft. Keep that link; surface this meta_template_id so the
      // extra Meta template can be reconciled via "Sync from Meta".
      return NextResponse.json(
        { error: t('templates.submitRaced'), meta_template_id: metaTemplateId },
        { status: 409 },
      )
    }

    if (row.id) {
      await recordTemplateEvents(tenantOf(ctx), [
        { templateId: row.id, status, source: 'submit' },
      ])
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
    })
  } catch (error) {
    // Auth failures map to 401/403. Handled before the generic branch
    // below, which surfaces `error.message` as a 500 — reporting "you
    // aren't an admin" as a template submission failure would send the
    // user chasing the wrong problem.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : t('templates.submitFailed'),
      },
      { status: 500 },
    )
  }
}
