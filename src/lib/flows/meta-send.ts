import { assertBotRepliesEnabled } from '@/lib/whatsapp/bot-pause'
import { providerMediaUrl } from '@/lib/storage/server'
import {
  MetaApiError,
  sendInteractiveRequest,
  sendMediaMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import { validateInteractivePayload, type InteractiveMedia, type InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { assertInteractiveTargets, bindInteractiveActions } from '@/lib/whatsapp/interactive-actions'
import { createInteractiveDelivery } from '@/lib/whatsapp/interactive-delivery'
import { decrypt } from '@/lib/whatsapp/encryption'
import { assertNumberConnected, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers'
import {
  loadConversationSenderConfig,
  loadSenderConfig,
  numberErrorText,
  type SenderConfigRow,
} from '@/lib/whatsapp/sender-config'
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity'
import { assertConversationInAccount } from '@/lib/whatsapp/conversation-scope'
import { databaseAdmin } from './admin-client'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ------------------------------------------------------------
// Flows-side Meta sender (interactive variants).
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but emits interactive button + list messages.
// Kept separate from the automations file so the two engines don't
// fight over each other's shape — once both stabilize, the
// phone-variant retry + DB persistence are obvious extraction
// candidates into a shared base.
//
// PR #1 ships this in isolation: callers don't exist yet. PR #2
// brings the flow runner online and wires it up. Shipping it now
// keeps the foundation PR self-contained and unit-testable.
// ------------------------------------------------------------

/**
 * Resolve the Meta sending credentials: the phone number id plus the
 * DECRYPTED access token from `whatsapp_config`. With a conversation it is
 * that conversation's number (the workspace default for a legacy row without
 * one); without, the workspace default. The single home for that decrypt
 * step — callers outside this file (the AI auto-reply's typing indicator, the
 * campaign test send) reuse it rather than growing a copy. A disconnected
 * number is refused with its own message; there is no fallback to another.
 */
export async function loadAccountMetaCredentials(
  db: ReturnType<typeof databaseAdmin>,
  accountId: string,
  conversationId?: string | null,
): Promise<{ phoneNumberId: string; accessToken: string; configId: string; wabaId: string | null }> {
  let config: SenderConfigRow
  try {
    config = assertNumberConnected(conversationId
      ? await loadConversationSenderConfig(db, accountId, conversationId)
      : await loadSenderConfig(db, accountId))
  } catch (error) {
    if (error instanceof NoNumberError && error.reason !== 'none') throw new Error(numberErrorText(error))
    throw new Error(t('send.notConfigured'))
  }
  if (!config.phone_number_id || !config.access_token) throw new Error(t('send.notConfigured'))
  return {
    phoneNumberId: config.phone_number_id,
    accessToken: decrypt(config.access_token),
    configId: config.id,
    wabaId: config.waba_id ?? null,
  }
}

/**
 * True when the conversation's own number was disconnected by an admin, so a
 * bot (the AI auto-reply) can stand down quietly before doing any work. A
 * lookup failure answers false: the send itself still refuses.
 */
export async function conversationNumberDisconnected(
  db: ReturnType<typeof databaseAdmin>,
  accountId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    return isNumberDisconnected(await loadConversationSenderConfig(db, accountId, conversationId))
  } catch (error) {
    // The sender lookup refuses a disconnected number outright; that is still a yes here.
    return error instanceof NoNumberError && error.reason === 'disconnected'
  }
}

interface SendTextEngineArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so a flow authored by user A still sends through the
   *  WhatsApp number user B saved on the same account. */
  accountId: string
  /** Original author of the flow — used for INSERT audit columns
   *  and for resolving the agent's identity in logs. Not consulted
   *  for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
  /** Marks the persisted message row `ai_generated = true` so the inbox
   *  badges it as an AI reply. Only the auto-reply bot sets this;
   *  deterministic Flow/automation sends leave it false. */
  aiGenerated?: boolean
  /** AI can lose ownership or its service window while credentials load. */
  beforeSend?: () => Promise<void>
  /** Called once Meta has accepted the message, before it is saved locally (a later throw means sent but not recorded). */
  onSent?: () => void
  /** Send the text as a share-location request or (Indian numbers only) Meta's address form. */
  request?: 'location' | 'address'
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 *
 * Used by the runner's `send_message` and `collect_input` nodes —
 * both prompt the customer with text and either auto-advance (the
 * send_message case) or suspend awaiting a text reply (collect_input).
 *
 * Wraps the same phone-variant retry + DB persistence pattern as the
 * interactive senders; the duplication will be DRY'd into a shared
 * `engineSendBase` once the v2 features (templates with variables,
 * media sends) settle.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  await assertBotRepliesEnabled(args.accountId, args.conversationId)
  const db = databaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error(t('send.contactNotFound'))
  }

  // Same for the conversation the message lands in — see
  // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
  await assertConversationInAccount(db, args.conversationId, args.accountId)

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  const sanitized = sendTarget.target

  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
    db,
    args.accountId,
    args.conversationId,
  )

  const attempt = async (phone: string): Promise<string> => {
    await assertBotRepliesEnabled(args.accountId, args.conversationId)
    await args.beforeSend?.()
    // Meta offers the address form only to Indian numbers; elsewhere the
    // prompt goes as text and the engine accepts a typed address.
    const request = args.request === 'address' && !/^\+?91\d{10}$/.test(phone) ? undefined : args.request
    if (request) {
      try {
        return (await sendInteractiveRequest({ phoneNumberId, accessToken, to: phone, bodyText: args.text, request })).messageId
      } catch (err) {
        // A rejected address form was not delivered, so plain text is safe to send instead.
        if (request !== 'address' || !(err instanceof MetaApiError) || err.httpStatus >= 500 || isRecipientNotAllowedError(err.message)) throw err
      }
    }
    const r = await sendTextMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      text: args.text,
    })
    return r.messageId
  }

  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError
  args.onSent?.()

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: args.text,
    message_id: waMessageId,
    status: 'sent',
    ai_generated: args.aiGenerated ?? false,
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: waMessageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: MediaKind
  /** Public URL Meta fetches at send time. */
  link: string
  caption?: string
  /** Document-only; ignored by Meta for image/video. */
  filename?: string
}

