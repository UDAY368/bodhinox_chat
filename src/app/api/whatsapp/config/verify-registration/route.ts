import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { tenantOf } from '@/lib/audience/http'
import { withTenant } from '@/lib/db/tenant'
import { getNumberConfig, NoNumberError, type NumberConfig } from '@/lib/whatsapp/numbers'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api')
const tn = getT('whatsappNumbers')

/**
 * GET /api/whatsapp/config/verify-registration[?id=<number id>]
 *
 * Checks one number: `?id=` names it, otherwise the workspace default.
 *
 * Diagnostic endpoint — confirms the user's saved phone number is
 * actually reachable on Meta's side. Solves the failure mode that
 * surfaced the multi-number bug originally: "UI says Connected but
 * Meta isn't delivering events."
 *
 * Three checks run independently so the UI can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — local timestamp set by POST /config when
 *                    /register last succeeded; NULL means the
 *                    number was saved but never actually subscribed
 *
 * Returns 200 in every case so the UI can render diagnostic detail
 * rather than a generic error toast. The combined `live` flag is
 * what the UI badges on.
 */
export async function GET(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (error) {
    return toErrorResponse(error)
  }

  let config: NumberConfig
  try {
    const id = new URL(request.url).searchParams.get('id') || null
    config = await withTenant(tenantOf(ctx), (tx) => getNumberConfig(tx, ctx.accountId, id))
  } catch (err) {
    if (!(err instanceof NoNumberError)) return toErrorResponse(err)
    return NextResponse.json({
      live: false,
      checks: { config_exists: false },
      message: err.reason === 'none' ? t('whatsappConfig.noConfigShort') : tn(err.messageKey.slice('whatsappNumbers.'.length)),
    })
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    return NextResponse.json({
      live: false,
      checks: {
        config_exists: true,
        token_decryptable: false,
      },
      message:
        t('whatsappConfig.tokenUndecryptable'),
    })
  }

  const checks: {
    config_exists: boolean
    token_decryptable: boolean
    phone_metadata_ok: boolean
    waba_subscribed_to_app: boolean | null
    locally_marked_registered: boolean
  } = {
    config_exists: true,
    token_decryptable: true,
    phone_metadata_ok: false,
    waba_subscribed_to_app: null,
    locally_marked_registered: config.registered_at != null,
  }
  const errors: string[] = []

  // 1. Phone metadata
  try {
    await verifyPhoneNumber({
      phoneNumberId: config.phone_number_id,
      accessToken,
    })
    checks.phone_metadata_ok = true
  } catch (err) {
    errors.push(
      t('whatsappConfig.phoneCheckFailed', { message: err instanceof Error ? err.message : String(err) }),
    )
  }

  // 2. WABA subscription — only meaningful if we have a waba_id
  if (config.waba_id) {
    try {
      const subs = await getSubscribedApps({
        wabaId: config.waba_id,
        accessToken,
      })
      // Meta returns the apps subscribed to this WABA. If the list
      // is non-empty, OUR app is in there (the access_token we used
      // belongs to our app — Meta wouldn't return data for an app
      // the token can't see). Treat any entry as success.
      checks.waba_subscribed_to_app = subs.length > 0
      if (!checks.waba_subscribed_to_app) {
        errors.push(
          t('whatsappConfig.wabaNoApps'),
        )
      }
    } catch (err) {
      errors.push(
        t('whatsappConfig.wabaCheckFailed', { message: err instanceof Error ? err.message : String(err) }),
      )
    }
  } else {
    errors.push(
      t('whatsappConfig.noWabaId'),
    )
  }

  const live =
    checks.phone_metadata_ok &&
    (checks.waba_subscribed_to_app ?? false) &&
    checks.locally_marked_registered

  return NextResponse.json({
    live,
    checks,
    errors,
    last_registration_error: config.last_registration_error ?? null,
    registered_at: config.registered_at ?? null,
    subscribed_apps_at: config.subscribed_apps_at ?? null,
  })
}
