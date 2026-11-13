/**
 * Manual orders (Sales → Orders → New order). A member picks a customer and
 * catalogue variants with quantities; the server prices every line from the
 * Bodhinox catalogue (shop_variants.price_minor, tax from the variant or the
 * store default) and never trusts a price, name or total from the browser.
 *
 * One transaction as the signed-in member on the worker connection (orders
 * are inserted by the worker role only; app.user_id is the member, so the
 * history and audit name them):
 * - the contact must be in this workspace; the order is tied to the
 *   contact's latest conversation (for the payment link and updates);
 * - the cart is priced with priceCart (no shipping, no coupon, online
 *   payment); a refusal is a 409 with its pricing code;
 * - tracked stock is reserved with no expiry (StockError out_of_stock ->
 *   409), committed when the payment settles, released when the order is
 *   cancelled (order-lifecycle closeOrderTx);
 * - the order is stored priced (money and lines frozen by the
 *   orders_priced_freeze triggers) in status confirmed, payment online;
 * - an order event (manual_created) and an audit row (ids and amounts only).
 *
 * The id is derived from (workspace, member, client_request_id), so a replayed
 * click returns the order it already made instead of a second one. Nothing is
 * sent to the customer here: the payment link goes through the payment links
 * API (its durable send path and the 24-hour window rule).
 */
import { requirePermission } from '@/lib/auth/permissions';
import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { orderEventTx } from '@/lib/payments/ledger';
import { likePattern } from './catalog';
import { minorFromDb } from './money';
import { asStaff, auditOrder, type StaffContext } from './order-lifecycle';
import { ORDER_LIMITS } from './order-format';
import { CART_LIMITS, normaliseCart, priceCart, type CartLine, type PricingRefusal } from './pricing';
import { reserveTx } from './stock';
import { loadVariants, seededUuid } from './storefront';
import { loadPricingSettings } from './store-settings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ManualOrderErrorCode = 'invalid' | 'contact_not_found' | 'store_not_configured' | PricingRefusal;
export class ManualOrderError extends Error {
  constructor(readonly code: ManualOrderErrorCode, readonly status: number, readonly variantId?: string) {
    super(code);
    this.name = 'ManualOrderError';
  }
}

export interface ManualOrderInput {
  contactId: string;
  lines: CartLine[];
  note: string | null;
  clientRequestId: string;
}

/** Validate the POST body: { contact_id, lines: [{ variant_id, qty }], note?, client_request_id }. Prices are never accepted. */
export function parseManualOrder(body: unknown): ManualOrderInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ManualOrderError('invalid', 400);
  const b = body as Record<string, unknown>;
  const allowed = new Set(['contact_id', 'lines', 'note', 'client_request_id']);
  if (Object.keys(b).some((k) => !allowed.has(k))) throw new ManualOrderError('invalid', 400);
  if (typeof b.contact_id !== 'string' || !UUID.test(b.contact_id)) throw new ManualOrderError('invalid', 400);
  if (typeof b.client_request_id !== 'string' || !UUID.test(b.client_request_id)) throw new ManualOrderError('invalid', 400);
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > CART_LIMITS.maxLines) throw new ManualOrderError('invalid', 400);
  const lines: CartLine[] = [];
  for (const raw of b.lines as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManualOrderError('invalid', 400);
    const line = raw as Record<string, unknown>;
    if (Object.keys(line).some((k) => k !== 'variant_id' && k !== 'qty')) throw new ManualOrderError('invalid', 400);
    if (typeof line.variant_id !== 'string' || !UUID.test(line.variant_id)) throw new ManualOrderError('invalid', 400);
    if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > CART_LIMITS.maxQty)
      throw new ManualOrderError('invalid', 400);
    lines.push({ variantId: line.variant_id.toLowerCase(), qty: line.qty });
  }
  const merged = normaliseCart(lines);
  if (!merged) throw new ManualOrderError('invalid', 400);
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string' || b.note.trim().length > ORDER_LIMITS.noteMaxLength) throw new ManualOrderError('invalid', 400);
    note = b.note.trim() || null;
  }
  return { contactId: b.contact_id.toLowerCase(), lines: merged, note, clientRequestId: b.client_request_id.toLowerCase() };
}

/** The order id for a member's click: the same request id always maps to the same order. */
export const manualOrderId = (accountId: string, userId: string, clientRequestId: string): string =>
  seededUuid(`manual-order:${accountId}:${userId}:${clientRequestId}`);

function assertAgent(ctx: StaffContext): void {
  if (!ctx.role || !hasMinRole(ctx.role, 'agent')) throw new ForbiddenError('Insufficient workspace role');
}