/**
 * Send an image / video / document from the Flows engine.
 *
 * Used by the runner's `send_media` node. Auto-advances after the
 * send lands (same suspend semantics as send_message). Same
 * phone-variant retry + DB persistence as the text/interactive
 * senders; persists the outgoing message with `content_type` matching
 * the media kind so the inbox renders the right preview.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  await assertBotRepliesEnabled(args.accountId, args.conversationId)
  const db = databaseAdmin()

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error(t('send.contactNotFound'))
  }

  // Same for the conversation the message lands in — see
  // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
  await assertConversationInAccount(db, args.conversationId, args.accountId)

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  const sanitized = sendTarget.target

  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
    db,
    args.accountId,
    args.conversationId,
  )

  const attempt = async (phone: string): Promise<string> => {
    await assertBotRepliesEnabled(args.accountId, args.conversationId)
    const r = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      kind: args.kind,
      link: await providerMediaUrl(args.accountId, args.link),
      caption: args.caption,
      filename: args.filename,
    })
    return r.messageId
  }

  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // content_type='image'|'video'|'document' — these are already in the
  // messages_content_type_check constraint (migration 001 + 010).
  // content_text carries the caption (or empty) so the conversation
  // list preview shows something meaningful when the user glances at it.
  const preview = args.caption?.trim() || `[${args.kind}]`
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.kind,
    content_text: args.caption ?? null,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await db
    .from('conversations')
    .update({
      last_message_text: preview,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)

  return { whatsapp_message_id: waMessageId }
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
  media?: InteractiveMedia
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
  media?: InteractiveMedia
}

/**
 * Send an interactive-button WhatsApp message from the Flows engine.
 *
 * Persists the outgoing message to `messages` with
 * `content_type='interactive'` and `sender_type='bot'` so the inbox
 * surfaces it with the "Button reply" affordance and the conversation
 * thread reflects the bot's prompt.
 *
 * Returns the Meta message id so the caller (engine) can stash it on
 * the `flow_runs.last_prompt_message_id` field for later reference.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'buttons' })
}

/**
 * Send an interactive-list WhatsApp message from the Flows engine.
 * Used when the flow needs more than 3 options (Meta's button cap).
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendInteractiveViaMeta({ ...args, kind: 'list' })
}

type SendInput =
  | (SendInteractiveButtonsEngineArgs & { kind: 'buttons' })
  | (SendInteractiveListEngineArgs & { kind: 'list' })

async function sendInteractiveViaMeta(
  input: SendInput,
): Promise<{ whatsapp_message_id: string }> {
  await assertBotRepliesEnabled(input.accountId, input.conversationId)
  const db = databaseAdmin()
  const sourcePayload: InteractiveMessagePayload = input.kind === 'buttons'
    ? { kind: 'buttons', body: input.bodyText, header: input.headerText, footer: input.footerText, buttons: input.buttons, ...(input.media ? { media: input.media } : {}) }
    : { kind: 'list', body: input.bodyText, header: input.headerText, footer: input.footerText, button_label: input.buttonLabel, sections: input.sections, ...(input.media ? { media: input.media } : {}) }
  const validation = validateInteractivePayload(sourcePayload)
  if (!validation.ok) throw new Error(validation.error)

  // Scope the contact + whatsapp_config lookups by account_id —
  // same defense-in-depth rationale as automations/meta-send.ts.
  // Migration 017 moved both tables to account-scoped tenancy.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone, wa_user_id')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact) {
    throw new Error(t('send.contactNotFound'))
  }

  // Same for the conversation the message lands in — see
  // conversation-scope.ts (GHSA-m4fx-g6pr-hrw8).
  await assertConversationInAccount(db, input.conversationId, input.accountId)

  // Phone number, or the business-scoped user ID when Meta has never
  // given us a number for this customer (issue #519).
  const sendTarget = resolveContactSendTarget(contact)
  if (!sendTarget) {
    throw new Error(
      t('send.noWhatsAppAddress', { phone: contact.phone || t('send.none') })
    )
  }
  const sanitized = sendTarget.target

  await assertInteractiveTargets(db, input.accountId, sourcePayload)
  const interactivePayload = bindInteractiveActions(sourcePayload)

  const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
    db,
    input.accountId,
    input.conversationId,
  )

  const delivery = createInteractiveDelivery({ db, accountId: input.accountId,
    conversationId: input.conversationId, senderType: 'bot', phoneNumberId, accessToken,
    payload: interactivePayload, beforeSend: () => assertBotRepliesEnabled(input.accountId, input.conversationId) })
  const attempt = (phone: string) => delivery.send(phone)

  // Same phone-variant retry as automations/meta-send.ts. Numbers
  // registered with/without a trunk 0 + Meta's sandbox quirks all
  // need this to reliably land a message.
  const variants = sendTarget.isPhone ? phoneVariants(sanitized) : [sanitized]
  let workingPhone = sanitized
  let waMessageId = ''
  let lastError: unknown = null
  for (const v of variants) {
    try {
      waMessageId = await attempt(v)
      workingPhone = v
      lastError = null
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isRecipientNotAllowedError(msg)) throw err
      lastError = err
    }
  }
  if (lastError) throw lastError

  if (sendTarget.isPhone && workingPhone !== sanitized) {
    await db.from('contacts').update({ phone: workingPhone }).eq('id', contact.id)
  }

  // Persist the bot's prompt to the messages table so it appears in
  // the inbox. content_type='interactive' is supported as of
  // migration 010; sender_type='bot' distinguishes flow sends from
  // manual agent sends (the conversation list preview will pick up
  // last_message_text as a sensible summary).
  //
  // We do NOT set interactive_reply_id here — that column is reserved
  // for the customer's tap on this message, populated by the webhook
  // when their reply arrives. We DO persist the structured payload so
  // the inbox thread re-renders the buttons/rows the bot sent (round-
  // trip), matching the composer + automation send paths.
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: 'interactive',
    content_text: input.bodyText,
    interactive_payload: interactivePayload,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(t('send.dbInsertFailed', { message: msgErr.message }))
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.bodyText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)
    .eq('account_id', input.accountId)

  return { whatsapp_message_id: waMessageId }
}
