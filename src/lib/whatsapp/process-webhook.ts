import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl } from '@/lib/whatsapp/meta-api'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import {
  hasUsableIdentity,
  identityDisplayName,
  resolveInboundIdentity,
  type WaContactPayload,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

import { createAdminClient } from '@/lib/data/admin';
import { currentJobScope, withJobScope } from '@/lib/jobs/scope';
import { resolveWhatsAppAccount, resolveWabaAccount } from '@/lib/repositories/routing';
import { createServerStorageFacade } from '@/lib/storage/server';
import { applyProviderStatus, ingestInboundMessage, type ProviderStatus } from '@/lib/whatsapp/ingest';
import { enqueueJob } from '@/lib/jobs/queue';
import { inboundAddress, inboundLocation, type InboundStructuredPayload } from '@/lib/whatsapp/inbound-structured';
import { parseFormReply, type FormAnswers } from '@/lib/whatsapp/forms/responses';
import { parseInboundOrder, type InboundOrder } from '@/lib/commerce/order-format';
import { parseReferral, type WhatsAppReferral } from '@/lib/meta-ads/referrals';
export { processInboundActions } from '@/lib/whatsapp/inbound-actions';
export type { InboundActionsPayload } from '@/lib/whatsapp/ingest';
function databaseAdmin() { return createAdminClient(currentJobScope()); }
interface WhatsAppMessage {
  id: string
  /**
   * Sender's phone number. **Optional since Meta's username rollout** —
   * a sender who has adopted a WhatsApp username and has no recent
   * interaction history with this business arrives with no phone number
   * at all, identified only by `from_user_id` (issue #519). See
   * `@/lib/whatsapp/wa-identity`.
   */
  from?: string
  /** Sender's business-scoped user ID (BSUID). */
  from_user_id?: string
  /** Sender's portfolio-level BSUID. */
  from_parent_user_id?: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: { latitude: number; longitude: number; name?: string; address?: string }
  reaction?: { message_id: string; emoji: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
    /**
     * Reply to an address_message form (`response_json` holds `{ values: {...} }`)
     * or a submitted WhatsApp form (`name: 'flow'`, answers plus our flow_token).
     */
    nfm_reply?: { name?: string; response_json?: string }
  }
  /**
   * Set when the customer taps a QUICK_REPLY button on a *template*
   * message — a broadcast, or any template send. Meta uses a different
   * envelope from `interactive` above: `type: 'button'`, the label in
   * `button.text`, and the payload configured on the template's button
   * in `button.payload` (Meta's own template editor doesn't ask for a
   * payload and mirrors the label into it).
   */
  button?: { text?: string; payload?: string }
  /** A cart sent from a catalogue: `type: 'order'`. Prices are major units. */
  order?: {
    catalog_id?: string
    text?: string
    product_items?: Array<{ product_retailer_id?: string; quantity?: number | string; item_price?: number | string; currency?: string }>
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
  /** Present on the first message after the customer taps a click-to-WhatsApp ad or post. Untrusted. */
  referral?: WhatsAppReferral
}

/** One entry of a failed status's `errors` array, as Meta sends it. */
interface MetaStatusError {
  code: number
  title: string
  message?: string
  error_data?: { details?: string }
  href?: string
}

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name?: string; username?: string }
        /** Absent for a username-only sender — see WhatsAppMessage.from. */
        wa_id?: string
        user_id?: string
        parent_user_id?: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
        /**
         * Only present when `status === 'failed'`. Meta's reason for the
         * failure — `code` is a stable numeric error code (e.g. 131049),
         * `title` a short label, `error_data.details` the human-readable
         * explanation. See #535.
         */
        errors?: MetaStatusError[]
      }>
    }
    field: string
  }>
}

