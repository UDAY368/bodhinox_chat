import { NextResponse } from 'next/server'
import { createClient } from '@/lib/data/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import { getT } from '@/lib/i18n/translate'
import { randomUUID } from 'node:crypto'
import { FormSendError, sendForm } from '@/lib/whatsapp/forms/send'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { UncertainDispatchError } from '@/lib/jobs/dispatch'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { NoNumberError } from '@/lib/whatsapp/numbers'
import { loadPickableNumbers, loadSenderConfig, numberErrorText, pickDefaultNumber } from '@/lib/whatsapp/sender-config'
import { claimOnAgentReply } from '@/lib/inbox/lifecycle'
import { instagramConfig } from '@/lib/instagram/config'
import { InstagramError } from '@/lib/instagram/errors'
import { instagramErrorResponse, NO_STORE } from '@/lib/instagram/http'
import { recordSuggestionUse } from '@/lib/ai/assist/suggestions'
import { logAiEvent } from '@/lib/ai/log'
import { manualRepliesBlocked } from '@/lib/platform/lifecycle'
import { logContactActivity } from '@/lib/contacts/profile'

const t = getT('Api')
const tForm = getT('Validation.formSend')
const tIg = getT('Api.instagram')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    // Requires the 'agent' role, matching both `canSendMessages` and the
    // `messages_modify` RLS policy (migration 017).
    //
    // Resolving `account_id` off the profile — which any 'viewer' has —
    // was previously the only gate. RLS did block the message INSERT, but
    // the send core calls Meta BEFORE it persists, so a viewer's request
    // still delivered a real WhatsApp message to the customer and merely
    // failed to record it (surfacing as "sent to Meta but failed to save
    // to DB"). RLS can't un-send that, so the role check belongs here.
    const { db, accountId, userId, role } = await requireRole('agent')

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // A platform admin may block manual replies for a workspace (abuse). Billing or admin
    // suspension alone never refuses a manual reply; inbound messages are never affected.
    if (await manualRepliesBlocked({ accountId, userId, role })) {
      return NextResponse.json(
        { error: t('send.manualBlocked'), code: 'workspace_manual_blocked' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      // contact_id path only: the number to send from (whatsapp_config.id);
      // omitted means the workspace default, as before multi-number.
      whatsapp_config_id: whatsappConfigIdInput,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
    } = body
    // A text that started as an AI suggested reply (inserted into the composer
    // by staff). Only used to record the suggestion after the send.
    const aiSuggestionId = aiSuggestionIdOf(body)

    // A WhatsApp form goes to an open conversation only (it needs the
    // 24-hour window), through the shared form sender.
    if (message_type === 'form') {
      return sendFormMessage({ accountId, userId, role, body })
    }

    // A saved Instagram card/button template: only into an existing Instagram
    // conversation of this workspace (the row decides the channel, never the client).
    if (message_type === 'ig_template') {
      if (!conversationIdInput) return NextResponse.json({ error: t('send.idsRequired') }, { status: 400 })
      const { data, error: convError } = await db
        .from('conversations')
        .select('id,channel')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()
      if (convError || !data) return NextResponse.json({ error: t('common.conversationNotFound') }, { status: 404 })
      if ((data as { channel?: string | null }).channel !== 'instagram') return instagramErrorResponse('channel_not_supported')
      return sendInstagramMessage({ accountId, userId, role, conversationId: data.id, body, aiSuggestionId: null })
    }

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            t('send.idsRequired'),
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
        templateMessageParams: template_message_params,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await db
        .from('conversations')
        .select('id,channel')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: t('common.conversationNotFound') },
          { status: 404 }
        )
      }
      // The channel comes from the conversation row, never from the client.
      if ((data as { channel?: string | null }).channel === 'instagram') {
        return sendInstagramMessage({ accountId, userId, role, conversationId: data.id, body, aiSuggestionId })
      }
      conversationId = data.id
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: t('send.contactNotFound') },
          { status: 404 }
        )
      }

      // A contact has one conversation per number: resolve the sending
      // number first so the thread (and the reply number) are the right ones.
      let numberId: string
      try {
        const requested = typeof whatsappConfigIdInput === 'string' && whatsappConfigIdInput ? whatsappConfigIdInput : null
        numberId = (await loadSenderConfig(db, accountId, requested)).id
      } catch (err) {
        if (err instanceof NoNumberError) {
          return NextResponse.json(
            { error: numberErrorText(err), code: `whatsapp_number_${err.reason}` },
            { status: err.reason === 'disconnected' ? 409 : err.reason === 'not_found' ? 404 : 400 }
          )
        }
        throw err
      }

      const resolved = await findOrCreateConversation(
        db,
        accountId,
        userId,
        contact_id,
        numberId
      )
      if (!resolved) {
        return NextResponse.json(
          { error: t('send.openConversationFailed') },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: t('common.conversationNotFound') },
        { status: 404 }
      )
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
        senderId: userId,
      })
      // The replying member takes an unassigned conversation. Best effort:
      // the message is already sent, so a failure here must not fail the send.
      await claimOnAgentReply({ accountId, userId, role }, conversationId).catch(() =>
        console.error('[send] conversation claim failed')
      )
      if (aiSuggestionId && message_type === 'text') {
        await noteSuggestionUse({ accountId, userId, role }, aiSuggestionId, conversationId, result.messageId, content_text)
      }
      // A template started from the contact profile goes on its timeline
      // (the template's name only). Best effort: the message is already sent.
      if (message_type === 'template' && typeof contact_id === 'string' && !conversationIdInput) {
        await logContactActivity({ accountId, userId, role }, contact_id, 'template_sent', {
          template: typeof template_name === 'string' ? template_name.slice(0, 512) : null,
        }).catch(() => console.error('[send] contact timeline row failed'))
      }

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    // Class name only: provider errors can echo message text or tokens.
    console.error('Error in WhatsApp send POST:', error instanceof Error ? error.name : typeof error)
    return toErrorResponse(error)
  }
}

