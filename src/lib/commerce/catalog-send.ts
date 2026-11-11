/**
 * Sends catalogue messages (one product, a product list, or the whole
 * catalogue) into an open conversation. Shared by the inbox (POST
 * /api/whatsapp/send-product) and the flow engine's send_product,
 * send_product_list and send_catalog steps.
 *
 * The message goes from the conversation's own number (the workspace default
 * for a legacy conversation) using the catalogue linked to that number; a
 * disconnected number or a number without a catalogue is refused, never
 * swapped for another. Products must exist, visible, in our mirror of that
 * catalogue. The Meta call is an outbound intent (dispatchOnce): an ambiguous
 * outcome throws UncertainDispatchError and is never re-sent automatically.
 * The message row is written afterwards, idempotently on (conversation, wamid).
 */

import { conversationVisible } from '@/lib/inbox/visibility-sql';
import type { PrismaClient } from '@prisma/client';
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { assertBotRepliesEnabled } from '@/lib/whatsapp/bot-pause';
import { manualRepliesBlockedIn } from '@/lib/platform/lifecycle';
import { agentSenderId } from '@/lib/whatsapp/agent-attribution';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  PRODUCT_MESSAGE_LIMITS,
  sendCatalogMessage,
  sendProductListMessage,
  sendProductMessage,
  type MetaSendResult,
} from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import type { CommerceNodeType } from '@/lib/flows/commerce-nodes';
export type { CommerceNodeType };

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Meta's limits on the text around catalogue messages. */
export const COMMERCE_MESSAGE_LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  ...PRODUCT_MESSAGE_LIMITS,
} as const;

export type CommerceSendRefusal =
  | 'invalid_message'
  | 'conversation_not_found'
  | 'contact_blocked'
  | 'no_address'
  | 'window_closed'
  | 'number_unavailable'
  | 'no_catalog'
  | 'product_not_found'
  | 'workspace_manual_blocked';

const REFUSAL_STATUS: Record<CommerceSendRefusal, number> = {
  invalid_message: 400,
  conversation_not_found: 404,
  contact_blocked: 409,
  no_address: 400,
  window_closed: 409,
  number_unavailable: 409,
  no_catalog: 409,
  product_not_found: 409,
  workspace_manual_blocked: 403,
};

/**
 * Why WhatsApp refused a product / catalogue message, as a Validation.commerceSend key. Meta codes
 * (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes): 131047 the customer's
 * 24-hour window closed; 131009, 131008 and 100 a product the catalogue cannot serve (not approved yet,
 * rejected, out of stock or not in the catalogue linked to this number); 131026 the recipient cannot get it.
 */
export function commerceRejectionKey(error: { code: number | null }): 'rejected_window' | 'rejected_product' | 'rejected_recipient' | 'rejected' {
  if (error.code === 131047) return 'rejected_window';
  if (error.code === 131009 || error.code === 131008 || error.code === 100) return 'rejected_product';
  if (error.code === 131026) return 'rejected_recipient';
  return 'rejected';
}

/** A refusal before anything was sent (message: Validation.commerceSend.<code>). */
export class CommerceSendError extends Error {
  readonly status: number;
  constructor(readonly code: CommerceSendRefusal) {
    super(getT('Validation.commerceSend')(code));
    this.name = 'CommerceSendError';
    this.status = REFUSAL_STATUS[code];
  }
}

/** A product by our row id (inbox) or by its catalogue content id (flows). */
export type ProductRef = { id: string } | { retailerId: string };

export type CommerceMessage =
  | { kind: 'product'; product: ProductRef; body?: string; footer?: string }
  | { kind: 'product_list'; header: string; body: string; footer?: string; sections: { title: string; products: ProductRef[] }[] }
  | { kind: 'catalog'; body: string; footer?: string; thumbnail?: ProductRef };

export type CommerceMessageKind = CommerceMessage['kind'];

const refKey = (ref: ProductRef): string => ('id' in ref ? `id:${ref.id}` : `rid:${ref.retailerId.trim()}`);

function validRef(ref: unknown): ref is ProductRef {
  if (!ref || typeof ref !== 'object') return false;
  const r = ref as Record<string, unknown>;
  if (typeof r.id === 'string') return UUID.test(r.id);
  return typeof r.retailerId === 'string' && r.retailerId.trim().length > 0 && r.retailerId.length <= 200;
}

const tooLong = (value: string | undefined, max: number) => (value?.length ?? 0) > max;