export async function processWebhook(body: { entry?: WhatsAppWebhookEntry[] }, assertLease: () => void = () => {}) {
  if (!body.entry) return;
  for (const entry of body.entry) {
    for (const change of entry.changes) {
      assertLease();
      const templateEvent = isTemplateWebhookField(change.field);
      // A malformed provider id is unroutable (skipped), not a retryable error that burns every attempt.
      const phoneNumberId = change.value.metadata?.phone_number_id;
      const accountId = templateEvent
        ? (PROVIDER_ID.test(String(entry.id ?? '')) ? await resolveWabaAccount(entry.id) : null)
        : typeof phoneNumberId === 'string' && PROVIDER_ID.test(phoneNumberId) ? await resolveWhatsAppAccount(phoneNumberId) : null;
      if (!accountId) continue;
      await withJobScope({ accountId, role: 'owner' }, async () => {
        if (templateEvent) {
          await handleTemplateWebhookChange({ field: change.field, value: change.value as unknown, wabaId: entry.id }, databaseAdmin());
          return;
        }
        const value = change.value;
        if (value.statuses) for (const status of value.statuses) await handleStatusUpdate(status);
        if (!value.messages) return;
        const { data: config, error } = await databaseAdmin().from('whatsapp_config').select('*').eq('account_id', accountId).eq('phone_number_id', value.metadata.phone_number_id).single();
        if (error || !config) throw new Error('WhatsApp account configuration unavailable');
        const decryptedAccessToken = decrypt(config.access_token);
        await withJobScope({ accountId, userId: config.user_id, role: 'owner' }, async () => {
          for (let index = 0; index < value.messages!.length; index++) {
            await processMessage(value.messages![index], value.contacts?.[index] || value.contacts?.[0], accountId, config.user_id, decryptedAccessToken, config.mirror_inbound_media !== false, config.id);
          }
        });
      });
    }
  }
}
async function handleStatusUpdate(status: { id: string; status: string; timestamp: string; recipient_id: string; errors?: MetaStatusError[] }) {
  const context=currentJobScope();
  if(!context) throw new Error('Provider status requires a resolved tenant');
  try {
    await applyProviderStatus(context.accountId,status);
  } catch (error) {
    // A callback that beat the sender's commit retries on its own job, so it
    // cannot fail (and replay) the sibling statuses and messages of this delivery.
    if (!isAwaitingPersistence(error)) throw error;
    await deferProviderStatus(context.accountId, status);
  }
}

/** Job that retries one provider status whose outbound row was not committed yet. */
export const PROVIDER_STATUS_RETRY_JOB = 'whatsapp.status_retry';
/** Meta phone number and WhatsApp Business Account ids are digits only (same rule as the routing functions). */
const PROVIDER_ID = /^\d{1,32}$/;
const PROVIDER_STATUS_RETRY_DELAY_MS = 2_000;

// By name, like UncertainDispatchError in the queue, so module mocks and bundling cannot defeat it.
function isAwaitingPersistence(error: unknown) {
  return error instanceof Error && error.name === 'StatusAwaitingPersistenceError';
}

/** Only what applyProviderStatus reads; the recipient's phone number stays out of the job row. */
function retryableStatus(status: ProviderStatus): ProviderStatus {
  const failure = status.errors?.[0];
  return {
    id: status.id, status: status.status, timestamp: status.timestamp,
    ...(failure ? { errors: [{ code: failure.code, title: failure.title,
      ...(failure.error_data?.details ? { error_data: { details: failure.error_data.details } } : {}) }] } : {}),
  };
}

async function deferProviderStatus(accountId: string, status: ProviderStatus) {
  // Committed before this delivery's job finishes, so the status is never lost;
  // a replayed delivery reuses the same retry job instead of adding another.
  await enqueueJob(PROVIDER_STATUS_RETRY_JOB, { accountId, status: retryableStatus(status) }, {
    tenantId: accountId,
    runAt: new Date(Date.now() + PROVIDER_STATUS_RETRY_DELAY_MS),
    dedupeKey: `provider-status:${accountId}:${status.id}:${status.status}`,
  });
}

function parseRetryableStatus(value: unknown): ProviderStatus {
  const v = value as Partial<ProviderStatus> | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.status !== 'string'
    || typeof v.timestamp !== 'string' || (v.errors !== undefined && !Array.isArray(v.errors)))
    throw new Error('Invalid provider status retry payload');
  return retryableStatus(v as ProviderStatus);
}

/**
 * Retries one deferred status. Still unknown and fresh, it throws and the queue
 * backs off (2+4+8+16 s, past STATUS_PERSISTENCE_GRACE_MS), so a later attempt
 * applies it or applyProviderStatus drops it as stale: never an endless retry.
 */
export async function retryProviderStatus(accountId: string, payload: Record<string, unknown>) {
  if (payload.accountId !== accountId) throw new Error('Provider status retry tenant mismatch');
  await applyProviderStatus(accountId, parseRetryableStatus(payload.status));
}

/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await databaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    throw new Error('Inbound reply lookup failed')
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await databaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      throw new Error('Inbound reaction deletion failed')
    }
    return
  }

  const { error: upsertError } = await databaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    throw new Error('Inbound reaction persistence failed')
  }
}

