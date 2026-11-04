/**
 * Storefront sessions (design E12, E13). A storefront link is bound to one
 * existing contact; the token is derived (storefront-token.ts) and only its
 * sha256 is stored. Issuing a new shop link for a contact revokes the
 * previous live one. The page sees only what was entered in this session:
 * this session's cart, address and coupon, published products, and the one
 * order the session placed or is bound to. Never another order, never the
 * contact's profile, never a saved address.
 *
 * Every public mutation is version-checked (expectedVersion) and runs in the
 * worker role inside the session's tenant (the public routes resolve the
 * token first). Staff issue and revoke links through the worker too, after
 * requirePermission('commerce.checkout').
 *
 * Sending the link is an outbound intent (dispatchOnce): every refusal is
 * decided before the send (Phase 7 D14) and an ambiguous send is never
 * repeated. Logs carry ids and codes only, never the token or the URL.
 */
import { createHash } from 'node:crypto';
import { requirePermission } from '@/lib/auth/permissions';
import { requireFeature } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import { checkInstagramText, loadInstagramTarget, sendInstagramText, storeInstagramSentMessage, type InstagramSendContext, type InstagramTarget } from '@/lib/channels/sender';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { InstagramError } from '@/lib/instagram/errors';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { agentSenderId } from '@/lib/whatsapp/agent-attribution';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendTextMessage } from '@/lib/whatsapp/meta-api';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { isRecipientNotAllowedError, phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { findCouponTx, normaliseCouponCode, toPricingCoupon, type CouponRow } from './coupons';
import { minorFromDb } from './money';
import type { OrderStatus } from './order-format';
import { CART_LIMITS, normaliseCart, priceCart, type CartLine, type PricingResult, type PricingVariant, type Quote } from './pricing';
import { deriveStorefrontToken, storefrontTokenHash, storefrontUrl } from './storefront-token';
import { isUuid, loadPricingSettings, pricingRate, selectRates, StoreError } from './store-settings';

export type StorefrontPurpose = 'shop' | 'order' | 'status';
export const STOREFRONT_TTL = { minHours: 1, maxHours: 168, defaultHours: 24 } as const;
/** The customer window counts as open only below 23 h (Phase 7 D6). */
export const OPEN_WINDOW_MS = 23 * 3_600_000;

/** A UUID derived from a seed, so a replayed issue (same flow step, same request) finds the same session. */
export function seededUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface SessionRow {
  id: string;
  token_epoch: number;
  contact_id: string;
  conversation_id: string | null;
  whatsapp_config_id: string | null;
  purpose: StorefrontPurpose;
  expires_at: Date;
  revoked_at: Date | null;
  order_id: string | null;
  cart: unknown;
  address: unknown;
  coupon_code: string | null;
  version: number;
}

const SESSION_COLUMNS = `id::text AS id, token_epoch, contact_id::text AS contact_id, conversation_id::text AS conversation_id,
  whatsapp_config_id::text AS whatsapp_config_id, purpose, expires_at, revoked_at, order_id::text AS order_id, cart, address,
  coupon_code, version`;

export async function loadSession(tx: TenantTransaction, accountId: string, sessionId: string, lock = false): Promise<SessionRow | null> {
  const rows = await tx.$queryRawUnsafe<SessionRow[]>(
    `SELECT ${SESSION_COLUMNS} FROM storefront_sessions WHERE account_id=$1::uuid AND id=$2::uuid${lock ? ' FOR UPDATE' : ''}`,
    accountId, sessionId);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Issue and revoke

export interface IssuedSession {
  sessionId: string;
  url: string;
  expiresAt: string;
  purpose: StorefrontPurpose;
  orderId: string | null;
  /** False when a replay found the session issued earlier. */
  created: boolean;
}

export interface IssueInput {
  /** Fixed id (seededUuid) for a replay-safe issue; random otherwise. */
  sessionId: string;
  contactId: string;
  conversationId: string | null;
  whatsappConfigId: string | null;
  purpose: StorefrontPurpose;
  orderId: string | null;
  ttlHours: number;
  createdBy: string | null;
}

/**
 * Insert a session inside the caller's worker transaction. A shop link
 * revokes the contact's other live shop links. Replays (same id) return the
 * stored session unchanged.
 */
export async function issueSessionTx(tx: TenantTransaction, accountId: string, input: IssueInput): Promise<IssuedSession> {
  if (!Number.isInteger(input.ttlHours) || input.ttlHours < STOREFRONT_TTL.minHours || input.ttlHours > STOREFRONT_TTL.maxHours)
    throw new StoreError('invalid', { field: 'ttl_hours' });
  const token = deriveStorefrontToken(input.sessionId, 1);
  const inserted = await tx.$queryRaw<{ id: string; expires_at: Date }[]>`
    INSERT INTO storefront_sessions(id,account_id,token_hash,token_epoch,contact_id,conversation_id,whatsapp_config_id,purpose,
      expires_at,order_id,created_by)
    VALUES(${input.sessionId}::uuid,${accountId}::uuid,${storefrontTokenHash(token)},1,${input.contactId}::uuid,
      ${input.conversationId}::uuid,${input.whatsappConfigId}::uuid,${input.purpose},
      now() + make_interval(hours => ${input.ttlHours}),${input.orderId}::uuid,${input.createdBy}::uuid)
    ON CONFLICT (id) DO NOTHING RETURNING id::text AS id, expires_at`;
  if (!inserted[0]) {
    const existing = await loadSession(tx, accountId, input.sessionId);
    if (!existing || existing.contact_id !== input.contactId) throw new StoreError('conflict');
    return {
      sessionId: existing.id, url: storefrontUrl(deriveStorefrontToken(existing.id, existing.token_epoch)),
      expiresAt: existing.expires_at.toISOString(), purpose: existing.purpose, orderId: existing.order_id, created: false,
    };
  }
  if (input.purpose === 'shop')
    await tx.$executeRaw`UPDATE storefront_sessions SET revoked_at=now()
      WHERE account_id=${accountId}::uuid AND contact_id=${input.contactId}::uuid AND purpose='shop' AND revoked_at IS NULL
        AND order_id IS NULL AND id<>${input.sessionId}::uuid`;
  return {
    sessionId: input.sessionId, url: storefrontUrl(token), expiresAt: inserted[0].expires_at.toISOString(),
    purpose: input.purpose, orderId: input.orderId, created: true,
  };
}

/** The contact's most recent order (for a status link), or null. */
export async function latestOrderId(tx: TenantTransaction, accountId: string, contactId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM orders
    WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid ORDER BY created_at DESC LIMIT 1`;
  return rows[0]?.id ?? null;
}

const worker = <T>(ctx: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(ctx, op, getWorkerPrisma());

/** Store open for a new shop link: plan feature, not suspended, checkout configured and on. */
export async function assertStoreOpenTx(tx: TenantTransaction, accountId: string, purpose: StorefrontPurpose): Promise<void> {
  await requireFeature(tx, accountId, 'storefront');
  await requireSendingAllowed(tx, accountId);
  if (purpose === 'status') return;
  const settings = await loadPricingSettings(tx, accountId);
  if (!settings) throw new StoreError('store_not_configured');
  if (!settings.checkout_enabled) throw new StoreError('checkout_disabled');
}

export interface StaffLinkInput {
  conversationId: string;
  purpose: 'shop' | 'status';
  ttlHours: number;
  message: string | null;
  clientRequestId: string;
}

export const STAFF_LINK_MESSAGE_MAX = 900;

/** Validate the inbox dialog body. */
export function parseStaffLinkInput(body: unknown): StaffLinkInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (!isUuid(b.conversation_id) || !isUuid(b.client_request_id)) throw new StoreError('invalid');
  if (b.purpose !== 'shop' && b.purpose !== 'status') throw new StoreError('invalid', { field: 'purpose' });
  const ttl = b.ttl_hours === undefined || b.ttl_hours === null ? STOREFRONT_TTL.defaultHours : b.ttl_hours;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < STOREFRONT_TTL.minHours || ttl > STOREFRONT_TTL.maxHours)
    throw new StoreError('invalid', { field: 'ttl_hours' });
  const message = b.message === undefined || b.message === null ? null : typeof b.message === 'string' ? b.message.trim() : undefined;
  if (message === undefined || (message && message.length > STAFF_LINK_MESSAGE_MAX)) throw new StoreError('invalid', { field: 'message' });
  return { conversationId: b.conversation_id, purpose: b.purpose, ttlHours: ttl, message: message || null, clientRequestId: b.client_request_id };
}

/**
 * Inbox: issue a link for the conversation's contact and send it from the
 * conversation's number. Permission commerce.checkout. Replay-safe per
 * (member, client request id): the same session and the same send intent.
 */
export async function sendStaffStorefrontLink(ctx: TenantContext & { userId: string }, input: StaffLinkInput): Promise<{
  session: IssuedSession; whatsappMessageId: string;
}> {
  await requirePermission(ctx, 'commerce.checkout');
  const sessionId = seededUuid(`storefront:staff:${ctx.accountId}:${ctx.userId}:${input.clientRequestId}`);
  const session = await worker({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, async (tx) => {
    const [conversation] = await tx.$queryRaw<{ contact_id: string | null; whatsapp_config_id: string | null }[]>`
      SELECT contact_id::text AS contact_id, whatsapp_config_id::text AS whatsapp_config_id FROM conversations
      WHERE account_id=${ctx.accountId}::uuid AND id=${input.conversationId}::uuid`;
    if (!conversation?.contact_id) throw new StoreError('contact_not_found');
    await assertStoreOpenTx(tx, ctx.accountId, input.purpose);
    const orderId = input.purpose === 'status' ? await latestOrderId(tx, ctx.accountId, conversation.contact_id) : null;
    if (input.purpose === 'status' && !orderId) throw new StoreError('no_order');
    const issued = await issueSessionTx(tx, ctx.accountId, {
      sessionId, contactId: conversation.contact_id, conversationId: input.conversationId,
      whatsappConfigId: conversation.whatsapp_config_id, purpose: input.purpose, orderId, ttlHours: input.ttlHours, createdBy: ctx.userId,
    });
    if (issued.created)
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'commerce.storefront_link_issued',${issued.sessionId},
          ${JSON.stringify({ purpose: input.purpose, conversation_id: input.conversationId })}::jsonb)`;
    return { issued, contactId: conversation.contact_id };
  });
  const text = linkMessageText(input.message, session.issued.url);
  const sent = await sendStorefrontText({
    accountId: ctx.accountId, contactId: session.contactId, conversationId: input.conversationId, text,
    intentKey: `storefront:${session.issued.sessionId}:send`, sender: { kind: 'agent', userId: ctx.userId },
  });
  return { session: session.issued, whatsappMessageId: sent.whatsappMessageId };
}