/** Checks the message shape and Meta's limits before anything is loaded or sent. */
export function commerceMessageRefusal(message: CommerceMessage): CommerceSendRefusal | null {
  if (!message || typeof message !== 'object') return 'invalid_message';
  if (tooLong(message.footer, COMMERCE_MESSAGE_LIMITS.footer)) return 'invalid_message';
  switch (message.kind) {
    case 'product':
      if (!validRef(message.product) || tooLong(message.body, COMMERCE_MESSAGE_LIMITS.body)) return 'invalid_message';
      return null;
    case 'product_list': {
      if (!message.header?.trim() || tooLong(message.header, COMMERCE_MESSAGE_LIMITS.header)) return 'invalid_message';
      if (!message.body?.trim() || tooLong(message.body, COMMERCE_MESSAGE_LIMITS.body)) return 'invalid_message';
      const sections = Array.isArray(message.sections) ? message.sections : [];
      if (sections.length < 1 || sections.length > COMMERCE_MESSAGE_LIMITS.maxSections) return 'invalid_message';
      let total = 0;
      const seen = new Set<string>();
      for (const section of sections) {
        const title = typeof section?.title === 'string' ? section.title.trim() : '';
        if ((sections.length > 1 && !title) || title.length > COMMERCE_MESSAGE_LIMITS.sectionTitleMaxLength) return 'invalid_message';
        const products = Array.isArray(section.products) ? section.products : [];
        if (!products.length || !products.every(validRef)) return 'invalid_message';
        for (const ref of products) {
          // Meta rejects a product listed twice in one message.
          if (seen.has(refKey(ref))) return 'invalid_message';
          seen.add(refKey(ref));
        }
        total += products.length;
      }
      return total > COMMERCE_MESSAGE_LIMITS.maxProducts ? 'invalid_message' : null;
    }
    case 'catalog':
      if (!message.body?.trim() || tooLong(message.body, COMMERCE_MESSAGE_LIMITS.body)) return 'invalid_message';
      if (message.thumbnail !== undefined && !validRef(message.thumbnail)) return 'invalid_message';
      return null;
    default:
      return 'invalid_message';
  }
}

/** Every product a message names, in order. */
export function messageProductRefs(message: CommerceMessage): ProductRef[] {
  if (message.kind === 'product') return [message.product];
  if (message.kind === 'catalog') return message.thumbnail ? [message.thumbnail] : [];
  return message.sections.flatMap((s) => s.products);
}

export interface CommerceConversationState {
  contact: { phone: string | null; wa_user_id: string | null; blocked_at: Date | string | null } | null;
  lastCustomerMessageAt: Date | string | null;
}

/**
 * Catalogue messages are interactive, so they need an open 24-hour window. A
 * blocked contact gets nothing; an opted-out contact may still be answered
 * inside the window (a service reply, not marketing).
 */
export function conversationRefusal(state: CommerceConversationState, now = Date.now()): CommerceSendRefusal | null {
  if (!state.contact) return 'conversation_not_found';
  if (state.contact.blocked_at) return 'contact_blocked';
  if (!resolveContactSendTarget(state.contact)) return 'no_address';
  const last = state.lastCustomerMessageAt ? new Date(state.lastCustomerMessageAt).getTime() : NaN;
  if (!Number.isFinite(last) || now - last >= SERVICE_WINDOW_MS) return 'window_closed';
  return null;
}

interface ResolvedProduct { id: string; retailer_id: string; name: string }

/** What the inbox shows for a sent catalogue message (the customer sees Meta's card). */
export function commerceMessageText(message: CommerceMessage, products: Map<string, ResolvedProduct>): string {
  const name = (ref: ProductRef) => products.get(refKey(ref))?.name ?? ('retailerId' in ref ? ref.retailerId : '');
  const lines: string[] = [];
  if (message.kind === 'product_list' && message.header.trim()) lines.push(message.header.trim());
  if (message.body?.trim()) lines.push(message.body.trim());
  if (message.kind === 'product') lines.push(`[${name(message.product)}]`);
  if (message.kind === 'product_list') lines.push(`[${message.sections.flatMap((s) => s.products).map(name).join(', ')}]`);
  if (message.footer?.trim()) lines.push(message.footer.trim());
  return lines.join('\n').slice(0, 4096);
}

export interface SendCommerceArgs {
  accountId: string;
  /** Agent sending from the inbox; omitted for the flow engine. */
  userId?: string;
  sender: 'agent' | 'bot';
  role: NonNullable<TenantContext['role']>;
  conversationId: string;
  message: CommerceMessage;
  /** Unique per send attempt; a replay with the same key never sends twice. */
  intentKey: string;
}

export interface SendCommerceResult {
  whatsappMessageId: string;
  messageId: string | null;
}

interface Prepared {
  target: { target: string; isPhone: boolean };
  phoneNumberId: string;
  accessTokenEnc: string;
  catalogId: string;
  products: Map<string, ResolvedProduct>;
}