async function processMessage(
  message: WhatsAppMessage,
  contact: WaContactPayload | undefined,
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  // Per-account opt-out for the inbound-media mirror (migration 039).
  // See parseMessageContent for what it turns off.
  mirrorMedia: boolean,
  // The number (whatsapp_config.id) the message arrived on; the
  // conversation is per (contact, number).
  whatsappConfigId: string
) {
  // Phone number OR business-scoped user ID — Meta sends only the
  // latter for a sender who has adopted a WhatsApp username (#519).
  const identity = resolveInboundIdentity(message, contact)
  if (!hasUsableIdentity(identity)) {
    // Neither key present. Creating a row anyway would mean an
    // unreachable contact that can never be matched again, so drop the
    // delivery loudly instead of silently accumulating them.
    console.error(
      '[webhook] inbound message carries neither a phone number nor a BSUID; skipping:',
      message.id
    )
    return
  }

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    identity,
    message.id
  )
  if (!contactOutcome) throw new Error('Inbound contact persistence failed')
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    message.id,
    whatsappConfigId
  )
  if (!convResult) throw new Error('Inbound conversation persistence failed')
  const conversation = convResult.conversation

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    if(convResult.created) await dispatchWebhookEvent(databaseAdmin(),accountId,'conversation.created',{conversation_id:conversation.id,contact_id:contactRecord.id});
    await handleReaction(message, conversation.id, contactRecord.id)
    return
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId, interactivePayload, formReply, order } =
    await parseMessageContent(
      message,
      accessToken,
      mirrorMedia ? { accountId } : null
    )

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see db/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, media_type, template_name, message_id, status,
  //   created_at

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image'         // stickers are images
      : message.type === 'button' || (message.type === 'order' && order)
        ? 'interactive' // template quick-reply tap (issue #478); a cart (its items in interactive_payload.order)
        : 'text'        // reaction, unknown → text fallback

  await ingestInboundMessage({
    accountId,userId:configOwnerUserId,contactId:contactRecord.id,conversationId:conversation.id,
    metaMessageId:message.id,contentType,contentText,mediaUrl,mediaType,interactiveReplyId,interactivePayload,
    ...(formReply ? { formReply } : {}),
    ...(order ? { order } : {}),
    replyToMessageId:replyToInternalId,contextMetaId:message.context?.id ?? null,createdAt:new Date(parseInt(message.timestamp,10)*1000),
    wasContactCreated:contactOutcome.wasCreated,wasConversationCreated:convResult.created,whatsappConfigId,
    // Bounded and never throws; null when absent or unusable.
    referral:parseReferral(message.referral),
  });
}

