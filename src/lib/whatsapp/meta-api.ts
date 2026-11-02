import { leaseFetch as fetch } from '@/lib/jobs/lease'
import { INTERACTIVE_LIMITS } from './interactive-limits'
import type { InteractiveButtonAction, InteractiveMedia } from './interactive'
export { INTERACTIVE_LIMITS } from './interactive-limits'
/**
 * Meta WhatsApp Cloud API helpers.
 *
 * Every function takes a single options object (named parameters) instead
 * of positional arguments. This was a deliberate choice after the same
 * swapped-args bug was found four times in a row with the positional form
 * (e.g. `(accessToken, phoneNumberId)` vs `(phoneNumberId, accessToken)`).
 * With named params, a typo surfaces immediately as a TypeScript error
 * instead of a runtime rejection from Meta.
 */

import { isBusinessScopedUserId } from './wa-identity'
import { getT } from '@/lib/i18n/translate'

const ti = getT('Validation.interactive')

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaSendResult {
  messageId: string
}

export interface MetaPhoneInfo {
  id: string
  display_phone_number: string
  verified_name?: string
  quality_rating?: string
}

/** Keep quality available even when Meta no longer exposes a legacy messaging tier. */
export async function getPhoneNumberHealth(args: VerifyPhoneNumberArgs): Promise<MetaPhoneInfo & { whatsapp_business_manager_messaging_limit?: string }> {
  const info = await verifyPhoneNumber(args);
  const response = await fetch(`${META_API_BASE}/${args.phoneNumberId}?fields=whatsapp_business_manager_messaging_limit`, {
    headers: { Authorization: `Bearer ${args.accessToken}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const tier = response?.ok ? await response.json().catch(() => null) : null;
  return { ...info, ...(typeof tier?.whatsapp_business_manager_messaging_limit === 'string'
    ? { whatsapp_business_manager_messaging_limit: tier.whatsapp_business_manager_messaging_limit } : {}) };
}

/**
 * Sets the number's ice breakers: up to 4 prompts a customer can tap when
 * opening a new chat. A tap arrives as an ordinary text message with the
 * prompt's text, so flows match it with an exact keyword.
 */
export async function setIceBreakers(args: { phoneNumberId: string; accessToken: string; prompts: string[] }): Promise<void> {
  const response = await fetch(`${META_API_BASE}/${args.phoneNumberId}/conversational_automation`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.accessToken}` },
    body: JSON.stringify({ prompts: args.prompts }),
  })
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
}

interface MetaErrorResponse {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    type?: string
    fbtrace_id?: string
    /** WhatsApp-specific envelope — `details` is the human-readable part. */
    error_data?: { messaging_product?: string; details?: string }
  }
}

/**
 * A Graph API failure with Meta's structured envelope preserved.
 *
 * `message` stays what it always was (Meta's `error.message`, or the
 * caller's fallback when the body wasn't JSON) so every existing
 * `err.message` consumer keeps working. The extra fields are what
 * `meta-error-explain.ts` needs to say *why* a call failed and which
 * setting to check — and what a user has to quote to Meta support
 * (`fbtrace_id`). Issue #505.
 */
export class MetaApiError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  readonly type: string | null
  readonly fbtraceId: string | null
  readonly httpStatus: number
  /** `error.error_data.details` — WhatsApp endpoints put the useful text here. */
  readonly details: string | null

  constructor(
    message: string,
    fields: {
      code?: number | null
      subcode?: number | null
      type?: string | null
      fbtraceId?: string | null
      httpStatus: number
      details?: string | null
    },
  ) {
    super(message)
    this.name = 'MetaApiError'
    this.code = fields.code ?? null
    this.subcode = fields.subcode ?? null
    this.type = fields.type ?? null
    this.fbtraceId = fields.fbtraceId ?? null
    this.httpStatus = fields.httpStatus
    this.details = fields.details ?? null
  }
}

/**
 * Read a failed Graph response into a MetaApiError without throwing.
 * Consumes the body — call at most once per response.
 */
async function readMetaError(response: Response, fallback: string): Promise<MetaApiError> {
  let message = fallback
  let envelope: MetaErrorResponse['error'] | undefined
  try {
    const data = (await response.json()) as MetaErrorResponse
    envelope = data.error
    if (envelope?.message) message = envelope.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  return new MetaApiError(message, {
    code: typeof envelope?.code === 'number' ? envelope.code : null,
    subcode: typeof envelope?.error_subcode === 'number' ? envelope.error_subcode : null,
    type: envelope?.type ?? null,
    fbtraceId: envelope?.fbtrace_id ?? null,
    httpStatus: response.status,
    details: envelope?.error_data?.details ?? null,
  })
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  throw await readMetaError(response, fallback)
}

// ============================================================
// Phone number / account
// ============================================================

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
}