/** Create the order (see the module comment). Returns its id and whether this call made it (false for a replay). */
export async function createManualOrder(ctx: StaffContext, input: ManualOrderInput, now = new Date()): Promise<{ orderId: string; created: boolean }> {
  assertAgent(ctx);
  await requirePermission(ctx, 'commerce.checkout');
  const orderId = manualOrderId(ctx.accountId, ctx.userId, input.clientRequestId);
  return asStaff(ctx, async (tx) => {
    const existing = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM orders
      WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`;
    if (existing[0]) return { orderId, created: false };

    const contact = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM contacts
      WHERE account_id=${ctx.accountId}::uuid AND id=${input.contactId}::uuid`;
    if (!contact[0]) throw new ManualOrderError('contact_not_found', 404);
    const [conversation] = await tx.$queryRaw<{ id: string; whatsapp_config_id: string | null }[]>`
      SELECT id::text AS id, whatsapp_config_id::text AS whatsapp_config_id FROM conversations
      WHERE account_id=${ctx.accountId}::uuid AND contact_id=${input.contactId}::uuid
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT 1`;

    const settings = await loadPricingSettings(tx, ctx.accountId);
    if (!settings) throw new ManualOrderError('store_not_configured', 409);
    const variants = await loadVariants(tx, ctx.accountId, input.lines.map((l) => l.variantId));
    const priced = priceCart({ lines: input.lines, variants, settings, shippingRates: [], coupon: null, address: null, paymentMethod: 'online', now });
    if (!priced.ok) throw new ManualOrderError(priced.code, 409, priced.variantId);
    const quote = priced.quote;

    // ON CONFLICT: a double click racing this one waits for it, then finds the order already made.
    const inserted = await tx.$executeRaw`INSERT INTO orders(id,account_id,source,contact_id,conversation_id,whatsapp_config_id,currency,subtotal_minor,
        discount_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,status,priced_at,payment_method,cod_fee_minor,note)
      VALUES(${orderId}::uuid,${ctx.accountId}::uuid,'manual',${input.contactId}::uuid,${conversation?.id ?? null}::uuid,
        ${conversation?.whatsapp_config_id ?? null}::uuid,${quote.currency},${quote.subtotalMinor},${quote.discountMinor},
        ${quote.shippingMinor},${quote.taxMinor},${quote.taxInclusive},${quote.totalMinor},'confirmed',${now},'online',0,${input.note})
      ON CONFLICT (id) DO NOTHING`;
    if (inserted === 0) return { orderId, created: false };
    for (const line of quote.lines) {
      const options = Object.values(line.optionValues).filter(Boolean).join(' / ');
      const name = (options ? `${line.productName} (${options})` : line.productName).slice(0, 500);
      await tx.$executeRaw`INSERT INTO order_items(account_id,order_id,retailer_id,name,quantity,unit_price_minor,currency,variant_id,
          tax_rate_bps,tax_minor,discount_minor,line_total_minor,hsn_code,sku)
        VALUES(${ctx.accountId}::uuid,${orderId}::uuid,${line.sku},${name},${line.qty},${line.unitPriceMinor},${quote.currency},
          ${line.variantId}::uuid,${line.taxRateBps},${line.taxMinor},${line.discountMinor},${line.lineTotalMinor},${line.hsnCode},${line.sku})`;
    }
    // Held with no expiry: committed when the payment settles, released when the order is cancelled.
    await reserveTx(tx, ctx.accountId, orderId,
      quote.lines.filter((l) => l.trackInventory).map((l) => ({ variantId: l.variantId, quantity: l.qty })), null);
    await orderEventTx(tx, ctx.accountId, orderId, 'manual_created', { actorUserId: ctx.userId });
    await auditOrder(tx, ctx, 'order.manual_created', orderId, {
      lines: quote.lines.length, units: quote.lines.reduce((n, l) => n + l.qty, 0), total_minor: quote.totalMinor, currency: quote.currency,
    });
    return { orderId, created: true };
  });
}

export interface SellableVariant {
  id: string;
  product_id: string;
  /** Product name, with the option values when the variant has any. */
  name: string;
  sku: string;
  price_minor: number;
  /** null for a made-to-order (untracked) variant. */
  available: number | null;
}

/** Published, active, priced variants for the New order picker (agents and above), by product name or SKU. */
export async function listSellableVariants(ctx: TenantContext, q: string | null): Promise<{ variants: SellableVariant[]; currency: string | null }> {
  const pattern = q && q.trim() ? likePattern(q.trim().slice(0, 100)) : null;
  return withTenant(ctx, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; product_id: string; product_name: string; option_values: Record<string, string> | null;
      sku: string; price_minor: bigint; available: number | null }[]>`
      SELECT v.id::text AS id, p.id::text AS product_id, p.name AS product_name, v.option_values, v.sku, v.price_minor,
        CASE WHEN v.track_inventory THEN GREATEST(COALESCE(l.on_hand,0) - COALESCE(l.reserved,0), 0) END AS available
      FROM shop_variants v JOIN shop_products p ON p.account_id=v.account_id AND p.id=v.product_id
      LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
      WHERE v.account_id=${ctx.accountId}::uuid AND p.status='published' AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
        AND (${pattern}::text IS NULL OR p.name ILIKE ${pattern} OR v.sku ILIKE ${pattern})
      ORDER BY lower(p.name), v.position, v.sku
      LIMIT 100`;
    const [settings] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM commerce_settings WHERE account_id=${ctx.accountId}::uuid`;
    return {
      currency: settings?.currency ?? null,
      variants: rows.map((r) => {
        const options = Object.values(r.option_values ?? {}).filter(Boolean).join(' / ');
        return {
          id: r.id, product_id: r.product_id, name: options ? `${r.product_name} (${options})` : r.product_name, sku: r.sku,
          price_minor: minorFromDb(r.price_minor) ?? 0, available: r.available === null ? null : Number(r.available),
        };
      }),
    };
  });
}
