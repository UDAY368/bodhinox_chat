import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { withTenant } from '@/lib/db/tenant'
import { PlanLimitError } from '@/lib/billing/entitlements'
import { requireWhatsAppNumberRoom } from '@/lib/billing/limits'
import { ensureChannelEnabled } from '@/lib/channels/workspace'
import { resolveWhatsAppAccount } from '@/lib/repositories/routing'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import {
  getSubscribedApps,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
  type MetaErrorContext,
} from '@/lib/whatsapp/meta-error-explain'
import {
  appSubscriptionState,
  describeWabaPhoneMismatch,
  isNumericMetaId,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { resolveVerifyTokenForSave } from '@/lib/whatsapp/verify-token'
import { getT } from '@/lib/i18n/translate'
import { DISPLAY_NAME_MAX, disconnectAndReport, disconnectResponse } from '@/lib/whatsapp/number-admin'
import { getNumberConfig, isNumberDisconnected, listNumbers, NoNumberError, type NumberConfig } from '@/lib/whatsapp/numbers'
import { reuploadFormsKey } from '@/lib/whatsapp/forms/keys'

const t = getT('Api')
const tn = getT('whatsappNumbers')

/** `?id=` names one number; absent means the workspace default. */
function requestedNumberId(request: Request): string | null {
  return new URL(request.url).searchParams.get('id') || null
}

/**
 * Shape every failed Meta call into `{ error, meta }` — the actionable
 * text plus the code / subcode / fbtrace_id / step a user can quote to
 * Meta support. Status is 400 when the fix is on the user's side (token,
 * ids, PIN) and 502 when Meta has to change something (issue #505).
 */
function metaFailure(err: unknown, step: MetaConnectStep, ctx: MetaErrorContext) {
  const explained = explainMetaError(err, step, ctx)
  console.error(`[whatsapp/config] Meta ${step} failed:`, explained.metaMessage, {
    code: explained.code,
    subcode: explained.subcode,
    fbtrace_id: explained.fbtraceId,
  })
  return NextResponse.json(
    { error: explained.summary, meta: metaErrorPayload(explained) },
    { status: explained.httpStatus },
  )
}

/**
 * GET /api/whatsapp/config[?id=<number id>]
 *
 * Checks one number: `?id=` names it, otherwise the workspace default
 * (any member). A workspace with several numbers and no default answers
 * reason 'no_default'; an id that is not the workspace's answers 'not_found'.
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  number_id, phone_info: {...},
 *     waba_subscription: { checked, subscribed, app_id_match, error? } }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'disconnected',     message: '...', number_id } (an admin disconnected it)
 *   { connected: false, reason: 'meta_api_error',   message: '...',
 *     meta: { code, subcode, fbtrace_id, step, field, message } }
 */
export async function GET(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (error) {
    return toErrorResponse(error)
  }
  try {
    const accountId = ctx.accountId
    let config: NumberConfig
    try {
      config = await withTenant(tenantOf(ctx), (tx) => getNumberConfig(tx, accountId, requestedNumberId(request)))
    } catch (err) {
      if (!(err instanceof NoNumberError)) {
        console.error('Error fetching whatsapp_config:', err instanceof Error ? err.name : 'unknown')
        return NextResponse.json(
          { connected: false, reason: 'db_error', message: t('whatsappConfig.fetchFailed') },
          { status: 200 }
        )
      }
      return NextResponse.json(
        err.reason === 'none'
          ? { connected: false, reason: 'no_config', message: t('whatsappConfig.noConfig') }
          : { connected: false, reason: err.reason, message: tn(err.messageKey.slice('whatsappNumbers.'.length)) },
        { status: 200 }
      )
    }

    // Disconnected by an admin: its token is gone on purpose, not corrupted.
    if (isNumberDisconnected(config)) {
      return NextResponse.json(
        { connected: false, reason: 'disconnected', number_id: config.id, message: tn('errors.disconnected') },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            t('whatsappConfig.tokenCorrupted'),
        },
        { status: 200 }
      )
    }

    // Validate credentials against Meta
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
    } catch (err) {
      const explained = explainMetaError(err, 'verify_number', {
        phoneNumberId: config.phone_number_id,
        wabaId: config.waba_id,
      })
      console.error('[whatsapp/config GET] Meta API verification failed:', explained.metaMessage)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: explained.summary,
          meta: metaErrorPayload(explained),
        },
        { status: 200 }
      )
    }

    // Credentials work. Also report whether the WABA is subscribed to
    // this app — valid credentials with an unsubscribed WABA is exactly
    // the "connected but no messages arrive" state (issue #505). Never
    // fatal: the token may lack whatsapp_business_management and still
    // be fine for sending.
    let wabaSubscription: {
      checked: boolean
      subscribed: boolean | null
      app_id_match: boolean | null
      error?: string
    } = { checked: false, subscribed: null, app_id_match: null }
    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({ wabaId: config.waba_id, accessToken })
        const state = appSubscriptionState(subs, process.env.META_APP_ID)
        wabaSubscription = {
          checked: true,
          subscribed: state.subscribed,
          app_id_match: state.appIdMatch,
        }
      } catch (err) {
        const explained = explainMetaError(err, 'subscribed_apps', { wabaId: config.waba_id })
        wabaSubscription = {
          checked: true,
          subscribed: null,
          app_id_match: null,
          error: explained.summary,
        }
      }
    }

    return NextResponse.json({
      connected: true,
      number_id: config.id,
      phone_info: phoneInfo,
      waba_subscription: wabaSubscription,
    })
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: t('common.internalServerError') },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Connects a WhatsApp number for the caller's workspace (admin). Saving a
 * phone_number_id the workspace already has updates that number; a new
 * phone_number_id adds another number (the workspace's first becomes its
 * default). Verifies credentials with Meta first, then encrypts and stores.
 * Answers `number_id` (the saved number) and `created` (true when added).
 *
 * Every Meta failure answers `{ error, meta: { code, subcode,
 * fbtrace_id, step, field, message } }` — `error` is the actionable
 * text, `meta` is what to quote to Meta support. 400 = fix it on the
 * form (token / ids / PIN), 502 = Meta has to change something.
 */