/** Staff revoke. Permission commerce.checkout; audited. */
export async function revokeStorefrontSession(ctx: TenantContext & { userId: string }, sessionId: string): Promise<void> {
  if (!isUuid(sessionId)) throw new StoreError('not_found');
  await requirePermission(ctx, 'commerce.checkout');
  await worker({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, async (tx) => {
    const changed = await tx.$executeRaw`UPDATE storefront_sessions SET revoked_at=COALESCE(revoked_at, now())
      WHERE account_id=${ctx.accountId}::uuid AND id=${sessionId}::uuid`;
    if (!changed) throw new StoreError('not_found');
    await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'commerce.storefront_link_revoked',${sessionId},'{}'::jsonb)`;
  });
}

/** The WhatsApp text that carries a storefront link: the message, then the URL on its own line. */
export function linkMessageText(message: string | null | undefined, url: string): string {
  const body = (message ?? '').trim();
  return body ? `${body}\n${url}` : url;
}

// ---------------------------------------------------------------------------
// Sending

export interface StorefrontTextInput {
  accountId: string;
  contactId: string;
  /** The conversation to send in; null picks the contact's most recent one. */
  conversationId: string | null;
  text: string;
  /** dispatchOnce key: a replay never sends twice. */
  intentKey: string;
  /** A bot send stops while an agent has taken over, unless it is a service message the customer asked for. */
  sender: { kind: 'agent'; userId: string } | { kind: 'bot'; service?: boolean };
  now?: Date;
}

/** An Instagram refusal as the storefront's own fixed codes (decided before any intent). */
export function storeErrorFromInstagram(error: unknown): unknown {
  if (!(error instanceof InstagramError)) return error;
  if (error.code === 'instagram_window_closed') return new StoreError('outside_window');
  if (error.code === 'contact_blocked') return new StoreError('contact_blocked');
  if (error.code === 'invalid_request') return new StoreError('invalid', { field: 'text' });
  if (error.code === 'not_found') return new StoreError('contact_not_found');
  // Off, disconnected, token or permission problems: the channel cannot send now.
  return new StoreError('number_unavailable', { channel: 'instagram', reason: error.code });
}

/**
 * Send a text with a storefront link inside the customer's window. A WhatsApp
 * conversation sends from its number (24-hour window); an Instagram
 * conversation (Phase 11) sends through the Instagram sender, whose window
 * and account checks run before the intent. Without a conversation id only a
 * WhatsApp conversation is picked. Throws StoreError for every refusal
 * (nothing sent), MetaApiError when Meta rejects it and
 * UncertainDispatchError when the outcome is unknown.
 */
export async function sendStorefrontText(input: StorefrontTextInput): Promise<{ whatsappMessageId: string; conversationId: string }> {
  const now = input.now ?? new Date();
  const ctx = { accountId: input.accountId, role: 'owner' as const };
  const igContext: InstagramSendContext = { sender: 'automated', now };
  const prepared = await worker(ctx, async (tx) => {
    await requireSendingAllowed(tx, input.accountId);
    const [contact] = await tx.$queryRaw<{ phone: string | null; wa_user_id: string | null; blocked_at: Date | null }[]>`
      SELECT phone, wa_user_id, blocked_at FROM contacts WHERE account_id=${input.accountId}::uuid AND id=${input.contactId}::uuid`;
    if (!contact) throw new StoreError('contact_not_found');
    if (contact.blocked_at) throw new StoreError('contact_blocked');
    // A phone-less (Instagram-only) contact has no WhatsApp target; it may still have an Instagram conversation.
    const target = resolveContactSendTarget(contact);
    const [conversation] = await tx.$queryRaw<{ id: string; whatsapp_config_id: string | null; channel: string; bot_paused: boolean;
      last_customer_at: Date | null }[]>`
      SELECT c.id::text AS id, c.whatsapp_config_id::text AS whatsapp_config_id, c.channel, c.bot_paused,
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id
          AND m.sender_type='customer') AS last_customer_at
      FROM conversations c WHERE c.account_id=${input.accountId}::uuid AND c.contact_id=${input.contactId}::uuid
        AND ((${input.conversationId}::uuid IS NULL AND c.channel='whatsapp') OR c.id=${input.conversationId}::uuid)
      ORDER BY last_customer_at DESC NULLS LAST, c.created_at DESC LIMIT 1`;
    if (!conversation) throw new StoreError(target ? 'outside_window' : 'contact_not_found');
    if (conversation.channel === 'instagram') {
      // The window, account state and text limit are checked here, before any intent exists.
      let ig: InstagramTarget;
      try {
        ig = await loadInstagramTarget(tx, input.accountId, conversation.id);
        checkInstagramText(ig, input.text, igContext);
      } catch (error) {
        throw storeErrorFromInstagram(error);
      }
      if (input.sender.kind === 'bot' && !input.sender.service && conversation.bot_paused) throw new StoreError('send_failed', { reason: 'bot_paused' });
      return { channel: 'instagram' as const, conversationId: conversation.id, ig };
    }
    if (!target) throw new StoreError('contact_not_found');
    const last = conversation.last_customer_at ? new Date(conversation.last_customer_at).getTime() : NaN;
    if (!Number.isFinite(last) || now.getTime() - last >= OPEN_WINDOW_MS) throw new StoreError('outside_window');
    // A bot send respects an agent's takeover; an agent's own send does not.
    if (input.sender.kind === 'bot' && !input.sender.service && conversation.bot_paused) throw new StoreError('send_failed', { reason: 'bot_paused' });
    let config;
    try {
      assertWhatsAppConversation(conversation);
      config = await getNumberConfig(tx, input.accountId, conversation.whatsapp_config_id);
    } catch (error) {
      if (error instanceof NoNumberError) throw new StoreError('number_unavailable');
      throw error;
    }
    if (isNumberDisconnected(config) || !config.phone_number_id || !config.access_token) throw new StoreError('number_unavailable');
    return { channel: 'whatsapp' as const, conversationId: conversation.id, target, phoneNumberId: config.phone_number_id, accessTokenEnc: config.access_token };
  });

  const { messageId: whatsappMessageId } = await dispatchOnce(input.accountId, input.intentKey, async () => {
    // Instagram: the same checks with the same instant, then one Graph call. Never tagged (a link is not a composer reply).
    if (prepared.channel === 'instagram') return sendInstagramText(prepared.ig, input.text, igContext);
    const accessToken = decrypt(prepared.accessTokenEnc);
    const variants = prepared.target.isPhone ? phoneVariants(prepared.target.target) : [prepared.target.target];
    let lastError: unknown = null;
    for (const to of variants) {
      try {
        return await sendTextMessage({ phoneNumberId: prepared.phoneNumberId, accessToken, to, text: input.text });
      } catch (error) {
        if (!isRecipientNotAllowedError(error instanceof Error ? error.message : String(error))) throw error;
        lastError = error;
      }
    }
    throw lastError;
  });

  const agent = input.sender.kind === 'agent';
  const userId = input.sender.kind === 'agent' ? input.sender.userId : null;
  await worker(ctx, async (tx) => {
    // Instagram: the row replaces an is_echo row Meta may already have delivered for this mid.
    if (prepared.channel === 'instagram')
      await storeInstagramSentMessage(tx, { accountId: input.accountId, conversationId: prepared.conversationId,
        senderType: agent ? 'agent' : 'bot', senderId: agentSenderId(agent ? 'agent' : 'bot', userId), contentType: 'text',
        contentText: input.text, messageId: whatsappMessageId });
    else
      await tx.$executeRaw`INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,content_text,message_id,status)
        VALUES(${input.accountId}::uuid,${prepared.conversationId}::uuid,${agent ? 'agent' : 'bot'},${agentSenderId(agent ? 'agent' : 'bot', userId)}::uuid,
          'text',${input.text},${whatsappMessageId},'sent')
        ON CONFLICT(conversation_id,message_id) DO NOTHING`;
    // An agent stepping in pauses the bot, as every inbox send does.
    if (agent)
      await tx.$executeRaw`UPDATE conversations SET last_message_text=${input.text},last_message_at=NOW(),updated_at=NOW(),bot_paused=true
        WHERE account_id=${input.accountId}::uuid AND id=${prepared.conversationId}::uuid`;
    else
      await tx.$executeRaw`UPDATE conversations SET last_message_text=${input.text},last_message_at=NOW(),updated_at=NOW()
        WHERE account_id=${input.accountId}::uuid AND id=${prepared.conversationId}::uuid`;
  });
  return { whatsappMessageId, conversationId: prepared.conversationId };
}

// ---------------------------------------------------------------------------
// Session state (public, worker role inside the session's tenant)

export interface StorefrontAddress {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  state_code: string | null;
  postal_code: string;
  country: string;
  instructions: string | null;
}

const text = (value: unknown, max: number, required: boolean): string | null => {
  if (value === null || value === undefined || value === '') {
    if (required) throw new StoreError('invalid', { field: 'address' });
    return null;
  }
  if (typeof value !== 'string') throw new StoreError('invalid', { field: 'address' });
  const v = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if ((required && !v) || v.length > max) throw new StoreError('invalid', { field: 'address' });
  return v || null;
};

export function parseAddress(value: unknown): StorefrontAddress {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StoreError('invalid', { field: 'address' });
  const a = value as Record<string, unknown>;
  const phone = text(a.phone, 20, true)!.replace(/[\s()-]/g, '');
  if (!/^\+?[0-9]{6,15}$/.test(phone)) throw new StoreError('invalid', { field: 'phone' });
  const country = text(a.country, 2, true)!.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new StoreError('invalid', { field: 'country' });
  const postal = text(a.postal_code, 12, true)!.toUpperCase();
  if (!/^[0-9A-Z][0-9A-Z -]{1,10}$/.test(postal)) throw new StoreError('invalid', { field: 'postal_code' });
  const stateCode = text(a.state_code, 2, false)?.toUpperCase() ?? null;
  if (stateCode && !/^[0-9A-Z]{2}$/.test(stateCode)) throw new StoreError('invalid', { field: 'state_code' });
  return {
    name: text(a.name, 100, true)!, phone, line1: text(a.line1, 200, true)!, line2: text(a.line2, 200, false),
    city: text(a.city, 100, true)!, state: text(a.state, 100, false), state_code: stateCode, postal_code: postal, country,
    instructions: text(a.instructions, 300, false),
  };
}

const asAddress = (value: unknown): StorefrontAddress | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as StorefrontAddress : null;

/** The session's stored cart lines (shop purpose). */
export function sessionCart(session: Pick<SessionRow, 'cart'>): CartLine[] {
  if (!Array.isArray(session.cart)) return [];
  return session.cart.flatMap((l) => (l && typeof l === 'object' && isUuid((l as { variant_id?: unknown }).variant_id)
    && Number.isInteger((l as { qty?: unknown }).qty) ? [{ variantId: (l as { variant_id: string }).variant_id, qty: (l as { qty: number }).qty }] : []));
}

/** A session the customer can still change: live, and not yet placed. */
export function assertOpen(session: SessionRow, now = new Date()): void {
  if (session.revoked_at || session.expires_at.getTime() <= now.getTime()) throw new StoreError('session_expired');
}

interface OrderRow {
  id: string; source: string; status: OrderStatus; currency: string; priced_at: Date | null; contact_id: string | null;
  conversation_id: string | null; whatsapp_config_id: string | null; subtotal_minor: bigint; discount_minor: bigint;
  shipping_minor: bigint; tax_minor: bigint; total_minor: bigint | null; tax_inclusive: boolean | null; amount_paid_minor: bigint;
  reservation_expires_at: Date | null; paid_at: Date | null; checkout_attempt: number; created_at: Date;
}
const ORDER_COLUMNS = `id::text AS id, source, status, currency, priced_at, contact_id::text AS contact_id,
  conversation_id::text AS conversation_id, whatsapp_config_id::text AS whatsapp_config_id, subtotal_minor, discount_minor, shipping_minor,
  tax_minor, total_minor, tax_inclusive, amount_paid_minor, reservation_expires_at, paid_at, checkout_attempt, created_at`;

export async function loadOrder(tx: TenantTransaction, accountId: string, orderId: string, lock = false): Promise<OrderRow | null> {
  const rows = await tx.$queryRawUnsafe<OrderRow[]>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE account_id=$1::uuid AND id=$2::uuid${lock ? ' FOR UPDATE' : ''}`, accountId, orderId);
  return rows[0] ?? null;
}