/**
 * Verify a Meta phone number ID by fetching its public metadata
 * (display_phone_number, verified_name, quality_rating).
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken } = args
  const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json()
}

// ============================================================
// Cloud API registration (subscription for inbound webhooks)
// ============================================================
//
// Saving a phone_number_id + access_token to whatsapp_config is NOT
// enough to receive inbound events from Meta. Two extra calls are
// required:
//
//   POST /{phone_number_id}/register
//     Subscribes the number for THIS app's webhook. Requires a
//     6-digit 2FA PIN the user previously set in Meta WhatsApp
//     Manager → Two-step verification. Without /register, inbound
//     events are routed to whichever app last claimed the number
//     (often the one that did Embedded Signup) — so a second user
//     adding a second number under the same WABA silently loses
//     every inbound message.
//
//   POST /{waba_id}/subscribed_apps
//     Subscribes the WABA itself to this app. Required exactly
//     once per WABA, but idempotent so calling on every save is
//     safe and cheap.
//
// Both calls are no-ops when already done — Meta returns success +
// the helpers below treat that as success.

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
  /**
   * 6-digit PIN the user set in Meta WhatsApp Manager →
   * Two-step verification. If 2FA is not enabled on the number,
   * Meta rejects /register with a clear error and the user is
   * pointed at the right setting in the UI.
   */
  pin: string
}

export interface RegisterPhoneNumberResult {
  success: boolean
  /**
   * True when Meta indicated the number was already registered to
   * THIS app — same outcome as a fresh registration from the
   * caller's POV, surfaced separately for logging clarity.
   */
  alreadyRegistered: boolean
}

/**
 * Register a phone number for inbound webhook events.
 *
 * Errors that should be surfaced verbatim to the user:
 *   * Missing / wrong PIN  → "Two-step verification PIN required..."
 *   * No 2FA enabled       → "Two-factor authentication is not on..."
 *   * Number on other app  → "Number is registered to another app..."
 */
export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs
): Promise<RegisterPhoneNumberResult> {
  const { phoneNumberId, accessToken, pin } = args
  const url = `${META_API_BASE}/${phoneNumberId}/register`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })

  if (response.ok) {
    return { success: true, alreadyRegistered: false }
  }

  // Meta returns an error envelope with a code. Code 133005 + the
  // text "already registered" appears when the number is already
  // subscribed to this app — that's success from the caller's
  // perspective, surface it as such.
  const error = await readMetaError(response, `Meta API error: ${response.status}`)
  if (/already.*registered/i.test(error.message)) {
    return { success: true, alreadyRegistered: true }
  }
  throw error
}

export interface SubscribeWabaToAppArgs {
  wabaId: string
  accessToken: string
}

/**
 * Subscribe the WABA to this Meta app's webhook. Idempotent — Meta
 * returns success even when the subscription already exists.
 */
export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs
): Promise<void> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

export interface ListWabaPhoneNumbersArgs {
  wabaId: string
  accessToken: string
}

export interface WabaPhoneNumber {
  id: string
  display_phone_number?: string
  verified_name?: string
}

/**
 * List the phone numbers that live under a WABA.
 *
 * Used by POST /api/whatsapp/config to prove the Phone Number ID the
 * user typed actually belongs to the WABA ID they typed. A mismatch
 * used to save fine and surface days later as "the webhook never
 * fires" — the WABA that got subscribed wasn't the one owning the
 * number (issue #505). Follows `paging.next` a few pages in case a
 * WABA holds more numbers than one page returns.
 */
export async function listWabaPhoneNumbers(
  args: ListWabaPhoneNumbersArgs
): Promise<WabaPhoneNumber[]> {
  const { wabaId, accessToken } = args
  const out: WabaPhoneNumber[] = []
  let url: string | undefined =
    `${META_API_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`
  for (let page = 0; url && page < 5; page++) {
    const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = (await response.json()) as {
      data?: WabaPhoneNumber[]
      paging?: { next?: string }
    }
    out.push(...(data.data ?? []))
    url = data.paging?.next
  }
  return out
}

export interface GetSubscribedAppsArgs {
  wabaId: string
  accessToken: string
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string
    name?: string
    link?: string
  }
}

/**
 * Diagnostic — fetch the list of apps currently subscribed to this
 * WABA. The UI uses this to confirm OUR app is in the list when
 * the user clicks Verify Registration.
 */
export async function getSubscribedApps(
  args: GetSubscribedAppsArgs
): Promise<SubscribedApp[]> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = (await response.json()) as { data?: SubscribedApp[] }
  return data.data ?? []
}

// ============================================================
// Sending
// ============================================================

/**
 * Address a send at either a phone number or a business-scoped user ID.
 *
 * Meta uses two mutually-exclusive fields: `to` (+ `recipient_type`)
 * for a phone number, and `recipient` for a BSUID or parent BSUID
 * (issue #519). Every send helper below routes its `to` argument
 * through this, so callers hand over whichever identifier they hold and
 * don't have to know which field Meta wants.
 *
 * The two are never ambiguous: a sanitized phone number is digits only,
 * and a BSUID always carries a two-letter prefix and a dot.
 */