/**
 * `message_type: 'form'`: `{ conversation_id, form_id, content_text (body),
 * form_cta, form_header?, form_footer?, client_request_id? }`. The same
 * client_request_id never sends twice. Refusals (unpublished form, blocked
 * contact, closed window) come back as 4xx with a readable error.
 */
async function sendFormMessage(args: {
  accountId: string
  userId: string
  role: 'owner' | 'admin' | 'agent' | 'viewer'
  body: Record<string, unknown>
}) {
  const { body } = args
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : ''
  const formId = typeof body.form_id === 'string' ? body.form_id : ''
  if (!UUID.test(conversationId) || !UUID.test(formId)) {
    return NextResponse.json({ error: tForm('idsRequired') }, { status: 400 })
  }
  const requestId = typeof body.client_request_id === 'string' && UUID.test(body.client_request_id) ? body.client_request_id : randomUUID()
  const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : undefined)
  try {
    const result = await sendForm({
      accountId: args.accountId,
      userId: args.userId,
      role: args.role,
      sender: 'agent',
      conversationId,
      formId,
      cta: text('form_cta') ?? '',
      body: text('content_text') ?? '',
      header: text('form_header'),
      footer: text('form_footer'),
      intentKey: `form:inbox:${conversationId}:${requestId}`,
    })
    return NextResponse.json({ success: true, message_id: result.messageId, whatsapp_message_id: result.whatsappMessageId })
  } catch (err) {
    if (err instanceof FormSendError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    if (err instanceof UncertainDispatchError) return NextResponse.json({ error: tForm('uncertain') }, { status: 409 })
    if (err instanceof MetaApiError) return NextResponse.json({ error: `Meta API error: ${err.message}` }, { status: 502 })
    throw err
  }
}

/**
 * An Instagram conversation (the row says so): text, image, audio, video, PDF
 * or a saved card/button template (ig_template + template_id) inside the
 * messaging window, through the Instagram composer sender.
 * Every other kind is channel_not_supported. A refusal stores nothing; an
 * ambiguous outcome leaves the row 'unknown' for a person to check.
 */