export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }
  try {
    const { db, accountId, userId } = ctx

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, pin } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: t('whatsappConfig.credentialsRequired') },
        { status: 400 }
      )
    }

    // Meta ids are decimal digit strings. Catch the classic paste
    // mistakes (the +phone number, a display name, a URL) here with a
    // named field, instead of letting Meta answer "(#100) Unsupported
    // get request" for a value we could have rejected up front.
    if (!isNumericMetaId(phone_number_id)) {
      return NextResponse.json(
        {
          error:
            t('whatsappConfig.phoneIdDigits'),
          field: 'phone_number_id',
        },
        { status: 400 }
      )
    }
    if (waba_id !== undefined && waba_id !== null && waba_id !== '' && !isNumericMetaId(waba_id)) {
      return NextResponse.json(
        {
          error:
            t('whatsappConfig.wabaIdDigits'),
          field: 'waba_id',
        },
        { status: 400 }
      )
    }
    const metaCtx: MetaErrorContext = { phoneNumberId: phone_number_id, wabaId: waba_id || null }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: t('whatsappConfig.pinDigits') },
          { status: 400 }
        )
      }
    }

    // Reject if another account holds this phone_number_id connected: inbound
    // webhooks route a number to exactly one workspace (issue #136). A number
    // that another workspace only disconnected (its row kept for history,
    // token cleared) is free to connect here and that history is untouched;
    // the routing function and the partial unique index
    // whatsapp_config_phone_number_id_connected_key ignore such rows.
    const claimed = await resolveWhatsAppAccount(phone_number_id)
    if (claimed && claimed !== accountId) return NextResponse.json({ error: t('whatsappConfig.numberLinkedElsewhere') }, { status: 409 })

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      return metaFailure(err, 'verify_number', metaCtx)
    }

    // The number resolves — now make sure it lives under the WABA the
    // user typed. A foreign-but-valid WABA ID used to save fine and
    // subscribe the *wrong* account, surfacing days later as a webhook
    // that never fires. Failing here names the mismatch instead.
    if (waba_id) {
      let wabaNumbers
      try {
        wabaNumbers = await listWabaPhoneNumbers({
          wabaId: waba_id,
          accessToken: access_token,
        })
      } catch (err) {
        return metaFailure(err, 'waba_phone_numbers', metaCtx)
      }
      if (!phoneNumberBelongsToWaba(wabaNumbers, phone_number_id)) {
        return NextResponse.json(
          {
            error: describeWabaPhoneMismatch(wabaNumbers, phone_number_id, waba_id),
            field: 'waba_id',
            meta: {
              code: null,
              subcode: null,
              fbtrace_id: null,
              step: 'waba_phone_numbers',
              field: 'waba_id',
              message: 'phone_number_id is not listed under waba_id',
            },
          },
          { status: 400 }
        )
      }
    }

    // Look up this workspace's row for THIS phone_number_id. A workspace can
    // connect several numbers: saving the same phone_number_id updates that
    // number (and revives it in place when an admin had disconnected it, so
    // its conversations, campaigns and flows are on it again), a different one
    // adds another number (a number connected while the workspace has no
    // default becomes the default, by trigger). Two reasons to read it: we need to
    // know whether this number is already registered with Meta (so we can
    // skip /register when the user didn't provide a PIN this time around),
    // and we need the stored verify_token — the settings form never shows
    // it, so a save that leaves the field blank must keep it rather than
    // null it out.
    const { data: existing, error: existingError } = await db
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id, verify_token, display_name, status, access_token')
      .eq('account_id', accountId)
      .eq('phone_number_id', phone_number_id)
      .maybeSingle()
    if (existingError) {
      console.error('Error fetching whatsapp_config:', existingError.code ?? 'unknown')
      return NextResponse.json({ error: t('whatsappConfig.saveFailed') }, { status: 500 })
    }

    // Adding ANOTHER number, or reviving one an admin removed (its slot was
    // freed), must fit the plan (402). Checked here before /register and the
    // WABA subscription change Meta state, and again under the lock in the
    // write transaction below. Saving a number that still holds its slot is
    // never limited.
    const takesSlot = !existing || isNumberDisconnected(existing as { status?: string; access_token?: string })
    if (takesSlot) {
      try {
        await withTenant(tenantOf(ctx), (tx) => requireWhatsAppNumberRoom(tx, accountId))
      } catch (err) {
        if (err instanceof PlanLimitError) return toErrorResponse(err)
        throw err
      }
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = resolveVerifyTokenForSave(
        verify_token,
        existing?.verify_token ?? null
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            t('whatsappConfig.encryptFailed'),
        },
        { status: 500 }
      )
    }

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    let registrationMeta: ReturnType<typeof metaErrorPayload> | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false
    let registeredNow = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
          registeredNow = true
        } catch (err) {
          const explained = explainMetaError(err, 'register', metaCtx)
          registrationError = explained.summary
          registrationMeta = metaErrorPayload(explained)
          console.error('Phone number /register failed:', explained.metaMessage, registrationMeta)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    //
    // A failure here used to be swallowed with a console.warn, which
    // left the user with a green "connected" banner and a webhook that
    // never fired. Without this subscription Meta delivers nothing, so
    // treat it as a failed connect and say why (issue #505). Nothing
    // has been written yet, so the user just fixes the cause and saves
    // again.
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        return metaFailure(err, 'subscribe_waba', metaCtx)
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      verify_token_hash: encryptedVerifyToken ? createHash('sha256').update(decrypt(encryptedVerifyToken)).digest('hex') : null,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    // A new number gets Meta's verified name and display phone as its label,
    // so a workspace with several numbers can tell them apart; admins can
    // rename it later. An existing label is never overwritten.
    const metaLabel = [phoneInfo?.verified_name, phoneInfo?.display_phone_number]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .join(' · ')
      .slice(0, DISPLAY_NAME_MAX)
    const labelPatch = !existing?.display_name && metaLabel ? { display_name: metaLabel } : {}

    // The room check and the write share one transaction, so the per-workspace
    // advisory lock is held until the row takes its slot: two concurrent adds
    // (or revives) cannot both pass a 1-number plan.
    const toDate = (v: unknown) => (v == null ? null : new Date(v as string))
    const row = {
      ...baseRow,
      connected_at: toDate(baseRow.connected_at),
      registered_at: toDate(baseRow.registered_at),
      subscribed_apps_at: toDate(baseRow.subscribed_apps_at),
      updated_at: new Date(baseRow.updated_at),
      ...labelPatch,
    }
    let numberId: string | null = existing?.id ?? null
    try {
      numberId = await withTenant(tenantOf(ctx), async (tx) => {
        if (takesSlot) await requireWhatsAppNumberRoom(tx, accountId)
        // Connected implies enabled: the WhatsApp channel turns on in the same
        // transaction that stores the number (src/lib/channels/workspace.ts).
        await ensureChannelEnabled(tx, accountId, 'whatsapp', userId)
        if (existing) {
          await tx.whatsapp_config.updateMany({ where: { account_id: accountId, id: existing.id }, data: row })
          return existing.id as string
        }
        // `account_id` is the tenancy key, `user_id` the audit column for the
        // member who saved the number.
        const inserted = await tx.whatsapp_config.create({
          data: { account_id: accountId, user_id: userId, ...row },
          select: { id: true },
        })
        return inserted.id
      })
    } catch (err) {
      if (err instanceof PlanLimitError) return toErrorResponse(err)
      const code = err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null
      console.error(existing ? 'Error updating whatsapp_config:' : 'Error inserting whatsapp_config:', code ?? 'unknown')
      // A connected phone_number_id is unique across workspaces: another
      // workspace connected it between the check and this write.
      if (code === 'P2002') {
        return NextResponse.json({ error: t('whatsappConfig.numberLinkedElsewhere') }, { status: 409 })
      }
      return NextResponse.json(
        { error: t(existing ? 'whatsappConfig.updateFailed' : 'whatsappConfig.saveFailed') },
        { status: 500 }
      )
    }

    // Registering drops the number's forms key at Meta; send it again so forms keep working.
    if (registeredNow && numberId) {
      await reuploadFormsKey(tenantOf(ctx), numberId, { phoneNumberId: phone_number_id, accessToken: access_token })
    }

    // The token is read only to tell a disconnected row apart; never returned.
    const reconnected = existing ? isNumberDisconnected(existing as { status?: string; access_token?: string }) : false

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        number_id: numberId,
        created: !existing,
        reconnected,
        registered: false,
        registration_error: registrationError,
        error: registrationError,
        meta: registrationMeta,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      number_id: numberId,
      created: !existing,
      reconnected,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config[?id=<number id>]
 *
 * Disconnects one WhatsApp number (admin). Used by the "Reset Configuration"
 * button to recover from a corrupted encrypted token (mismatched
 * ENCRYPTION_KEY across environments). Without `?id=` it disconnects the
 * workspace's only connected number; a workspace with several must name one.
 * Same soft disconnect as DELETE /api/whatsapp/numbers/[id]: the row is kept,
 * nothing is cancelled, campaigns on it are held until the same Phone Number
 * ID is saved again (which revives the row), and the body says what changed.
 */
export async function DELETE(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }
  try {
    const { accountId } = ctx
    const requested = requestedNumberId(request)
    const outcome = await withTenant(tenantOf(ctx), async (tx) => {
      let id = requested
      if (!id) {
        const numbers = (await listNumbers(tx, accountId)).filter((n) => !n.removed)
        if (numbers.length === 0) return 'none' as const
        if (numbers.length > 1) return 'ambiguous' as const
        id = numbers[0].id
      }
      return (await disconnectAndReport(tx, accountId, id, ctx.userId)) ?? ('not_found' as const)
    })

    if (outcome === 'ambiguous') {
      return NextResponse.json({ error: tn('api.chooseNumber') }, { status: 400 })
    }
    if (outcome === 'not_found') {
      return NextResponse.json({ error: tn('errors.notFound') }, { status: 404 })
    }
    if (outcome === 'none') return NextResponse.json({ success: true })
    return NextResponse.json({ success: true, ...disconnectResponse(outcome) })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error instanceof Error ? error.name : 'unknown')
    return NextResponse.json({ error: t('whatsappConfig.deleteFailed') }, { status: 500 })
  }
}