function recipientFields(to: string): Record<string, unknown> {
  return isBusinessScopedUserId(to)
    ? { recipient: to.trim() }
    : { recipient_type: 'individual', to }
}

export interface SendTextMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  text: string
  /** Meta's message_id of the message being replied to. Adds a `context` field
   *  so WhatsApp renders the new message as a reply with a quote preview. */
  contextMessageId?: string
}

/**
 * Send a free-form WhatsApp text message.
 * Only works inside the 24-hour customer service window.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'text',
    text: { body: text },
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

/** Asks the customer to share a location, or to fill in Meta's address form (India only). */
export async function sendInteractiveRequest(args: {
  phoneNumberId: string
  accessToken: string
  to: string
  bodyText: string
  request: 'location' | 'address'
}): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, bodyText, request } = args
  validateInteractiveBody(bodyText)
  const interactive = request === 'location'
    ? { type: 'location_request_message', body: { text: bodyText }, action: { name: 'send_location' } }
    : { type: 'address_message', body: { text: bodyText }, action: { name: 'address_message', parameters: { country: 'IN' } } }
  const response = await fetch(`${META_API_BASE}/${phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...recipientFields(to), type: 'interactive', interactive }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

/** Location is a separate message; Meta does not support location interactive headers. */
export async function sendLocationMessage(args: {
  phoneNumberId: string
  accessToken: string
  to: string
  location: Extract<InteractiveMedia, { type: 'location' }>
  contextMessageId?: string
}): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, location, contextMessageId } = args
  if (!Number.isFinite(location.latitude) || location.latitude < -90 || location.latitude > 90 ||
      !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180) {
    throw new Error('Invalid location coordinates')
  }
  const response = await fetch(`${META_API_BASE}/${phoneNumberId}/messages`, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp', ...recipientFields(to), type: 'location',
      location: { latitude: location.latitude, longitude: location.longitude,
        ...(location.name ? { name: location.name } : {}), ...(location.address ? { address: location.address } : {}) },
      ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    }),
  })
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export interface SendMediaMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  /** Optional caption — Meta caps at 1024 chars. Documents + images + videos accept it; audio does NOT. */
  caption?: string
  /** Document-only. Shown in the recipient's chat as the file name. Ignored for image/video/audio. */
  filename?: string
  contextMessageId?: string
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Used by the Flows engine's `send_media` node and the inbox composer's
 * agent-initiated media sends. Mirrors `sendTextMessage` — single fetch,
 * throws on non-2xx, returns Meta's message id.
 *
 * Audio is special-cased: Meta rejects `caption` and `filename` on audio
 * messages, so we send `{ link }` only. WhatsApp auto-renders an
 * OGG/Opus file as a playable voice note (waveform) rather than a file
 * attachment.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, kind, link, caption, filename, contextMessageId } = args
  if (!link) throw new Error('sendMediaMessage requires a link.')
  const url = `${META_API_BASE}/${phoneNumberId}/messages`

  // Audio accepts neither caption nor filename per Meta's spec — adding
  // either yields a 400. image/video/document accept a caption; only
  // document accepts a filename.
  const media: Record<string, unknown> = { link }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: kind,
    [kind]: media,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

import type { MessageTemplate } from '@/types'
import {
  buildSendComponents,
  type SendTimeParams,
} from './template-send-builder'

export interface SendTemplateMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  templateName: string
  language?: string
  /**
   * Legacy body-only params. Kept for backward compat with callers
   * that haven't migrated to the structured `template` + `messageParams`
   * pair below. New callers should pass `template` so media headers
   * and URL buttons land on the send.
   */
  params?: string[]
  /**
   * The template row from message_templates. When provided, the helper
   * builds the full components array (header + body + buttons) via
   * buildSendComponents — that's the only way image/video/document
   * headers and URL-with-variable buttons actually reach the recipient.
   */
  template?: MessageTemplate
  /**
   * Structured per-send values. Body variables go in `body`; header
   * text variables in `headerText`; media overrides in
   * `headerMediaUrl` / `headerMediaId`; URL/COPY_CODE button values
   * in `buttonParams` keyed by index.
   */
  messageParams?: SendTimeParams
  /** Meta's message_id of the message being replied to. */
  contextMessageId?: string
}

/**
 * Send a pre-approved WhatsApp message template. Required outside
 * the 24-hour window and for any first-touch messaging.
 *
 * Caller paths:
 *   - Legacy: pass `params: string[]` (body only). Same behaviour as
 *     before this helper learned about media + buttons.
 *   - Structured: pass `template` (and optionally `messageParams`).
 *     The full components array is built from the row so media
 *     headers + URL buttons land correctly.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = 'en_US',
    params,
    template,
    messageParams,
    contextMessageId,
  } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  }

  if (template) {
    const components = buildSendComponents(template, {
      // Every structured value (location, OTP code, offer expiry,
      // carousel cards, …) passes through unchanged.
      ...messageParams,
      // Legacy callers pass body values in `params`; fold them into
      // `messageParams.body` so the new path covers them too.
      body: messageParams?.body ?? params,
    })
    if (components.length > 0) {
      templatePayload.components = components
    }
  } else if (params && params.length > 0) {
    // Legacy body-only path — no template row available.
    templatePayload.components = [
      {
        type: 'body',
        parameters: params.map((p) => ({ type: 'text', text: String(p) })),
      },
    ]
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'template',
    template: templatePayload,
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Resumable Upload (media handles for template headers)
// ============================================================
//
// Creating a message template with a media HEADER (image/video/
// document) requires an `example.header_handle` — Meta does NOT accept
// a plain public URL at creation time. The handle comes from the
// two-step Resumable Upload API, which is keyed on the Meta APP id (not
// the phone number / WABA):
//
//   1. POST /{app_id}/uploads?file_name&file_length&file_type&access_token
//        → { id: "upload:<session>" }
//   2. POST /{id}  (Authorization: OAuth <token>, file_offset: 0, raw bytes)
//        → { h: "<handle>" }
//
// See https://developers.facebook.com/docs/graph-api/guides/upload

export interface UploadResumableMediaArgs {
  /** Meta App id (env META_APP_ID) — resumable upload is app-scoped. */
  appId: string
  accessToken: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Upload a file via the Resumable Upload API and return the media
 * handle to use as `example.header_handle` when creating/editing a
 * template with a media header.
 */
export async function uploadResumableMedia(
  args: UploadResumableMediaArgs,
): Promise<{ handle: string }> {
  const { appId, accessToken, fileName, mimeType, bytes } = args

  // Step 1 — open an upload session.
  const startParams = new URLSearchParams({
    file_name: fileName,
    file_length: String(bytes.byteLength),
    file_type: mimeType,
    access_token: accessToken,
  })
  const startRes = await fetch(
    `${META_API_BASE}/${appId}/uploads?${startParams.toString()}`,
    { method: 'POST' },
  )
  if (!startRes.ok) {
    await throwMetaError(startRes, `Resumable upload start failed: ${startRes.status}`)
  }
  const startData = (await startRes.json()) as { id?: string }
  if (!startData.id) {
    throw new Error('Resumable upload did not return a session id.')
  }

  // Step 2 — upload the bytes. Note the `OAuth` auth scheme (not Bearer)
  // and the file_offset header, both required by this endpoint.
  const uploadRes = await fetch(`${META_API_BASE}/${startData.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
    },
    // Uint8Array is a valid BodyInit at runtime; cast around the
    // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
    body: bytes as unknown as BodyInit,
  })
  if (!uploadRes.ok) {
    await throwMetaError(uploadRes, `Resumable upload failed: ${uploadRes.status}`)
  }
  const uploadData = (await uploadRes.json()) as { h?: string }
  if (!uploadData.h) {
    throw new Error('Resumable upload did not return a file handle.')
  }
  return { handle: uploadData.h }
}

