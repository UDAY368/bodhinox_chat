// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then runs the
// same shared send core.
//
// Auth: API key with the `messages:send` scope. Account context (and
// the service-role client) come from `requireApiKey`.
//
// Body:
//   {
//     "to": "+14155550123",                 // required, E.164
//     "type": "text",                        // text|template|interactive|image|video|document|audio (default: text)
//                                            // ('location' is an inbox composer type only; the public API refuses it)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"] | { "body": [...] }   // array = positional body; object = structured
//     },
//     "reply_to_message_id": "<uuid>",       // optional, must be in the same conversation
//     "name": "Jane Doe",                    // optional, names a newly-created contact
//     "phone_number_id": "1234567890"        // optional Meta phone number id to send from (default: the workspace's default number)
//   }
//
// Response (201):
//   { "data": { "message_id", "whatsapp_message_id", "conversation_id",
//               "contact_id", "contact_created" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
  VALID_MESSAGE_TYPES,
} from '@/lib/whatsapp/send-message';

/**
 * The message types the public API accepts: the send core's types except 'location', which only the inbox
 * composer sends (its coordinates are not part of the v1 contract). The contract stays closed.
 */
const V1_MESSAGE_TYPES: readonly string[] = VALID_MESSAGE_TYPES.filter((t) => t !== 'location');
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import { NoNumberError } from '@/lib/whatsapp/numbers';
import { loadSenderConfigByPhoneNumberId, numberErrorText } from '@/lib/whatsapp/sender-config';
import { manualRepliesBlocked } from '@/lib/platform/lifecycle';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!to) {
      return fail('bad_request', "'to' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';
    if (!V1_MESSAGE_TYPES.includes(type)) {
      return fail('bad_request', `Unsupported type "${type.slice(0, 40)}"`, 400);
    }

    // Unpack the optional `template` object into the flat params the
    // send core expects. `params` as an array → legacy positional body
    // params; as an object → structured header/body/button params.
    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : undefined;
    const templateMessageParams =
      template?.params && !Array.isArray(template.params)
        ? template.params
        : undefined;

    // Validate the message shape BEFORE resolveConversationByPhone
    // finds-or-creates a contact + conversation, so a bad payload 400s
    // without leaving an orphan contact/conversation behind.
    // Validated by `validateSendMessageParams` below; the cast just bridges
    // the untyped JSON body to the send-core param type.
    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? (body.interactive_payload as InteractiveMessagePayload)
        : null;

    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      interactivePayload,
      templateMessageParams,
    });

    // A platform admin may block manual replies for a workspace (abuse); an API key
    // sends on the workspace's behalf, so it is refused the same way as the inbox,
    // before any contact or conversation is created.
    if (await manualRepliesBlocked({ accountId: ctx.accountId, role: 'owner' })) {
      return fail('workspace_manual_blocked', 'Sending from this workspace is paused by Bodhinox support', 403);
    }

    // The number to send from: the one named by phone_number_id, else
    // the workspace default (resolveConversationByPhone picks it).
    if (body.phone_number_id !== undefined && body.phone_number_id !== null && typeof body.phone_number_id !== 'string') {
      return fail('bad_request', "'phone_number_id' must be a string", 400);
    }
    let whatsappConfigId: string | null = null;
    if (typeof body.phone_number_id === 'string' && body.phone_number_id.trim()) {
      try {
        whatsappConfigId = (await loadSenderConfigByPhoneNumberId(ctx.db, ctx.accountId, body.phone_number_id.trim())).id;
      } catch (error) {
        if (error instanceof NoNumberError) {
          if (error.reason === 'disconnected') return fail('whatsapp_number_disconnected', numberErrorText(error), 409);
          return error.reason === 'none'
            ? fail('whatsapp_not_configured', 'WhatsApp not configured. Please set up your WhatsApp integration first.', 400)
            : fail('whatsapp_number_unavailable', numberErrorText(error), 400);
        }
        throw error;
      }
    }

    // Find-or-create the conversation for this phone, then send. Both
    // steps share `SendMessageError`, so one catch maps the whole
    // pipeline to the envelope.
    const resolved = await resolveConversationByPhone(
      ctx.db,
      ctx.accountId,
      to,
      typeof body.name === 'string' ? body.name : null,
      { whatsappConfigId }
    );

    const result = await sendMessageToConversation(
      ctx.db,
      ctx.accountId,
      {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName: typeof template?.name === 'string' ? template.name : null,
        templateLanguage:
          typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
        interactivePayload,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      }
    );

    return ok(
      {
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        conversation_id: resolved.conversationId,
        contact_id: resolved.contactId,
        contact_created: resolved.contactCreated,
      },
      201
    );
  } catch (err) {
    if (err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
