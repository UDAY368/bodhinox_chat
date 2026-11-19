/**
 * Quotes (store plan Phase 8). A quote is an ordinary shop session that staff pre-filled for one customer
 * and sent with the existing storefront link sender (sendStorefrontText: customer window, one send per
 * intent). The customer opens the link, may change the cart, and checks out through the normal shop flow,
 * where every price is worked out again on the server: a quote never locks a price. The link expires at the
 * session's expires_at (assertOpen refuses it after that, 410 session_expired), can be revoked with the
 * storefront-links API, and becomes the order's session once the customer places the order.
 */

import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { requirePermission } from '@/lib/auth/permissions';
import { parseCartLines, previewCartTx } from './public-shop';
import { assertStoreOpenTx, issueSessionTx, linkMessageText, OPEN_WINDOW_MS, seededUuid, sendStorefrontText, STAFF_LINK_MESSAGE_MAX, STOREFRONT_TTL } from './storefront';
import { isUuid, StoreError } from './store-settings';

export interface QuoteInput {
  contactId: string;
  lines: ReturnType<typeof parseCartLines>;
  note: string | null;
  expiresInHours: number;
  clientRequestId: string;
}

/** Validate the browser body: ids and quantities only (a price in the body is ignored, never read). */
export function parseQuoteInput(body: unknown): QuoteInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (!isUuid(b.contact_id) || !isUuid(b.client_request_id)) throw new StoreError('invalid');
  const hours = b.expires_in_hours === undefined ? STOREFRONT_TTL.defaultHours : b.expires_in_hours;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < STOREFRONT_TTL.minHours || hours > STOREFRONT_TTL.maxHours)
    throw new StoreError('invalid', { field: 'expires_in_hours' });
  const note = b.note === undefined || b.note === null ? null : typeof b.note === 'string' ? b.note.trim() : undefined;
  if (note === undefined || (note && note.length > STAFF_LINK_MESSAGE_MAX)) throw new StoreError('invalid', { field: 'note' });
  const raw = Array.isArray(b.lines) ? b.lines.map((l) => (l && typeof l === 'object'
    ? { variantId: (l as Record<string, unknown>).variant_id, qty: (l as Record<string, unknown>).qty } : null)) : null;
  return { contactId: b.contact_id, lines: parseCartLines(raw), note: note || null, expiresInHours: hours, clientRequestId: b.client_request_id };
}

export type QuoteState = 'open' | 'expired' | 'revoked' | 'ordered';

/** A quote's state from its session columns; a placed order outranks the rest. */
export function quoteState(row: { order_id: string | null; revoked_at: Date | null; expires_at: Date }, now = new Date()): QuoteState {
  if (row.order_id) return 'ordered';
  if (row.revoked_at) return 'revoked';
  return row.expires_at.getTime() <= now.getTime() ? 'expired' : 'open';
}