// ============================================================
// Template submission (Business Management API)
// ============================================================

import type { MetaTemplateSubmitPayload } from './template-components'

export interface SubmitMessageTemplateArgs {
  wabaId: string
  accessToken: string
  payload: MetaTemplateSubmitPayload
}

export interface SubmitMessageTemplateResult {
  id: string
  status: string
  category?: string
}

/**
 * Submit a message template to Meta for approval.
 *
 * Returns Meta's assigned template id + initial status (typically
 * PENDING). Caller persists `id` as `meta_template_id` so the
 * upcoming edit/delete flows can scope to this exact template (and
 * language variant) via `hsm_id`, rather than nuking every variant
 * with the same name.
 *
 * 429s from Meta (rate limit: 100 creates/hour/WABA) surface as a
 * regular `Error('Meta API error: 429')`. The route handler
 * distinguishes 429 and shows a more actionable toast.
 */
export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs
): Promise<SubmitMessageTemplateResult> {
  const { wabaId, accessToken, payload } = args
  const url = `${META_API_BASE}/${wabaId}/message_templates`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  if (!data?.id) {
    throw new Error('Meta accepted the template but returned no id.')
  }
  return {
    id: String(data.id),
    status: typeof data.status === 'string' ? data.status : 'PENDING',
    category: typeof data.category === 'string' ? data.category : undefined,
  }
}

