import { NextResponse } from 'next/server'
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import {
  normalizeRejectionReason,
  recordTemplateEvents,
  type TemplateStatusEventInput,
} from '@/lib/whatsapp/template-events'
import { tenantOf } from '@/lib/audience/http'
import type {
  AuthTemplateOptions,
  CarouselCard,
  LimitedTimeOffer,
  TemplateButton,
  TemplateKind,
  TemplateSampleValues,
} from '@/types'
import { getT } from '@/lib/i18n/translate'
import { listTemplateWabaNumbers } from '@/lib/whatsapp/template-number'
import type { SenderConfigRow } from '@/lib/whatsapp/sender-config'

const t = getT('Api')

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * The local catalog stores Meta's status enum verbatim (APPROVED /
 * PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION)
 * so the edit / resubmit / delete flows can distinguish recoverable
 * states (PAUSED) from terminal ones (DISABLED) and so webhook events
 * land 1:1 without a translation table.
 *
 * Locally-created templates (no Meta counterpart) are NOT deleted —
 * they remain visible so the user can notice drift and clean up.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
  otp_type?: string
}

interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
  /** CAROUSEL: each card carries its own HEADER / BODY / BUTTONS. */
  cards?: { components?: MetaTemplateComponent[] }[]
  /** LIMITED_TIME_OFFER */
  limited_time_offer?: { text?: string; has_expiration?: boolean }
  /** AUTHENTICATION BODY / FOOTER */
  add_security_recommendation?: boolean
  code_expiration_minutes?: number
}

interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
  rejected_reason?: string
}

function normalizeCategory(
  meta: string,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
      // OTP, FLOW, etc — out of scope for v1; drop silently.
    }
  }
  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  // We take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0]
  const headerSample = header?.example?.header_text
  if (!bodySample?.length && !headerSample?.length) return null
  const sv: TemplateSampleValues = {}
  if (bodySample?.length) sv.body = bodySample
  if (headerSample?.length) sv.header = headerSample
  return sv
}

function findComponent(
  components: MetaTemplateComponent[] | undefined,
  type: string,
): MetaTemplateComponent | undefined {
  return (components ?? []).find((c) => c.type?.toUpperCase() === type)
}

function parseCard(card: { components?: MetaTemplateComponent[] }): CarouselCard | null {
  const header = findComponent(card.components, 'HEADER')
  const body = findComponent(card.components, 'BODY')
  const format = header?.format?.toUpperCase()
  if (format !== 'IMAGE' && format !== 'VIDEO') return null
  const bodySample = body?.example?.body_text?.[0]
  return {
    header_type: format === 'IMAGE' ? 'image' : 'video',
    header_handle: header?.example?.header_handle?.[0],
    body_text: body?.text ?? '',
    ...(bodySample?.length ? { sample_values: { body: bodySample } } : {}),
    buttons: parseButtons(findComponent(card.components, 'BUTTONS')?.buttons),
  }
}

/**
 * The template kind and its kind-specific fields, read from Meta's
 * components. Authentication templates map to the authentication kind
 * only for the copy-code OTP this app builds; other OTP types stay
 * standard rows with the Authentication category, as before.
 */
function parseKind(t: MetaTemplate): {
  template_kind: TemplateKind
  cards: CarouselCard[] | null
  auth_options: AuthTemplateOptions | null
  lto: LimitedTimeOffer | null
} {
  const none = { cards: null, auth_options: null, lto: null }
  const carousel = findComponent(t.components, 'CAROUSEL')
  if (carousel?.cards?.length) {
    const cards = carousel.cards.map(parseCard)
    if (cards.every((c): c is CarouselCard => c !== null)) {
      return { ...none, template_kind: 'carousel', cards }
    }
  }
  const offer = findComponent(t.components, 'LIMITED_TIME_OFFER')?.limited_time_offer
  if (offer?.text) {
    return {
      ...none,
      template_kind: 'limited_time_offer',
      lto: { text: offer.text, has_expiration: offer.has_expiration === true },
    }
  }
  const otp = findComponent(t.components, 'BUTTONS')?.buttons?.find(
    (b) => b.type?.toUpperCase() === 'OTP',
  )
  if (t.category.toUpperCase() === 'AUTHENTICATION' && otp?.otp_type?.toUpperCase() === 'COPY_CODE') {
    const body = findComponent(t.components, 'BODY')
    const footer = findComponent(t.components, 'FOOTER')
    const options: AuthTemplateOptions = { otp_type: 'COPY_CODE' }
    if (body?.add_security_recommendation) options.add_security_recommendation = true
    if (footer?.code_expiration_minutes) options.code_expiration_minutes = footer.code_expiration_minutes
    if (otp.text) options.button_text = otp.text
    return { ...none, template_kind: 'authentication', auth_options: options }
  }
  return { ...none, template_kind: 'standard' }
}