async function prepare(tx: TenantTransaction, args: SendCommerceArgs): Promise<Prepared> {
  if (!UUID.test(args.conversationId)) throw new CommerceSendError('conversation_not_found');
  // A platform admin may block manual replies (abuse); a bot send is gated by suspension instead.
  if (args.sender === 'agent' && await manualRepliesBlockedIn(tx, args.accountId)) throw new CommerceSendError('workspace_manual_blocked');
  const conversations = await tx.$queryRaw<{ last_customer_message_at: Date | null; phone: string | null; wa_user_id: string | null;
    blocked_at: Date | null; whatsapp_config_id: string | null; channel: string }[]>`
    SELECT (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
        AND m.sender_type='customer') AS last_customer_message_at,
      ct.phone,ct.wa_user_id,ct.blocked_at,c.whatsapp_config_id::text AS whatsapp_config_id,c.channel
    FROM conversations c JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
    WHERE c.account_id=${args.accountId}::uuid AND c.id=${args.conversationId}::uuid AND ${conversationVisible('c')}`;
  const conversation = conversations[0] ?? null;
  // Catalogue messages are WhatsApp only: never from the default number on an Instagram conversation.
  if (conversation?.channel && conversation.channel !== 'whatsapp') throw new CommerceSendError('number_unavailable');
  const refusal = conversationRefusal({ contact: conversation, lastCustomerMessageAt: conversation?.last_customer_message_at ?? null });
  if (refusal) throw new CommerceSendError(refusal);
  const config = await getNumberConfig(tx, args.accountId, conversation!.whatsapp_config_id).catch((error: unknown) => {
    if (error instanceof NoNumberError) throw new CommerceSendError('number_unavailable');
    throw error;
  });
  if (isNumberDisconnected(config) || !config.phone_number_id || !config.access_token) throw new CommerceSendError('number_unavailable');
  const catalogs = await tx.$queryRaw<{ id: string; catalog_id: string }[]>`
    SELECT id::text AS id,catalog_id FROM whatsapp_catalogs
    WHERE account_id=${args.accountId}::uuid AND whatsapp_config_id=${config.id}::uuid
    ORDER BY created_at DESC LIMIT 1`;
  if (!catalogs[0]) throw new CommerceSendError('no_catalog');

  const refs = messageProductRefs(args.message);
  const ids = refs.flatMap((r) => ('id' in r ? [r.id] : []));
  const retailerIds = refs.flatMap((r) => ('retailerId' in r ? [r.retailerId.trim()] : []));
  const products = new Map<string, ResolvedProduct>();
  if (refs.length) {
    const rows = await tx.$queryRaw<ResolvedProduct[]>`
      SELECT id::text AS id,retailer_id,name FROM products
      WHERE account_id=${args.accountId}::uuid AND catalog_row_id=${catalogs[0].id}::uuid AND NOT is_hidden
        AND (id=ANY(${ids}::uuid[]) OR retailer_id=ANY(${retailerIds}::text[]))`;
    for (const row of rows) {
      products.set(`id:${row.id}`, row);
      products.set(`rid:${row.retailer_id}`, row);
    }
    if (!refs.every((ref) => products.has(refKey(ref)))) throw new CommerceSendError('product_not_found');
  }
  return {
    target: resolveContactSendTarget(conversation!)!,
    phoneNumberId: config.phone_number_id,
    accessTokenEnc: config.access_token,
    catalogId: catalogs[0].catalog_id,
    products,
  };
}

function retailerIdOf(prepared: Prepared, ref: ProductRef): string {
  return prepared.products.get(refKey(ref))!.retailer_id;
}

function metaCall(prepared: Prepared, message: CommerceMessage, accessToken: string, to: string): Promise<MetaSendResult> {
  const base = { phoneNumberId: prepared.phoneNumberId, accessToken, to };
  const footerText = message.footer?.trim() || undefined;
  switch (message.kind) {
    case 'product':
      return sendProductMessage({ ...base, catalogId: prepared.catalogId, productRetailerId: retailerIdOf(prepared, message.product),
        bodyText: message.body?.trim() || undefined, footerText });
    case 'product_list':
      return sendProductListMessage({ ...base, catalogId: prepared.catalogId, headerText: message.header.trim(),
        bodyText: message.body.trim(), footerText,
        sections: message.sections.map((s) => ({ title: s.title.trim(), productRetailerIds: s.products.map((p) => retailerIdOf(prepared, p)) })) });
    case 'catalog':
      return sendCatalogMessage({ ...base, bodyText: message.body.trim(), footerText,
        thumbnailProductRetailerId: message.thumbnail ? retailerIdOf(prepared, message.thumbnail) : undefined });
  }
}

/**
 * Sends one catalogue message. Throws CommerceSendError for a refusal
 * (nothing sent), MetaApiError when Meta rejects it, and
 * UncertainDispatchError when the outcome is unknown and must be reconciled.
 */
