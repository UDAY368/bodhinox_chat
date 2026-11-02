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

const t = getT('Api')
const tForm = getT('Validation.formSend')
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

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
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

    // A WhatsApp form goes to an open conversation only (it needs the
    // 24-hour window), through the shared form sender.
    if (message_type === 'form') {
      return sendFormMessage({ accountId, userId, role, body })
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
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: t('common.conversationNotFound') },
          { status: 404 }
        )
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

      const resolved = await findOrCreateConversation(
        db,
        accountId,
        userId,
        contact_id
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
      })

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
    console.error('Error in WhatsApp send POST:', error)
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

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  db: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return created.id
}