export interface EditMessageTemplateArgs {
  /** Meta's template id (stored locally as `meta_template_id`). */
  metaTemplateId: string
  accessToken: string
  /** Send the full components array — Meta replaces, not patches. */
  components: MetaTemplateSubmitPayload['components']
  /** Optional — only certain category transitions are allowed by Meta. */
  category?: MetaTemplateSubmitPayload['category']
}

export interface EditMessageTemplateResult {
  success: boolean
}

/**
 * Edit an existing (APPROVED or REJECTED) message template.
 *
 * Meta caps edits at 10 per 30 days (and 1 per 24h for APPROVED
 * templates). Every edit re-triggers review, so the status flips
 * back to PENDING until Meta approves the new components.
 *
 * Note: PENDING / DISABLED / IN_APPEAL templates cannot be edited
 * — the route handler enforces that before calling here.
 */
export async function editMessageTemplate(
  args: EditMessageTemplateArgs
): Promise<EditMessageTemplateResult> {
  const { metaTemplateId, accessToken, components, category } = args
  const body: Record<string, unknown> = { components }
  if (category) body.category = category
  const response = await fetch(`${META_API_BASE}/${metaTemplateId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json().catch(() => ({}))
  return { success: data?.success !== false }
}

export interface DeleteMessageTemplateArgs {
  wabaId: string
  accessToken: string
  name: string
  /**
   * Without `hsm_id`, Meta deletes EVERY language variant of the
   * template with this `name`. Pass the row's `meta_template_id`
   * to scope to a single variant.
   */
  metaTemplateId?: string
}

/**
 * Delete a message template on Meta. Pass `metaTemplateId` to scope
 * to a single language variant — otherwise Meta nukes every variant
 * sharing the same `name`.
 */
export async function deleteMessageTemplate(
  args: DeleteMessageTemplateArgs
): Promise<void> {
  const { wabaId, accessToken, name, metaTemplateId } = args
  const params = new URLSearchParams({ name })
  if (metaTemplateId) params.set('hsm_id', metaTemplateId)
  const url = `${META_API_BASE}/${wabaId}/message_templates?${params.toString()}`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  // Treat a 404 as a no-op — the template is already gone on Meta's
  // side, and we still want the local row removed.
  if (response.status === 404) return
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** Meta's message_id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

/**
 * Send a reaction (or removal) to a previously-exchanged message.
 * Empty `emoji` removes the reaction per Meta's spec.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, targetMessageId, emoji } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...recipientFields(to),
      type: 'reaction',
      reaction: { message_id: targetMessageId, emoji },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Typing indicator (rides on the read receipt)
// ============================================================

export interface SendTypingIndicatorArgs {
  phoneNumberId: string
  accessToken: string
  /** Meta's wamid of the INBOUND message we're about to answer — must
   *  come from a received-message webhook, not one of our own sends. */
  messageId: string
}

/**
 * Mark an inbound message as read AND show "typing…" to the customer.
 *
 * One request does both: Meta's typing indicator is a field on the
 * read-status update. The indicator clears after 25 seconds or as soon
 * as the business sends a message, whichever comes first, so there is
 * nothing to cancel. Meta asks that it only be shown when a reply is
 * actually coming.
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 *
 * Returns nothing — the endpoint answers `{ success: true }` and mints
 * no message id. Callers should treat it as best-effort: a failure here
 * must never block the reply that follows.
 */
export async function sendTypingIndicator(
  args: SendTypingIndicatorArgs
): Promise<void> {
  const { phoneNumberId, accessToken, messageId } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Interactive (button replies + list messages)
// ============================================================
//
// Meta's two flavours of interactive message — used by the Flows
// engine to drive scripted chatbot menus. Caller passes plain
// JS values; helpers shape the Meta payload and enforce Meta's
// limits BEFORE the network call so the failure mode is a
// developer-facing error rather than a customer-facing one.

/**
 * Meta limits for interactive messages, hard-coded so violations
 * fail at build/save time rather than as a 400 from the Meta API
 * mid-conversation. See:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 */

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped (≤ 256 chars). */
  id: string
  /** Visible label (≤ 20 chars per Meta). */
  title: string
  action?: InteractiveButtonAction
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** The body text — what the customer reads above the buttons. */
  bodyText: string
  /** Optional plain-text header (≤ 60 chars). */
  headerText?: string
  media?: Exclude<InteractiveMedia, { type: 'location' }>
  /** Optional grey footer line under the buttons (≤ 60 chars). */
  footerText?: string
  /** 1–3 buttons. Validated against Meta's limits before sending. */
  buttons: InteractiveButton[]
  /** Meta's message_id of the message being replied to (quote preview). */
  contextMessageId?: string
}

/**
 * Send an interactive message with up to 3 inline reply buttons. The
 * customer taps one and Meta delivers a webhook with
 * `messages[0].interactive.button_reply.id` set to the matching button.id.
 *
 * Validation throws BEFORE the network call so misconfigured flows
 * fail at save time, not during a live conversation.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, headerText, footerText, buttons, contextMessageId, media,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (media && headerText?.trim()) throw new Error('Media headers cannot include text headers')
  const urlButtons = buttons.filter(b => b.action?.type === 'url')
  if (urlButtons.length && (buttons.length !== 1 || urlButtons.length !== 1)) {
    throw new Error('A URL button must be sent alone')
  }
  const urlAction = urlButtons[0]?.action
  if (urlAction?.type === 'url') {
    let parsed: URL
    try { parsed = new URL(urlAction.url) } catch { throw new Error('Invalid button URL') }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid button URL')
  }
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      ti('buttonCount', { max: INTERACTIVE_LIMITS.maxButtons, got: buttons.length })
    )
  }
  const seenButtonIds = new Set<string>()
  for (const btn of buttons) {
    if (!btn.id) throw new Error(ti('buttonMissingId'))
    // Duplicate button ids make the tapped-button webhook ambiguous —
    // Meta rejects them, and the pre-flight validator (interactive.ts)
    // rejects them too, so guard here to keep the two paths in step.
    if (seenButtonIds.has(btn.id)) {
      throw new Error(ti('duplicateButtonId', { id: btn.id }))
    }
    seenButtonIds.add(btn.id)
    if (!btn.title) throw new Error(ti('buttonMissingTitle', { id: btn.id }))
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        ti('buttonTitleTooLong', { title: btn.title, max: INTERACTIVE_LIMITS.buttonTitleMaxLength })
      )
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  }
  if (urlAction?.type === 'url') {
    interactive.type = 'cta_url'
    interactive.action = { name: 'cta_url', parameters: { display_text: buttons[0].title, url: urlAction.url } }
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (media) interactive.header = {
    type: media.type,
    [media.type]: { link: media.url, ...(media.type === 'document' && media.filename ? { filename: media.filename } : {}) },
  }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export interface InteractiveListRow {
  /** Stable id sent back in the webhook when tapped (≤ 200 chars). */
  id: string
  /** Visible row title (≤ 24 chars per Meta). */
  title: string
  /** Optional secondary line shown under the title (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  bodyText: string
  /** Label of the tap-to-expand button on the message bubble. */
  buttonLabel: string
  headerText?: string
  footerText?: string
  /**
   * 1–10 rows TOTAL across all sections. Meta caps the *total*, not
   * per-section. Validation enforces this before send.
   */
  sections: InteractiveListSection[]
  contextMessageId?: string
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows. Use when there are more options than the 3-button limit allows.
 * Webhook arrives with `messages[0].interactive.list_reply.id` set to
 * the matching row.id.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, buttonLabel, headerText, footerText, sections, contextMessageId,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (!buttonLabel) throw new Error(ti('listRequiresButtonLabel'))
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      ti('listButtonLabelTooLong', { label: buttonLabel, max: INTERACTIVE_LIMITS.buttonTitleMaxLength })
    )
  }
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
    throw new Error(
      ti('listSectionCount', { max: INTERACTIVE_LIMITS.maxListSections, got: sections.length })
    )
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      ti('listRowCount', { max: INTERACTIVE_LIMITS.maxListRowsTotal, got: totalRows })
    )
  }
  const seenIds = new Set<string>()
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error(ti('listRowMissingId'))
      if (seenIds.has(row.id)) {
        throw new Error(ti('duplicateRowId', { id: row.id }))
      }
      seenIds.add(row.id)
      if (!row.title) throw new Error(ti('listRowMissingTitle', { id: row.id }))
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          ti('listRowTitleTooLong', { title: row.title, max: INTERACTIVE_LIMITS.listRowTitleMaxLength })
        )
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          ti('listRowDescriptionTooLong', { id: row.id, max: INTERACTIVE_LIMITS.listRowDescriptionMaxLength })
        )
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error(ti('bodyRequired'))
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      ti('bodyTooLong', { max: INTERACTIVE_LIMITS.bodyMaxLength })
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      ti('headerTooLong', { max: INTERACTIVE_LIMITS.headerTextMaxLength })
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      ti('footerTooLong', { max: INTERACTIVE_LIMITS.footerMaxLength })
    )
  }
}

// ============================================================
// Media
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string
  accessToken: string
}

/**
 * Resolve a media ID to Meta's (short-lived, authenticated) CDN URL
 * plus the MIME type. Step one of the media-proxy flow.
 *
 * `fileSize` is Meta's `file_size` (bytes) and is what lets the
 * inbound mirror (issue #466) reject a file the `chat-media` bucket
 * would refuse WITHOUT downloading it first — a 90 MB document costs
 * nothing to skip here and a full transfer to skip after the fact.
 * Null when Meta omits the field or sends something non-numeric.
 */
export async function getMediaUrl(
  args: GetMediaUrlArgs
): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const { mediaId, accessToken } = args
  const response = await fetch(`${META_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Media fetch failed: ${response.status}`)
  }
  const data = await response.json()
  if (!data.url) throw new Error('Media URL not found in Meta response')
  // Meta documents file_size as a number but has been observed sending
  // it as a numeric string; Number() handles both and NaN-guards junk.
  const size = Number(data.file_size)
  return {
    url: data.url,
    mimeType: data.mime_type || 'application/octet-stream',
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  }
}

export interface DownloadMediaArgs {
  downloadUrl: string
  accessToken: string
}

/**
 * Fetch the binary bytes for a media URL obtained from getMediaUrl.
 * Step two of the media-proxy flow.
 */
export async function downloadMedia(
  args: DownloadMediaArgs
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, accessToken } = args
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`)
  }
  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}