/**
 * Meta's components carry only each card's header handle, never the
 * workspace media URL every carousel send needs. When the synced row is
 * still the same carousel (same card count, same header type per card),
 * keep the media each stored card already has instead of dropping it.
 */
function keepCardMedia(
  parsed: CarouselCard[] | null,
  stored: unknown,
): CarouselCard[] | null {
  if (!parsed || !Array.isArray(stored) || stored.length !== parsed.length) return parsed
  return parsed.map((card, i) => {
    const prev = stored[i] as Partial<CarouselCard> | null
    return prev &&
      prev.header_type === card.header_type &&
      typeof prev.header_media_url === 'string' &&
      prev.header_media_url
      ? { ...card, header_media_url: prev.header_media_url }
      : card
  })
}

export async function POST() {
  try {
    // Syncing rewrites the account-wide template catalog, which is
    // settings-class data: `canEditSettings` and the message_templates
    // insert/update RLS policies (migration 017) both require 'admin'.
    // Resolving account_id off the profile only proved membership.
    const ctx = await requireRole('admin')
    const { db, accountId, userId } = ctx

    // A workspace can connect numbers in several WABAs; each WABA's
    // templates are fetched with one of its numbers' tokens.
    let wabaNumbers: SenderConfigRow[]
    try {
      wabaNumbers = await listTemplateWabaNumbers(db, accountId)
    } catch {
      return NextResponse.json(
        {
          error:
            t('common.whatsappNotConfiguredConnect'),
        },
        { status: 400 },
      )
    }

    if (wabaNumbers.length === 0) {
      return NextResponse.json(
        {
          error:
            t('common.wabaIdMissing'),
        },
        { status: 400 },
      )
    }

    // Every WABA is fetched before anything is written, so a Meta error
    // leaves the local table as it was.
    const metaTemplates: (MetaTemplate & { waba_id: string })[] = []
    const PAGE_CAP = 20
    let truncated = false

    for (const config of wabaNumbers) {
      const wabaId = config.waba_id as string
      const accessToken = decrypt(config.access_token)
      let nextUrl:
        | string
        | null = `${META_API_BASE}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score,rejected_reason`
      let pageCount = 0

      while (nextUrl && pageCount < PAGE_CAP) {
        pageCount++
        const metaRes: Response = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })

        if (!metaRes.ok) {
          let metaErr = t('templates.metaApiStatus', { status: metaRes.status })
          try {
            const body = await metaRes.json()
            if (body?.error?.message) metaErr = body.error.message
          } catch {
            // response wasn't JSON — keep the fallback
          }
          return NextResponse.json({ error: metaErr }, { status: 502 })
        }

        const metaBody: {
          data?: MetaTemplate[]
          paging?: { next?: string }
        } = await metaRes.json()
        if (metaBody.data) metaTemplates.push(...metaBody.data.map((tpl) => ({ ...tpl, waba_id: wabaId })))
        nextUrl = metaBody.paging?.next ?? null
      }
      if (nextUrl !== null) truncated = true
    }

    let inserted = 0
    let updated = 0
    const errors: { name: string; language: string; message: string }[] = []
    const events: TemplateStatusEventInput[] = []

    for (const t of metaTemplates) {
      const body = (t.components ?? []).find((c) => c.type === 'BODY')
      const header = (t.components ?? []).find((c) => c.type === 'HEADER')
      const footer = (t.components ?? []).find((c) => c.type === 'FOOTER')
      const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS')

      const parsedButtons = parseButtons(buttons?.buttons)
      const sampleValues = extractSampleValues(body, header)

      const headerFormat = header?.format?.toUpperCase()
      const headerType =
        headerFormat === 'TEXT' ||
        headerFormat === 'IMAGE' ||
        headerFormat === 'VIDEO' ||
        headerFormat === 'DOCUMENT' ||
        headerFormat === 'LOCATION'
          ? headerFormat.toLowerCase()
          : null

      const status = normalizeStatus(t.status)
      const qualityScore = normalizeQualityScore(t.quality_score)
      // Meta reports 'NONE' (or nothing) unless the template is rejected;
      // shared with the webhook so both store the same value.
      const rejectionReason = normalizeRejectionReason(status, t.rejected_reason)

      const row = {
        // Account tenancy + user audit, same split as the submit
        // route. account_id is NOT NULL on message_templates
        // post-017, so an INSERT without it errors.
        account_id: accountId,
        user_id: userId,
        name: t.name,
        category: normalizeCategory(t.category),
        language: t.language,
        header_type: headerType,
        header_content: header?.text ?? null,
        header_handle: header?.example?.header_handle?.[0] ?? null,
        body_text: body?.text ?? '',
        footer_text: footer?.text ?? null,
        buttons: parsedButtons.length ? parsedButtons : null,
        sample_values: sampleValues,
        ...parseKind(t),
        status,
        meta_template_id: t.id,
        quality_score: qualityScore,
        rejection_reason: rejectionReason,
        waba_id: t.waba_id,
        updated_at: new Date().toISOString(),
      }

      const { data: existing, error: lookupErr } = await db
        .from('message_templates')
        .select('id,template_kind,cards,waba_id')
        .eq('account_id', accountId)
        .eq('name', t.name)
        .eq('language', t.language)
        .maybeSingle()

      if (lookupErr) {
        errors.push({
          name: t.name,
          language: t.language,
          message: lookupErr.message,
        })
        continue
      }

      // (name, language) is unique per workspace: a same-named template in
      // another WABA is reported, never written over the stored one.
      if (existing?.waba_id && existing.waba_id !== t.waba_id) {
        errors.push({
          name: t.name,
          language: t.language,
          message: 'A template with this name and language already exists in another WhatsApp Business account',
        })
        continue
      }

      if (existing?.id) {
        const update =
          row.template_kind === 'carousel' && existing.template_kind === 'carousel'
            ? { ...row, cards: keepCardMedia(row.cards, existing.cards) }
            : row
        const { error: updErr } = await db
          .from('message_templates')
          .update(update)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({
            name: t.name,
            language: t.language,
            message: updErr.message,
          })
        } else {
          updated++
          events.push({
            templateId: existing.id,
            status,
            reason: rejectionReason,
            qualityScore,
            source: 'sync',
          })
        }
      } else {
        const { data: created, error: insErr } = await db
          .from('message_templates')
          .insert(row)
          .select('id')
          .single()
        if (insErr) {
          errors.push({
            name: t.name,
            language: t.language,
            message: insErr.message,
          })
        } else {
          inserted++
          if (created?.id) {
            events.push({
              templateId: created.id,
              status,
              reason: rejectionReason,
              qualityScore,
              source: 'sync',
            })
          }
        }
      }
    }

    // Recorded in bounded chunks; unchanged templates are skipped
    // against their latest recorded event.
    await recordTemplateEvents(tenantOf(ctx), events)

    return NextResponse.json({
      success: errors.length === 0,
      total: metaTemplates.length,
      inserted,
      updated,
      errors,
      truncated,
    })
  } catch (error) {
    // Auth failures map to 401/403 rather than being folded into the
    // generic 500 below, which surfaces `error.message` as a sync failure.
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError
    ) {
      return toErrorResponse(error)
    }
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : t('templates.syncFailed'),
      },
      { status: 500 },
    )
  }
}