/** Verify optional inbound media before the atomic message/unread/action-job commit. */
async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string,
  // Tenancy + opt-out for the media mirror. Null disables mirroring
  // entirely, which is what the account-level toggle does.
  mirror: { accountId: string } | null
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
  /** Structured location or address-form reply, kept for flows. */
  interactivePayload: InboundStructuredPayload | null
  /** A submitted WhatsApp form; ingest stores it and writes the inbox summary. */
  formReply?: { flowToken: string | null; answers: FormAnswers }
  /** A cart; ingest stores the order with the message and writes the inbox summary. */
  order?: InboundOrder
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  //
  // Beyond verifying, this is where inbound media gets COPIED into the
  // `chat-media` bucket (issue #466). Meta deletes media ~30 days after
  // receipt, so the `/api/whatsapp/media/<id>` proxy URL we used to
  // store is a pointer with an expiry date on it — every inbound
  // attachment silently became "Photo unavailable" a month later.
  // Mirroring stores a durable public URL instead.
  //
  // The mirror is strictly best-effort. `mirrorInboundMedia` swallows
  // its own failures and returns null, and we fall back to the proxy
  // URL — a webhook that throws would have Meta retry the delivery and
  // re-run everything downstream, which is a far worse outcome than an
  // attachment that expires.
  const verifyAndBuildUrl = async (
    mediaId: string,
    fileName?: string | null
  ): Promise<string | null> => {
    try {
      const info = await getMediaUrl({ mediaId, accessToken })

      if (mirror) {
        const mirrored = await mirrorInboundMedia({
          storage: createServerStorageFacade(currentJobScope()!),
          accountId: mirror.accountId,
          mediaId,
          downloadUrl: info.url,
          accessToken,
          mimeType: info.mimeType,
          fileSize: info.fileSize,
          fileName,
          messageTimestamp: message.timestamp,
        })
        if (mirrored) return mirrored
      }

      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
    interactivePayload: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.image.id),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          // The sender's own filename becomes the mirrored object's
          // name, so saving the attachment yields `invoice.pdf` even
          // when a caption displaced the filename in content_text.
          mediaUrl: await verifyAndBuildUrl(
            message.document.id,
            message.document.filename
          ),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.audio.id),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText, interactivePayload: inboundLocation(loc) }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      const address = inboundAddress(message.interactive?.nfm_reply)
      if (address) {
        return { ...empty, contentText: Object.values(address.address).join(', ') || '[Address]', interactivePayload: address }
      }
      const formReply = parseFormReply(message.interactive?.nfm_reply)
      if (formReply) return { ...empty, contentText: '[Form]', formReply }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    case 'button': {
      // Quick-reply tap on a TEMPLATE message. Meta delivers these under
      // their own `button` envelope rather than `interactive` above, so
      // without this case they fell through to `default` and landed in
      // the inbox as "[Unsupported message type: button]" with a null
      // interactiveReplyId — which also meant the Flows engine and the
      // `interactive_reply` automation trigger never saw the tap, so
      // nothing chained off a broadcast reply (issue #478).
      //
      // `payload` is the stable value (the analogue of
      // `button_reply.id`); `text` is the visible label. Prefer the
      // payload for routing and the label for display, each falling
      // back to the other since a template may carry only one.
      const payload = message.button?.payload || null
      const label = message.button?.text || null
      return {
        ...empty,
        contentText: label || payload,
        interactiveReplyId: payload || label,
      }
    }

    case 'order': {
      // A cart sent from the catalogue. A cart that cannot be stored exactly
      // (mixed currencies, a malformed price) is kept as a plain message.
      const order = parseInboundOrder(message.order)
      return order ? { ...empty, contentText: '[Order]', order } : { ...empty, contentText: '[Order]' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

/**
 * Look a contact up by BSUID. Exact match on the column backing
 * migration 040's unique index — no fuzzy matching, because a BSUID is
 * an opaque identifier with exactly one correct spelling.
 */
async function findContactByWaUserId(
  accountId: string,
  waUserId: string
): Promise<ContactRow | null> {
  const { data, error } = await databaseAdmin()
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_user_id', waUserId)
    .maybeSingle()

  if (error) {
    throw new Error('Inbound contact identity lookup failed')
  }
  return data ?? null
}

/**
 * Fields worth writing back onto a contact we just matched, given what
 * this delivery told us. Returns null when nothing changed, so the
 * common case costs no UPDATE.
 *
 * The BSUID backfill is the important one: it stamps the id onto a
 * contact we have only ever known by phone, so the NEXT message from
 * that person — which may well arrive with no phone number at all —
 * still resolves to this same row instead of forking a new one.
 * Likewise a phone backfill upgrades a BSUID-only contact the moment
 * Meta discloses the number, making them reachable by every existing
 * phone-based code path.
 */
function contactIdentityPatch(
  existing: ContactRow,
  identity: WaIdentity
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {}

  // Only ever from a label Meta actually supplied. `identityDisplayName`
  // falls back to the phone number / BSUID, which is the right choice
  // for a brand-new row but would clobber an agent's hand-edited name
  // on every inbound message from a contact with no WhatsApp profile
  // name.
  const name = identity.name || identity.waUsername
  if (name && name !== existing.name) patch.name = name

  if (identity.waUserId && identity.waUserId !== existing.wa_user_id) {
    patch.wa_user_id = identity.waUserId
  }
  if (
    identity.waParentUserId &&
    identity.waParentUserId !== existing.wa_parent_user_id
  ) {
    patch.wa_parent_user_id = identity.waParentUserId
  }
  if (identity.waUsername && identity.waUsername !== existing.wa_username) {
    patch.wa_username = identity.waUsername
  }
  // Only ever fills a blank. An existing number is left alone — the
  // send path's variant retry already owns correcting it, and Meta's
  // formatting differences are not a reason to rewrite it.
  if (identity.phone && !normalizePhone(existing.phone ?? '')) {
    patch.phone = identity.phone
  }

  return Object.keys(patch).length > 0 ? patch : null
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  identity: WaIdentity,
  metaMessageId: string,
): Promise<ContactOutcome | null> {
  // BSUID first when we have one. It's stable per (user, business
  // portfolio) and, unlike the phone number, Meta will keep sending it
  // — so it's the key that survives a customer adopting a username.
  let existingContact: ContactRow | null = identity.waUserId
    ? await findContactByWaUserId(accountId, identity.waUserId)
    : null

  // Fall back to the phone. The shared helper pre-filters in SQL by the
  // last-8-digit suffix (so we don't pull every contact on every
  // inbound message) then applies the strict `phonesMatch` in JS on the
  // small candidate set. The same helper backs the manual contact form
  // and CSV import, so all three paths agree on what "same number"
  // means (issue #212).
  if (!existingContact && identity.phone) {
    existingContact = await findExistingContact(
      databaseAdmin(),
      accountId,
      identity.phone,
    )
  }

  if (existingContact) {
    const patch = contactIdentityPatch(existingContact, identity)
    if (patch) {
      const { data: updated, error: updateError } = await databaseAdmin()
        .from('contacts')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
        .select()
        .maybeSingle()

      if (updateError) {
        if (!isUniqueViolation(updateError)) throw new Error('Inbound contact identity persistence failed')
        // A BSUID backfill can lose a race with a concurrent delivery
        // that already claimed it for another row. Not fatal — the
        // message still belongs to the contact we matched.
        console.error(
          '[webhook] contact identity backfill failed:',
          updateError.message
        )
      } else if (updated) {
        existingContact = updated
      }
    }
    return { contact: existingContact, wasCreated: existingContact.inbound_created_meta_id === metaMessageId }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  //
  // `phone` stays NOT NULL in the schema, so a BSUID-only sender is
  // stored with '' — which migration 022's partial unique index
  // tolerates, and migration 040's BSUID index is what keeps them
  // unique instead.
  const { data: newContact, error: createError } = await databaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: identity.phone,
      name: identityDisplayName(identity),
      wa_user_id: identity.waUserId,
      wa_parent_user_id: identity.waParentUserId,
      wa_username: identity.waUsername,
      inbound_created_meta_id: metaMessageId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and a unique
    // index (022's phone, or 040's BSUID) rejected the duplicate.
    // Re-resolve the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = identity.waUserId
        ? await findContactByWaUserId(accountId, identity.waUserId)
        : null
      if (raced) return { contact: raced, wasCreated: raced.inbound_created_meta_id === metaMessageId }
      if (identity.phone) {
        const racedByPhone = await findExistingContact(
          databaseAdmin(),
          accountId,
          identity.phone
        )
        if (racedByPhone) return { contact: racedByPhone, wasCreated: racedByPhone.inbound_created_meta_id === metaMessageId }
      }
    }
    throw new Error('Inbound contact persistence failed')
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  metaMessageId: string,
  whatsappConfigId: string,
) {
  // One conversation per (contact, number): a contact who messages two
  // of the workspace's numbers has two threads, and each thread keeps
  // the number it started on.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and >=2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const findForNumber = () => databaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    // A number match excludes Instagram rows (they never have one).
    .eq('whatsapp_config_id', whatsappConfigId)
    .order('created_at', { ascending: true })
    .limit(1)
  const existingFor = (row: { inbound_created_meta_id?: string | null }) =>
    ({ conversation: row, created: row.inbound_created_meta_id === metaMessageId })

  const { data: existingRows, error: findError } = await findForNumber()
  if (findError) {
    throw new Error('Inbound conversation lookup failed')
  }
  if (existingRows && existingRows.length > 0) return existingFor(existingRows[0])

  // A conversation with no number (created before any number was
  // connected, or whose number was removed) is this contact's thread:
  // the number it now arrives on adopts it rather than starting another.
  const { data: adopted, error: adoptError } = await databaseAdmin()
    .from('conversations')
    .update({ whatsapp_config_id: whatsappConfigId })
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    // Never an Instagram conversation (no number either) of a linked contact:
    // setting a number on it would violate conversations_channel_sender_check.
    .eq('channel', 'whatsapp')
    .is('whatsapp_config_id', null)
    .select('*')
  if (adoptError && !isUniqueViolation(adoptError)) {
    throw new Error('Inbound conversation lookup failed')
  }
  if (adopted && adopted.length > 0) return existingFor(adopted[0])

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await databaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
      inbound_created_meta_id: metaMessageId,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery created (or adopted)
    // the conversation between our lookup and insert, and the unique
    // index rejected the duplicate. Re-resolve the winning row instead
    // of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError) || adoptError) {
      const { data: raced } = await findForNumber()
      if (raced && raced.length > 0) return existingFor(raced[0])
    }
    throw new Error('Inbound conversation persistence failed')
  }

  return { conversation: newConv, created: true }
}