// ============================================================
// WhatsApp Flows (forms)
// ============================================================
//
// A form is a Meta Flow owned by the WABA: create it, upload its Flow JSON,
// publish it, then send it as an interactive `flow` message. Neither tokens
// nor request bodies are logged here; errors carry only Meta's envelope.

const tf = getT('Validation.forms')

/** Meta caps the flow CTA button at 30 characters. */
export const FLOW_CTA_MAX_LENGTH = 30

/** Meta's Flow categories (the same values a form row stores). */
export type MetaFlowCategory =
  | 'SIGN_UP' | 'SIGN_IN' | 'APPOINTMENT_BOOKING' | 'LEAD_GENERATION'
  | 'CONTACT_US' | 'CUSTOMER_SUPPORT' | 'SURVEY' | 'OTHER'

export interface MetaFlowValidationError {
  error?: string
  error_type?: string
  message?: string
  line_start?: number
  line_end?: number
  column_start?: number
  column_end?: number
  pointers?: unknown[]
}

async function flowRequest(
  url: string,
  accessToken: string,
  init: { method: string; body?: BodyInit; json?: unknown },
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` }
  let body = init.body
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const response = await fetch(url, { method: init.method, headers, body, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
  const data = await response.json().catch(() => ({}))
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

function flowValidationErrors(value: unknown): MetaFlowValidationError[] {
  return Array.isArray(value)
    ? (value.filter((e) => e && typeof e === 'object') as MetaFlowValidationError[])
    : []
}

export interface CreateFlowArgs {
  wabaId: string
  accessToken: string
  name: string
  categories: MetaFlowCategory[]
  /** Only for endpoint-backed forms; must be HTTPS. */
  endpointUri?: string
}

/** Creates an empty draft Flow on the WABA and returns Meta's flow id. */
export async function createFlow(args: CreateFlowArgs): Promise<{ id: string }> {
  const { wabaId, accessToken, name, categories, endpointUri } = args
  const data = await flowRequest(`${META_API_BASE}/${wabaId}/flows`, accessToken, {
    method: 'POST',
    json: { name, categories, ...(endpointUri ? { endpoint_uri: endpointUri } : {}) },
  })
  if (!data.id) throw new Error('Meta created the flow but returned no id.')
  return { id: String(data.id) }
}

export interface UpdateFlowMetadataArgs {
  flowId: string
  accessToken: string
  name?: string
  categories?: MetaFlowCategory[]
  endpointUri?: string
}

/** Renames a flow or changes its categories or endpoint. Only the given fields are sent. */
export async function updateFlowMetadata(args: UpdateFlowMetadataArgs): Promise<void> {
  const { flowId, accessToken, name, categories, endpointUri } = args
  const json: Record<string, unknown> = {}
  if (name !== undefined) json.name = name
  if (categories !== undefined) json.categories = categories
  if (endpointUri !== undefined) json.endpoint_uri = endpointUri
  await flowRequest(`${META_API_BASE}/${flowId}`, accessToken, { method: 'POST', json })
}

export interface UploadFlowJsonArgs {
  flowId: string
  accessToken: string
  flowJson: unknown
}

/**
 * Replaces the flow's Flow JSON. Meta answers 200 even when the JSON is
 * invalid; the problems come back as `validation_errors` and block publish.
 */
export async function uploadFlowJson(
  args: UploadFlowJsonArgs,
): Promise<{ validation_errors: MetaFlowValidationError[] }> {
  const { flowId, accessToken, flowJson } = args
  const form = new FormData()
  form.append('file', new Blob([JSON.stringify(flowJson)], { type: 'application/json' }), 'flow.json')
  form.append('name', 'flow.json')
  form.append('asset_type', 'FLOW_JSON')
  const data = await flowRequest(`${META_API_BASE}/${flowId}/assets`, accessToken, { method: 'POST', body: form })
  return { validation_errors: flowValidationErrors(data.validation_errors) }
}

export interface FlowIdArgs {
  flowId: string
  accessToken: string
}

/** Publishes a draft flow. Irreversible: a published flow can only be deprecated. */
export async function publishFlow(args: FlowIdArgs): Promise<void> {
  await flowRequest(`${META_API_BASE}/${args.flowId}/publish`, args.accessToken, { method: 'POST' })
}

/** Deprecates a published flow so it can no longer be sent. */
export async function deprecateFlow(args: FlowIdArgs): Promise<void> {
  await flowRequest(`${META_API_BASE}/${args.flowId}/deprecate`, args.accessToken, { method: 'POST' })
}

/** Deletes a draft flow. A flow Meta no longer has (404) counts as deleted. */
export async function deleteFlow(args: FlowIdArgs): Promise<void> {
  const response = await fetch(`${META_API_BASE}/${args.flowId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) return
  if (!response.ok) await throwMetaError(response, `Meta API error: ${response.status}`)
}