/** True when the session's cart is fixed: a WhatsApp cart, a status link, or an order already placed. */
export const cartLocked = (session: Pick<SessionRow, 'purpose' | 'order_id'>): boolean => session.purpose !== 'shop' || session.order_id !== null;

/** The session's lines: the stored cart (shop) or the WhatsApp order's items matched by SKU (order). */
export async function sessionLines(tx: TenantTransaction, accountId: string, session: SessionRow): Promise<{ lines: CartLine[]; unmatched: boolean }> {
  if (session.purpose !== 'order' || !session.order_id) return { lines: sessionCart(session), unmatched: false };
  const items = await tx.$queryRaw<{ variant_id: string | null; quantity: number }[]>`
    SELECT v.id::text AS variant_id, i.quantity FROM order_items i
    LEFT JOIN shop_variants v ON v.account_id=i.account_id AND v.sku=COALESCE(i.sku, i.retailer_id)
    WHERE i.account_id=${accountId}::uuid AND i.order_id=${session.order_id}::uuid ORDER BY i.id`;
  return {
    lines: items.filter((i) => i.variant_id).map((i) => ({ variantId: i.variant_id!, qty: i.quantity })),
    unmatched: items.some((i) => !i.variant_id) || !items.length,
  };
}

interface VariantRow {
  id: string; product_id: string; product_name: string; sku: string; option_values: Record<string, string>; price_minor: bigint | null;
  compare_at_minor: bigint | null; tax_rate_bps: number | null; hsn_code: string | null; track_inventory: boolean; sellable: boolean;
  available: number | null;
}