async function sendInstagramMessage(args: {
  accountId: string
  userId: string
  role: 'owner' | 'admin' | 'agent' | 'viewer'
  conversationId: string
  body: Record<string, unknown>
  aiSuggestionId?: string | null
}) {
  if (!instagramConfig()) return instagramErrorResponse('instagram_not_enabled')
  const { body } = args
  // Loaded only for Instagram conversations, so the WhatsApp path's module graph is unchanged.
  const [{ ChannelUnavailableError }, { InstagramDeliveryUncertainError, InstagramSendRejectedError, sendInstagramFromComposer }] =
    await Promise.all([import('@/lib/channels/sender'), import('@/lib/instagram/composer-send')])
  try {
    const result = await sendInstagramFromComposer({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      messageType: body.message_type,
      contentText: body.content_text,
      mediaUrl: body.media_url,
      filename: body.filename,
      templateId: body.template_id,
    })
    await claimOnAgentReply({ accountId: args.accountId, userId: args.userId, role: args.role }, args.conversationId).catch(() =>
      console.error('[send] conversation claim failed')
    )
    if (args.aiSuggestionId && body.message_type === 'text') {
      await noteSuggestionUse({ accountId: args.accountId, userId: args.userId, role: args.role },
        args.aiSuggestionId, args.conversationId, result.messageId, body.content_text)
    }
    return NextResponse.json({ success: true, message_id: result.messageId, provider_message_id: result.providerMessageId })
  } catch (err) {
    if (err instanceof InstagramError) return instagramErrorResponse(err.code)
    if (err instanceof ChannelUnavailableError) return instagramErrorResponse('channel_not_supported')
    if (err instanceof InstagramDeliveryUncertainError)
      return NextResponse.json({ error: err.code, message: tIg('delivery_uncertain'), message_id: err.messageId },
        { status: 409, headers: NO_STORE })
    if (err instanceof InstagramSendRejectedError)
      return NextResponse.json({ error: err.code, message: tIg('meta_error'), message_id: err.messageId },
        { status: 502, headers: NO_STORE })
    throw err
  }
}

/** The optional `ai_suggestion_id` of a text send (a uuid), else null. */
function aiSuggestionIdOf(body: unknown): string | null {
  const value = (body as { ai_suggestion_id?: unknown } | null)?.ai_suggestion_id
  return typeof value === 'string' && UUID.test(value) ? value : null
}

/**
 * Records that a sent text used an AI suggested reply (accepted unchanged or
 * edited). Runs only after the message was sent and stored; best-effort in
 * its own transaction, so it never changes or fails the send. Only a reason
 * code is logged.
 */
async function noteSuggestionUse(
  member: { accountId: string; userId: string; role: 'owner' | 'admin' | 'agent' | 'viewer' },
  suggestionId: string,
  conversationId: string,
  messageId: unknown,
  sentText: unknown,
): Promise<void> {
  if (typeof messageId !== 'string' || !UUID.test(messageId) || typeof sentText !== 'string') return
  try {
    await recordSuggestionUse(member, { suggestionId, conversationId, messageId, sentText })
  } catch (error) {
    logAiEvent({ feature: 'suggest', reason: 'suggestion_use_not_recorded', accountId: member.accountId, error })
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

type ConversationRef = { id: string; whatsapp_config_id: string | null }

/** Query results as a list (a single-row result reads as a one-item list). */
function conversationRows(data: unknown): ConversationRef[] {
  return (Array.isArray(data) ? data : data ? [data] : []) as ConversationRef[]
}

/**
 * Return the contact's conversation on `numberId`, creating one if it
 * doesn't exist yet. A contact has one conversation per (contact, number),
 * as the webhook creates them; a legacy conversation with no number counts
 * for the workspace default, which is what it replies from. Never picks a
 * conversation on another number, and never fails because the contact has
 * several. Runs under the caller's RLS — the conversations_insert policy
 * requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  db: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
  numberId: string,
): Promise<string | null> {
  const find = async (): Promise<string | null | undefined> => {
    const { data, error } = await db
      .from('conversations')
      .select('id,whatsapp_config_id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      // An Instagram conversation (no number either) is never this contact's WhatsApp thread.
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: true })
      .limit(100)
    if (error) return undefined
    const rows = conversationRows(data)
    const onNumber = rows.find((row) => row.whatsapp_config_id === numberId)
    if (onNumber) return onNumber.id
    const legacy = rows.find((row) => !row.whatsapp_config_id)
    if (!legacy) return null
    // An unnumbered conversation replies from the default number.
    // Status and the cleared-token check, so a disconnected number is never the fallback.
    const numbers = await loadPickableNumbers(db, accountId)
    if (!numbers) return undefined
    const fallback = pickDefaultNumber(numbers)
    return fallback?.id === numberId ? legacy.id : null
  }

  const existing = await find()
  if (existing === undefined) {
    console.error('Error resolving conversation for contact send')
    return null
  }
  if (existing) return existing

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: numberId,
    })
    .select('id')
    .single()

  if (error) {
    // A concurrent send or inbound message created it first.
    if (isUniqueViolation(error)) return (await find()) ?? null
    console.error('Error creating conversation for contact send:', error.code ?? 'unknown')
    return null
  }

  return created.id
}