export interface GetFlowArgs extends FlowIdArgs {
  /** Defaults to status, validation_errors and preview. */
  fields?: Array<'status' | 'validation_errors' | 'preview'>
}

export interface MetaFlowInfo {
  /** DRAFT, PUBLISHED, DEPRECATED, BLOCKED or THROTTLED. */
  status: string
  validation_errors: MetaFlowValidationError[]
  preview_url?: string
}

/** Reads a flow's status, validation errors and its web preview link. */
export async function getFlow(args: GetFlowArgs): Promise<MetaFlowInfo> {
  const fields = (args.fields ?? ['status', 'validation_errors', 'preview'])
    .map((field) => (field === 'preview' ? 'preview.invalidate(false)' : field))
  const params = new URLSearchParams({ fields: fields.join(',') })
  const data = await flowRequest(`${META_API_BASE}/${args.flowId}?${params.toString()}`, args.accessToken, { method: 'GET' })
  const preview = data.preview && typeof data.preview === 'object' ? (data.preview as { preview_url?: unknown }) : null
  return {
    status: typeof data.status === 'string' ? data.status : 'DRAFT',
    validation_errors: flowValidationErrors(data.validation_errors),
    ...(typeof preview?.preview_url === 'string' ? { preview_url: preview.preview_url } : {}),
  }
}