export async function sendCommerceMessage(args: SendCommerceArgs): Promise<SendCommerceResult> {
  if (commerceMessageRefusal(args.message)) throw new CommerceSendError('invalid_message');
  const prisma: PrismaClient = args.sender === 'bot' ? getWorkerPrisma() : getPrisma();
  const context: TenantContext = { accountId: args.accountId, userId: args.userId, role: args.role };
  const prepared = await withTenant(context, (tx) => prepare(tx, args), prisma);

  const { whatsapp_message_id } = await dispatchOnce(args.accountId, args.intentKey, async () => {
    if (args.sender === 'bot') await assertBotRepliesEnabled(args.accountId, args.conversationId);
    const accessToken = decrypt(prepared.accessTokenEnc);
    const variants = prepared.target.isPhone ? phoneVariants(prepared.target.target) : [prepared.target.target];
    let lastError: unknown = null;
    for (const to of variants) {
      try {
        return { whatsapp_message_id: (await metaCall(prepared, args.message, accessToken, to)).messageId };
      } catch (error) {
        if (!isRecipientNotAllowedError(error instanceof Error ? error.message : String(error))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  });

  const text = commerceMessageText(args.message, prepared.products);
  const messageId = await withTenant(context, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,
        content_text,message_id,status)
      VALUES(${args.accountId}::uuid,${args.conversationId}::uuid,${args.sender},${agentSenderId(args.sender, args.userId)}::uuid,'interactive',${text},${whatsapp_message_id},'sent')
      ON CONFLICT(conversation_id,message_id) DO NOTHING RETURNING id::text AS id`;
    // An agent stepping in pauses the bot, as every inbox send does.
    await tx.$executeRaw`UPDATE conversations SET last_message_text=${text},last_message_at=NOW(),updated_at=NOW(),
        bot_paused=CASE WHEN ${args.sender}='agent' THEN true ELSE bot_paused END
      WHERE account_id=${args.accountId}::uuid AND id=${args.conversationId}::uuid`;
    return rows[0]?.id ?? null;
  }, prisma);
  return { whatsappMessageId: whatsapp_message_id, messageId };
}

// ---------------------------------------------------------------------------
// Inbox requests

const optText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const ids = (value: unknown): { id: string }[] => (Array.isArray(value) ? value : []).map((id) => ({ id: typeof id === 'string' ? id : '' }));

/**
 * The inbox request body (POST /api/whatsapp/send-product) as a CommerceMessage, products by
 * products.id. Null for an unknown kind; other shape errors surface as invalid_message.
 */
export function commerceMessageFromRequest(body: Record<string, unknown>): CommerceMessage | null {
  switch (body.kind) {
    case 'product':
      return { kind: 'product', product: { id: optText(body.product_id) ?? '' }, body: optText(body.body), footer: optText(body.footer) };
    case 'product_list':
      return {
        kind: 'product_list',
        header: optText(body.header) ?? '',
        body: optText(body.body) ?? '',
        footer: optText(body.footer),
        sections: (Array.isArray(body.sections) ? body.sections : []).slice(0, 11).map((s: unknown) => {
          const section = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
          return { title: optText(section.title) ?? '', products: ids(section.product_ids).slice(0, 31) };
        }),
      };
    case 'catalog': {
      const thumb = optText(body.thumbnail_product_id);
      return { kind: 'catalog', body: optText(body.body) ?? '', footer: optText(body.footer), thumbnail: thumb ? { id: thumb } : undefined };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Flow steps

export { COMMERCE_NODE_TYPES, isCommerceNodeType } from '@/lib/flows/commerce-nodes';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The message a flow step sends, from its stored config (see
 * SendProductNodeConfig and friends in lib/flows/types). `fill` interpolates
 * {{vars}} into the texts; product ids are used as written.
 */
export function commerceMessageFromNode(type: CommerceNodeType, config: Record<string, unknown>,
  fill: (text: string) => string = (text) => text): CommerceMessage {
  const footer = str(config.footer_text) ? fill(str(config.footer_text)) : undefined;
  if (type === 'send_product') {
    return { kind: 'product', product: { retailerId: str(config.product_retailer_id) },
      body: str(config.body_text) ? fill(str(config.body_text)) : undefined, footer };
  }
  if (type === 'send_catalog') {
    const thumb = str(config.thumbnail_product_retailer_id);
    return { kind: 'catalog', body: fill(str(config.body_text)), footer, thumbnail: thumb ? { retailerId: thumb } : undefined };
  }
  const sections = Array.isArray(config.sections) ? (config.sections as Array<Record<string, unknown>>) : [];
  return {
    kind: 'product_list',
    header: fill(str(config.header_text)),
    body: fill(str(config.body_text)),
    footer,
    sections: sections.map((s) => ({
      title: str(s?.title),
      products: (Array.isArray(s?.product_retailer_ids) ? s.product_retailer_ids : []).map((id) => ({ retailerId: str(id) })),
    })),
  };
}
