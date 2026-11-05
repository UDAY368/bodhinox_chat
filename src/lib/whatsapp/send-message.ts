import { providerMediaUrl } from '@/lib/storage/server';
import { assertInteractiveTargets, bindInteractiveActions } from './interactive-actions';
import { createInteractiveDelivery } from './interactive-delivery';
import { resolveTemplateMediaParams } from './template-media';
import { parseSendTimeParams } from './template-send-params';
import { buildSendComponents, type SendTimeParams } from './template-send-builder';
// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes a `DataClient` and an
// `accountId` and throws `SendMessageError` on failure. The callers
// own auth, rate-limiting, body parsing, and mapping the error to
// their respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import type { DataClient } from '@/lib/data/types';

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import {
  validateInteractivePayload,
  interactivePayloadPreviewText,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { databaseAdmin } from '@/lib/flows/admin-client';
import {
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { assertNumberConnected, assertWhatsAppConversation, NoNumberError } from '@/lib/whatsapp/numbers';
import {
  assertTemplateOnNumber,
  loadSenderConfig,
  numberErrorText,
  TemplateNumberMismatchError,
} from '@/lib/whatsapp/sender-config';
import type { MessageTemplate } from '@/types';
import { templateFlowTokens } from '@/lib/whatsapp/forms/send';
import { getSessionWindow } from '@/lib/inbox/session';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  'interactive',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

/** Map a sender-number failure to the send core's typed error. */
function senderConfigError(error: unknown): unknown {
  if (error instanceof NoNumberError) {
    if (error.reason === 'disconnected') {
      return new SendMessageError('whatsapp_number_disconnected', numberErrorText(error), 409);
    }
    return error.reason === 'none'
      ? new SendMessageError(
          'whatsapp_not_configured',
          'WhatsApp not configured. Please set up your WhatsApp integration first.',
          400
        )
      : new SendMessageError('whatsapp_number_unavailable', numberErrorText(error), 400);
  }
  if (error instanceof TemplateNumberMismatchError) {
    return new SendMessageError(error.code, numberErrorText(error), 422);
  }
  return error;
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  /** Structured payload for `messageType === 'interactive'`. */
  interactivePayload?: InteractiveMessagePayload | null;
  replyToMessageId?: string | null;
  /**
   * The signed-in member sending from the inbox, stored as messages.sender_id
   * for agent attribution. Omitted by the public API (an API key is not a
   * member), so those messages stay unattributed.
   */
  senderId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * `db` may be an RLS-scoped user client (dashboard) or the service-
 * role client (public API) — every query is filtered by `accountId`
 * either way, so tenancy holds regardless of which client is passed.
 */
/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
  interactivePayload?: InteractiveMessagePayload | null;
  /** Structured template values; checked here so a bad shape 400s early. */
  templateMessageParams?: unknown;
}): void {
  const { messageType, contentText, mediaUrl, templateName, interactivePayload } =
    params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  if (messageType === 'template') {
    const parsed = parseSendTimeParams(params.templateMessageParams);
    if (!parsed.ok) throw new SendMessageError('bad_request', parsed.error, 400);
  }

  // Interactive: validate the full structured payload against Meta's
  // limits up front so a bad payload 400s before we touch Meta.
  if (messageType === 'interactive') {
    const result = validateInteractivePayload(interactivePayload);
    if (!result.ok) {
      throw new SendMessageError('bad_request', result.error, 400);
    }
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: DataClient,
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    interactivePayload: sourceInteractivePayload,
    replyToMessageId,
    senderId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  let interactivePayload = sourceInteractivePayload;
  validateSendMessageParams({
    messageType,
    contentText,
    mediaUrl,
    templateName,
    interactivePayload,
    templateMessageParams,
  });
  // Validated just above; the typed copy is what reaches the builder.
  const parsedParams = parseSendTimeParams(templateMessageParams);
  const messageParams: SendTimeParams | undefined = parsedParams.ok ? parsedParams.value : undefined;

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped.
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  // WhatsApp only: an Instagram conversation (no number) would otherwise send
  // from the default number to a linked contact's phone. Public API v1 and MCP
  // reach this core too, so they refuse it as well.
  try {
    assertWhatsAppConversation(conversation as { channel: string | null | undefined });
  } catch (error) {
    if (error instanceof NoNumberError) throw new SendMessageError('channel_not_supported', numberErrorText(error), 409);
    throw error;
  }

  const contact = conversation.contact;

  // A contact is addressable by phone number OR by business-scoped user
  // ID. Meta withholds the phone number for a customer who has adopted
  // a WhatsApp username, so those contacts carry only a BSUID and are
  // reached through Meta's `recipient` field instead of `to` (issue
  // #519). Phone stays preferred when we have one: only it supports the
  // trunk-prefix variant retry below.
  const resolvedTarget = resolveContactSendTarget(contact);
  if (!resolvedTarget) {
    throw new SendMessageError(
      'bad_request',
      contact?.phone
        ? 'Invalid phone number format'
        : 'Contact has no phone number or WhatsApp user ID',
      400
    );
  }
  const sendTarget = resolvedTarget.target;
  const hasValidPhone = resolvedTarget.isPhone;
  const sanitizedPhone = hasValidPhone ? sendTarget : '';

  // The conversation's number (default for a legacy row without one),
  // account-scoped. A disconnected number is refused, never swapped for another.
  const config = await loadSenderConfig(
    db,
    accountId,
    (conversation as { whatsapp_config_id?: string | null }).whatsapp_config_id ?? null
  ).then(assertNumberConnected).catch((error: unknown) => {
    throw senderConfigError(error);
  });

  const accessToken = decrypt(config.access_token);

  if (messageType === 'interactive') {
    try {
      await assertInteractiveTargets(db, accountId, interactivePayload!);
      interactivePayload = bindInteractiveActions(interactivePayload!);
    } catch (error) {
      throw new SendMessageError('bad_request', error instanceof Error ? error.message : 'Invalid interactive action', 400);
    }
  }

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error.message
          );
        }
      });
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.message_id;
    }
  }

  // Template row — needed for the send-builder's header + button
  // components AND for the body we persist. The lookup tolerates the
  // en / en_US split so a caller that omits the language still resolves
  // a row (see resolveTemplateRow).
  let templateRow: MessageTemplate | null = null;
  let sendLanguage = templateLanguage || 'en_US';
  if (messageType === 'template' && templateName) {
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      templateName,
      templateLanguage
    );
    if (resolved.malformed) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = resolved.row;
    sendLanguage = resolved.language;
    // A template synced from another WABA cannot be sent from this number.
    try {
      assertTemplateOnNumber(templateRow, config);
    } catch (error) {
      throw senderConfigError(error);
    }
    // Both callers (inbox and the public API) may send every kind,
    // authentication included. Building the components once here turns a
    // missing value (location, offer expiry, one-time code, card
    // variable…) into a 400 before the bot is paused or Meta is called.
    if (templateRow) {
      try {
        buildSendComponents(templateRow, {
          ...messageParams,
          body: messageParams?.body ?? templateParams,
        });
      } catch (err) {
        throw new SendMessageError(
          'bad_request',
          err instanceof Error ? err.message : 'Invalid template values',
          400
        );
      }
    }
  }

  // Anything but a template needs the 24-hour customer service window (the
  // catalogue, form and payment-link sends apply the same rule). Refused here
  // with a clear 409, before the bot is paused or Meta is called.
  if (messageType !== 'template') {
    const { data: lastInbound, error: windowError } = await db
      .from('messages')
      .select('created_at')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (windowError) throw new SendMessageError('internal', 'Could not check the customer service window', 503);
    const lastAt = (lastInbound as { created_at?: string | null } | null)?.created_at ?? null;
    if (!getSessionWindow(lastAt ? new Date(lastAt).toISOString() : null, Date.now()).active) {
      throw new SendMessageError(
        'window_closed',
        'The 24-hour customer service window is closed. Send an approved template instead.',
        409
      );
    }
  }

  const pause = await db.from('conversations').update({ bot_paused: true, updated_at: new Date().toISOString() }).eq('id', conversationId).eq('account_id', accountId);
  if (pause.error) throw new SendMessageError('internal', 'Could not pause bot replies before sending', 503);

  const interactiveDelivery = messageType === 'interactive' ? createInteractiveDelivery({
    db, accountId, conversationId, senderType: 'agent', senderId, phoneNumberId: config.phone_number_id,
    accessToken, payload: interactivePayload!, contextMessageId, replyToMessageId: replyToMessageId || undefined,
  }) : null;

  // A template's FLOW buttons each get a fresh form session for this send
  // (created once, not per phone-number variant).
  const flowTokens = messageType === 'template' && templateRow
    ? await templateFlowTokens({ accountId, buttons: templateRow.buttons, contactId: contact.id, conversationId })
    : undefined;

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: sendLanguage,
        template: templateRow ?? undefined,
        messageParams: await resolveTemplateMediaParams(accountId, templateRow, flowTokens ? { ...messageParams, flowTokens } : messageParams),
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: await providerMediaUrl(accountId, mediaUrl!),
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    if (messageType === 'interactive') {
      return interactiveDelivery!.send(phone);
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  // Send via Meta — retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sendTarget;
  try {
    // Variants only make sense for a phone number — a BSUID is opaque
    // and has exactly one correct form, so it gets a single attempt.
    const variants = hasValidPhone ? phoneVariants(sanitizedPhone) : [sendTarget];
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by Meta, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (hasValidPhone && workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .from('contacts')
      .update({ phone: workingPhone })
      .eq('id', contact.id);
  }

  // Persist the sent message. Field names MUST match the messages
  // schema (see 001_initial_schema.sql).
  // Interactive messages persist the body as content_text (so the
  // conversation-list preview reads sensibly) plus the full structured
  // payload so the thread can re-render the buttons / rows.
  //
  // Templates persist the *substituted* body. The composer pre-renders
  // and posts it as contentText; every other caller (the public API,
  // most importantly) sends none, and storing null there left the
  // Inbox rendering an empty bubble — issue #483.
  const persistedText =
    messageType === 'interactive'
      ? interactivePayload!.body
      : messageType === 'template'
        ? templateContentText(
            templateRow,
            templateBodyParams(templateParams, templateMessageParams),
            contentText
          )
        : (contentText ?? null);

  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: senderId || null,
      content_type: messageType,
      content_text: persistedText,
      media_url: mediaUrl || null,
      template_name: templateName || null,
      interactive_payload:
        messageType === 'interactive' ? interactivePayload : null,
      message_id: waMessageId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[send-message] error inserting sent message:', msgError);
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  const lastMessageText =
    messageType === 'interactive'
      ? interactivePayloadPreviewText(interactivePayload!)
      : persistedText || `[${messageType}]`;

  await db
    .from('conversations')
    .update({
      last_message_text: lastMessageText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause the active Flow run on this conversation — the agent stepping in
  // is the strongest "yield, human is here" signal. A run belongs to one
  // conversation (one per WhatsApp number), so a reply on number B leaves a
  // run waiting on number A's conversation alone. Best-effort.
  try {
    const { error: pauseErr } = await databaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('conversation_id', conversationId)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send threw:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}