/** Variants by id (any status; `sellable` says whether it can be bought now). */
export async function loadVariants(tx: TenantTransaction, accountId: string, ids: string[]): Promise<Map<string, PricingVariant & { available: number | null }>> {
  if (!ids.length) return new Map();
  const rows = await tx.$queryRaw<VariantRow[]>`
    SELECT v.id::text AS id, v.product_id::text AS product_id, p.name AS product_name, v.sku, v.option_values, v.price_minor,
      v.compare_at_minor, v.tax_rate_bps, v.hsn_code, v.track_inventory,
      (p.status='published' AND v.archived_at IS NULL) AS sellable,
      CASE WHEN v.track_inventory THEN COALESCE(l.on_hand - l.reserved, 0) END AS available
    FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
    LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    WHERE v.account_id=${accountId}::uuid AND v.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, {
    id: r.id, productId: r.product_id, productName: r.product_name, sku: r.sku, optionValues: r.option_values ?? {},
    priceMinor: minorFromDb(r.price_minor), taxRateBps: r.tax_rate_bps, hsnCode: r.hsn_code, trackInventory: r.track_inventory,
    sellable: r.sellable, available: r.available,
  }]));
}

export interface SessionQuote {
  result: PricingResult | { ok: false; code: 'store_not_configured' };
  coupon: CouponRow | null;
  lines: CartLine[];
}

/**
 * Price the session now. `lockCoupon` is the checkout's locked coupon row
 * (lock order); otherwise the coupon is read without a lock.
 */
export async function quoteSessionTx(tx: TenantTransaction, accountId: string, session: SessionRow, options: {
  lockedCoupon?: CouponRow | null; now?: Date;
} = {}): Promise<SessionQuote> {
  const settings = await loadPricingSettings(tx, accountId);
  const { lines, unmatched } = await sessionLines(tx, accountId, session);
  if (!settings) return { result: { ok: false, code: 'store_not_configured' }, coupon: null, lines };
  if (unmatched) return { result: { ok: false, code: 'price_not_configured' }, coupon: null, lines };
  const coupon = options.lockedCoupon !== undefined ? options.lockedCoupon
    : session.coupon_code ? await findCouponTx(tx, accountId, session.coupon_code) : null;
  const variants = await loadVariants(tx, accountId, lines.map((l) => l.variantId));
  const address = asAddress(session.address);
  const rates = address ? (await selectRates(tx, accountId, true)).map(pricingRate) : [];
  const result = priceCart({
    lines, variants, settings, shippingRates: rates,
    coupon: session.coupon_code ? (coupon ? toPricingCoupon(coupon) : 'missing') : null,
    address: address ? { country: address.country, postalCode: address.postal_code } : null, now: options.now,
  });
  return { result, coupon, lines };
}

async function bump(tx: TenantTransaction, accountId: string, sessionId: string, set: { cart?: CartLine[]; address?: StorefrontAddress | null; coupon?: string | null }) {
  if (set.cart !== undefined)
    await tx.$executeRaw`UPDATE storefront_sessions SET cart=${JSON.stringify(set.cart.map((l) => ({ variant_id: l.variantId, qty: l.qty })))}::jsonb,
      version=version+1 WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid`;
  if (set.address !== undefined)
    await tx.$executeRaw`UPDATE storefront_sessions SET address=${set.address ? JSON.stringify(set.address) : null}::jsonb,
      version=version+1 WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid`;
  if (set.coupon !== undefined)
    await tx.$executeRaw`UPDATE storefront_sessions SET coupon_code=${set.coupon}, version=version+1
      WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid`;
}

async function lockForChange(tx: TenantTransaction, accountId: string, sessionId: string, expectedVersion: number): Promise<SessionRow> {
  const session = await loadSession(tx, accountId, sessionId, true);
  if (!session) throw new StoreError('not_found');
  assertOpen(session);
  if (session.purpose === 'status') throw new StoreError('cart_locked');
  if (session.order_id) {
    const order = await loadOrder(tx, accountId, session.order_id);
    if (!order || order.priced_at) throw new StoreError('cart_locked');
  }
  if (session.version !== expectedVersion) throw new StoreError('conflict');
  return session;
}

/** Replace the cart (shop sessions only). Every variant must be on sale in this store. */
export async function updateCartTx(tx: TenantTransaction, accountId: string, sessionId: string, input: { expectedVersion: number; lines: unknown }): Promise<void> {
  const session = await lockForChange(tx, accountId, sessionId, input.expectedVersion);
  if (cartLocked(session)) throw new StoreError('cart_locked');
  if (!Array.isArray(input.lines) || input.lines.length > CART_LIMITS.maxLines) throw new StoreError('invalid_cart');
  const raw = input.lines.map((l) => ({
    variantId: l && typeof l === 'object' ? (l as Record<string, unknown>).variantId : null,
    qty: l && typeof l === 'object' ? (l as Record<string, unknown>).qty : null,
  }));
  if (raw.some((l) => !isUuid(l.variantId))) throw new StoreError('invalid_cart');
  const lines = normaliseCart(raw as CartLine[]);
  if (!lines) throw new StoreError('invalid_cart');
  const variants = await loadVariants(tx, accountId, lines.map((l) => l.variantId));
  for (const line of lines) {
    const v = variants.get(line.variantId);
    if (!v || !v.sellable || v.priceMinor === null) throw new StoreError('variant_unavailable', { variantId: line.variantId });
  }
  await bump(tx, accountId, sessionId, { cart: lines });
}

export async function setAddressTx(tx: TenantTransaction, accountId: string, sessionId: string, input: { expectedVersion: number; address: unknown }): Promise<void> {
  await lockForChange(tx, accountId, sessionId, input.expectedVersion);
  await bump(tx, accountId, sessionId, { address: input.address === null ? null : parseAddress(input.address) });
}

/** Apply (or with null remove) a coupon code. An unknown code is refused here; validity is checked by the quote. */
export async function applyCouponTx(tx: TenantTransaction, accountId: string, sessionId: string, input: { expectedVersion: number; code: unknown }): Promise<void> {
  await lockForChange(tx, accountId, sessionId, input.expectedVersion);
  if (input.code === null || input.code === '') {
    await bump(tx, accountId, sessionId, { coupon: null });
    return;
  }
  const code = normaliseCouponCode(input.code);
  if (!code || !(await findCouponTx(tx, accountId, code))) throw new StoreError('coupon_not_found');
  await bump(tx, accountId, sessionId, { coupon: code });
}

// ---------------------------------------------------------------------------
// View

export interface StorefrontProduct {
  id: string;
  name: string;
  description: string | null;
  disclosure: string | null;
  categoryName: string | null;
  images: string[];
  variants: Array<{ id: string; sku: string; options: Record<string, string>; priceMinor: number; compareAtMinor: number | null; inStock: boolean }>;
}

export interface StorefrontOrderView {
  reference: string;
  status: OrderStatus;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number | null;
  taxInclusive: boolean | null;
  amountPaidMinor: number;
  priced: boolean;
  lines: Array<{ name: string | null; sku: string | null; qty: number; unitPriceMinor: number; lineTotalMinor: number | null }>;
  /** A live payment link to open, when there is one. */
  paymentUrl: string | null;
  /** Awaiting payment while the link is being prepared. */
  paymentPending: boolean;
  reservationExpiresAt: string | null;
  paidAt: string | null;
  documentNumber: string | null;
}

export interface StorefrontView {
  store: { title: string | null; businessName: string; currency: string | null; pricesIncludeTax: boolean; checkoutEnabled: boolean };
  purpose: StorefrontPurpose;
  version: number;
  expiresAt: string;
  open: boolean;
  cartLocked: boolean;
  cart: CartLine[];
  address: StorefrontAddress | null;
  couponCode: string | null;
  products: StorefrontProduct[];
  quote: { ok: true; quote: Quote } | { ok: false; code: string } | null;
  order: StorefrontOrderView | null;
}

/** A short customer-facing reference for an order (no sequence, no count leak). */
export const orderReference = (orderId: string) => orderId.replace(/-/g, '').slice(0, 8).toUpperCase();

export async function loadOrderView(tx: TenantTransaction, accountId: string, orderId: string): Promise<StorefrontOrderView | null> {
  const order = await loadOrder(tx, accountId, orderId);
  if (!order) return null;
  const items = await tx.$queryRaw<{ name: string | null; sku: string | null; retailer_id: string | null; quantity: number;
    unit_price_minor: bigint; line_total_minor: bigint | null }[]>`
    SELECT name, sku, retailer_id, quantity, unit_price_minor, line_total_minor FROM order_items
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid ORDER BY id LIMIT 100`;
  const [link] = await tx.$queryRaw<{ short_url: string | null; status: string }[]>`
    SELECT short_url, status FROM payment_links WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid
      AND status IN ('creating','created','partially_paid','unknown') ORDER BY created_at DESC LIMIT 1`;
  const [doc] = await tx.$queryRaw<{ number: string }[]>`
    SELECT number FROM commerce_documents WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND kind='receipt'
    ORDER BY issued_at DESC LIMIT 1`;
  const awaiting = order.status === 'awaiting_payment';
  return {
    reference: orderReference(order.id), status: order.status, currency: order.currency,
    subtotalMinor: minorFromDb(order.subtotal_minor) ?? 0, discountMinor: minorFromDb(order.discount_minor) ?? 0,
    shippingMinor: minorFromDb(order.shipping_minor) ?? 0, taxMinor: minorFromDb(order.tax_minor) ?? 0,
    totalMinor: minorFromDb(order.total_minor), taxInclusive: order.tax_inclusive, amountPaidMinor: minorFromDb(order.amount_paid_minor) ?? 0,
    priced: order.priced_at !== null,
    lines: items.map((i) => ({ name: i.name, sku: i.sku ?? i.retailer_id, qty: i.quantity, unitPriceMinor: minorFromDb(i.unit_price_minor) ?? 0,
      lineTotalMinor: minorFromDb(i.line_total_minor) })),
    paymentUrl: awaiting && link?.short_url && (link.status === 'created' || link.status === 'partially_paid') ? link.short_url : null,
    paymentPending: awaiting && !(link?.short_url && (link.status === 'created' || link.status === 'partially_paid')),
    reservationExpiresAt: order.reservation_expires_at?.toISOString() ?? null, paidAt: order.paid_at?.toISOString() ?? null,
    documentNumber: doc?.number ?? null,
  };
}

/** Published products with sellable, priced variants (at most 200 products), images as ids only. */
export async function loadCatalogue(tx: TenantTransaction, accountId: string): Promise<StorefrontProduct[]> {
  const products = await tx.$queryRaw<{ id: string; name: string; description: string | null; disclosure: string | null; category: string | null }[]>`
    SELECT p.id::text AS id, p.name, p.description, p.disclosure, c.name AS category FROM shop_products p
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
    WHERE p.account_id=${accountId}::uuid AND p.status='published'
      AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)
    ORDER BY c.position NULLS LAST, p.name LIMIT 200`;
  if (!products.length) return [];
  const ids = products.map((p) => p.id);
  const variants = await tx.$queryRaw<{ id: string; product_id: string; sku: string; option_values: Record<string, string>; price_minor: bigint;
    compare_at_minor: bigint | null; in_stock: boolean }[]>`
    SELECT v.id::text AS id, v.product_id::text AS product_id, v.sku, v.option_values, v.price_minor, v.compare_at_minor,
      (NOT v.track_inventory OR COALESCE(l.on_hand - l.reserved, 0) > 0) AS in_stock
    FROM shop_variants v LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    WHERE v.account_id=${accountId}::uuid AND v.product_id = ANY(${ids}::uuid[]) AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
    ORDER BY v.position, v.sku`;
  const images = await tx.$queryRaw<{ id: string; product_id: string }[]>`
    SELECT id::text AS id, product_id::text AS product_id FROM shop_product_images
    WHERE account_id=${accountId}::uuid AND product_id = ANY(${ids}::uuid[]) ORDER BY position`;
  return products.map((p) => ({
    id: p.id, name: p.name, description: p.description, disclosure: p.disclosure, categoryName: p.category,
    images: images.filter((i) => i.product_id === p.id).map((i) => i.id),
    variants: variants.filter((v) => v.product_id === p.id).map((v) => ({
      id: v.id, sku: v.sku, options: v.option_values ?? {}, priceMinor: minorFromDb(v.price_minor) ?? 0,
      compareAtMinor: minorFromDb(v.compare_at_minor), inStock: v.in_stock,
    })),
  }));
}

export async function loadStorefrontView(tx: TenantTransaction, accountId: string, sessionId: string, now = new Date()): Promise<StorefrontView | null> {
  const session = await loadSession(tx, accountId, sessionId);
  if (!session || session.revoked_at) return null;
  const settings = await loadPricingSettings(tx, accountId);
  const [account] = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM accounts WHERE id=${accountId}::uuid`;
  const order = session.order_id ? await loadOrderView(tx, accountId, session.order_id) : null;
  const placed = !!order?.priced || session.purpose === 'status';
  const open = !placed && session.expires_at.getTime() > now.getTime();
  const showCatalogue = open && session.purpose === 'shop';
  const lines = placed ? [] : (await sessionLines(tx, accountId, session)).lines;
  return {
    store: {
      title: settings?.storefront_title ?? null, businessName: account?.name ?? '', currency: settings?.currency ?? null,
      pricesIncludeTax: settings?.prices_include_tax ?? true, checkoutEnabled: !!settings?.checkout_enabled,
    },
    purpose: session.purpose, version: session.version, expiresAt: session.expires_at.toISOString(), open,
    cartLocked: session.purpose !== 'shop' || placed,
    cart: lines, address: placed ? null : asAddress(session.address), couponCode: placed ? null : session.coupon_code,
    products: showCatalogue ? await loadCatalogue(tx, accountId) : [],
    quote: open && lines.length ? (await quoteSessionTx(tx, accountId, session, { now })).result : null,
    order,
  };
}