const worker = <T>(ctx: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(ctx, op, getWorkerPrisma());

/**
 * Issue the quote and send its link into the customer's WhatsApp chat. Permission commerce.checkout.
 * Replay-safe per (member, client request id): the same session and the same send intent. Every refusal
 * (nothing sent): contact_not_found, contact_blocked, outside_window, variant_unavailable, checkout_disabled, ...
 */
export async function createQuote(ctx: TenantContext & { userId: string }, input: QuoteInput): Promise<{ sessionId: string; expiresAt: string }> {
  await requirePermission(ctx, 'commerce.checkout');
  const sessionId = seededUuid(`storefront:quote:${ctx.accountId}:${ctx.userId}:${input.clientRequestId}`);
  const prepared = await worker({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, async (tx) => {
    const [contact] = await tx.$queryRaw<{ blocked_at: Date | null }[]>`
      SELECT blocked_at FROM contacts WHERE account_id=${ctx.accountId}::uuid AND id=${input.contactId}::uuid`;
    if (!contact) throw new StoreError('contact_not_found');
    if (contact.blocked_at) throw new StoreError('contact_blocked');
    // The customer window is checked here, before any session exists (the send checks it again).
    const [conversation] = await tx.$queryRaw<{ id: string; whatsapp_config_id: string | null; last_customer_at: Date | null }[]>`
      SELECT c.id::text AS id, c.whatsapp_config_id::text AS whatsapp_config_id,
        (SELECT max(m.created_at) FROM messages m WHERE m.account_id=c.account_id AND m.conversation_id=c.id AND m.sender_type='customer') AS last_customer_at
      FROM conversations c WHERE c.account_id=${ctx.accountId}::uuid AND c.contact_id=${input.contactId}::uuid AND c.channel='whatsapp'
      ORDER BY last_customer_at DESC NULLS LAST, c.created_at DESC LIMIT 1`;
    if (!conversation?.last_customer_at || Date.now() - conversation.last_customer_at.getTime() >= OPEN_WINDOW_MS) throw new StoreError('outside_window');
    await assertStoreOpenTx(tx, ctx.accountId, 'shop');
    const preview = await previewCartTx(tx, ctx.accountId, input.lines);
    if (preview.removed.length) throw new StoreError('variant_unavailable', { variantId: preview.removed[0] });
    const issued = await issueSessionTx(tx, ctx.accountId, {
      sessionId, contactId: input.contactId, conversationId: conversation.id, whatsappConfigId: conversation.whatsapp_config_id,
      purpose: 'shop', orderId: null, ttlHours: input.expiresInHours, createdBy: ctx.userId,
    });
    if (issued.created) {
      // Seeded without the abandoned-cart reminder: staff sent this link, the shop's automatic reminder is not theirs to trigger.
      await tx.$executeRaw`UPDATE storefront_sessions SET is_quote=true, quote_note=${input.note},
          cart=${JSON.stringify(input.lines.map((l) => ({ variant_id: l.variantId, qty: l.qty })))}::jsonb
        WHERE account_id=${ctx.accountId}::uuid AND id=${sessionId}::uuid AND cart='[]'::jsonb AND order_id IS NULL`;
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'commerce.quote_created',${sessionId},
          ${JSON.stringify({ contact_id: input.contactId, lines: input.lines.length })}::jsonb)`;
    }
    return { issued, conversationId: conversation.id };
  });
  await sendStorefrontText({
    accountId: ctx.accountId, contactId: input.contactId, conversationId: prepared.conversationId,
    text: linkMessageText(input.note, prepared.issued.url), intentKey: `storefront:${sessionId}:send`,
    sender: { kind: 'agent', userId: ctx.userId },
  });
  return { sessionId, expiresAt: prepared.issued.expiresAt };
}

export interface QuoteListItem {
  id: string;
  state: QuoteState;
  contact: { id: string; name: string | null } | null;
  item_count: number;
  note: string | null;
  expires_at: string;
  created_at: string;
}

/** The workspace's 50 newest quotes (agents and above). Names only: no phone numbers, no links. */
export async function listQuotes(ctx: TenantContext): Promise<QuoteListItem[]> {
  const rows = await worker(ctx, (tx) => tx.$queryRaw<{
    id: string; contact_id: string; contact_name: string | null; cart: unknown; quote_note: string | null; order_id: string | null;
    revoked_at: Date | null; expires_at: Date; created_at: Date }[]>`
    SELECT s.id::text AS id, s.contact_id::text AS contact_id, c.name AS contact_name, s.cart, s.quote_note, s.order_id::text AS order_id,
      s.revoked_at, s.expires_at, s.created_at
    FROM storefront_sessions s LEFT JOIN contacts c ON c.account_id=s.account_id AND c.id=s.contact_id
    WHERE s.account_id=${ctx.accountId}::uuid AND s.is_quote ORDER BY s.created_at DESC, s.id DESC LIMIT 50`);
  return rows.map((r) => ({
    id: r.id, state: quoteState(r), contact: { id: r.contact_id, name: r.contact_name }, item_count: Array.isArray(r.cart) ? r.cart.length : 0,
    note: r.quote_note, expires_at: r.expires_at.toISOString(), created_at: r.created_at.toISOString(),
  }));
}