export interface SendFlowMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  flowId: string
  /** Our one-time token; Meta echoes it back with the submission. */
  flowToken: string
  /** CTA button text, at most 30 characters. */
  cta: string
  body: string
  header?: string
  footer?: string
  /** First screen to open. */
  screen: string
  /** Initial data for the first screen; that screen must declare these keys. */
  data?: Record<string, unknown>
  /** `draft` sends an unpublished flow (testing only). */
  mode?: 'published' | 'draft'
}

/** Sends a flow as an interactive message. Only inside the 24-hour window. */
export async function sendFlowMessage(args: SendFlowMessageArgs): Promise<{ whatsapp_message_id: string }> {
  const { phoneNumberId, accessToken, to, flowId, flowToken, cta, body, header, footer, screen, data, mode } = args
  validateInteractiveBody(body)
  validateInteractiveHeaderFooter(header, footer)
  if (!cta.trim()) throw new Error(tf('ctaRequired'))
  if (cta.length > FLOW_CTA_MAX_LENGTH) throw new Error(tf('ctaTooLong', { max: FLOW_CTA_MAX_LENGTH }))
  const parameters: Record<string, unknown> = {
    flow_message_version: '3',
    flow_token: flowToken,
    flow_id: flowId,
    flow_cta: cta,
    flow_action: 'navigate',
    flow_action_payload: { screen, ...(data && Object.keys(data).length > 0 ? { data } : {}) },
  }
  if (mode === 'draft') parameters.mode = 'draft'
  const interactive: Record<string, unknown> = {
    type: 'flow',
    ...(header ? { header: { type: 'text', text: header } } : {}),
    body: { text: body },
    ...(footer ? { footer: { text: footer } } : {}),
    action: { name: 'flow', parameters },
  }
  const result = await flowRequest(`${META_API_BASE}/${phoneNumberId}/messages`, accessToken, {
    method: 'POST',
    json: { messaging_product: 'whatsapp', ...recipientFields(to), type: 'interactive', interactive },
  })
  const messages = result.messages as Array<{ id?: unknown }> | undefined
  const id = messages?.[0]?.id
  if (typeof id !== 'string') throw new Error('Meta accepted the flow message but returned no id.')
  return { whatsapp_message_id: id }
}

/**
 * Registers the number's business public key (PEM) so Meta can encrypt flow
 * data exchanged with our endpoint. Only the public key ever leaves the server.
 */
export async function setBusinessEncryptionKey(args: {
  phoneNumberId: string
  accessToken: string
  publicKeyPem: string
}): Promise<void> {
  const body = new URLSearchParams({ business_public_key: args.publicKeyPem })
  await flowRequest(`${META_API_BASE}/${args.phoneNumberId}/whatsapp_business_encryption`, args.accessToken, {
    method: 'POST',
    body,
  })
}
