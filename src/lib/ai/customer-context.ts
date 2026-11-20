/**
 * What the AI auto-reply may know about the shop and this customer, read before the model call
 * (batch 5). A fixed, read-only provider: the caller passes a tenant transaction, the customer's
 * contact id and their latest message; the result is a short plain-text block (at most
 * CUSTOMER_CONTEXT_MAX_CHARS) that the prompt quotes as untrusted data (see buildAgentSystemPrompt).
 *
 * Sections, in order:
 *   - products: products the public shop shows (shop_product_live, a priced live variant, a published
 *     shop that is not "coming soon") whose name or category matches a word of the message, with the
 *     price in the store currency, in stock or not, and the public product link;
 *   - orders: this contact's own latest orders (reference, delivery and payment state in plain words,
 *     total, the buyer's tracking link, the courier and its status when known);
 *   - bookings: customerBookingContext (src/lib/appointments/ai-context.ts).
 *
 * Strictly the contact's own data: never another customer's, never staff notes, tags, costs, SKUs,
 * phone numbers or addresses. Every query filters on account_id and runs in the caller's tenant
 * transaction. A fixed number of queries whatever the message or the order count (no per-row queries).
 */
import type { TenantTransaction } from '@/lib/db/tenant';
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { appOrigin } from '@/lib/auth/csrf';
import { customerBookingContext } from '@/lib/appointments/ai-context';
import { formatMoney } from '@/lib/format/money';
import { orderTrackingPath, orderTrackingToken } from '@/lib/commerce/order-tracking-token';
import { likeContains } from '@/lib/commerce/shop-insights-rules';
import { PUBLIC_SHOP_PATH } from '@/lib/commerce/shop-templates';
import { fulfilmentState, orderRef, paymentState, type FulfilmentState, type PaymentState } from '@/lib/commerce/order-state';
import type { OrderStatus, RefundState } from '@/lib/commerce/order-format';

export const CUSTOMER_CONTEXT_MAX_CHARS = 1500;
const MAX_PRODUCTS = 3;
const MAX_ORDERS = 3;
const MAX_KEYWORDS = 6;
const NAME_CHARS = 80;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'have', 'has', 'any', 'are', 'can', 'what', 'when', 'where', 'which', 'how', 'much',
  'many', 'with', 'this', 'that', 'there', 'please', 'want', 'need', 'price', 'cost', 'stock', 'available', 'buy', 'order',
  'does', 'did', 'was', 'will', 'from', 'about', 'some', 'get', 'hello', 'thanks', 'thank', 'yes', 'not', 'but', 'its', 'also',
  'still', 'tell', 'show', 'send', 'more', 'all', 'our', 'mine', 'just', 'like', 'know', 'okay', 'hii', 'hey',
]);

/** Up to six distinct search words of a message: letters and digits, three characters or more, common words dropped. */
export function productKeywords(text: string): string[] {
  const words = text.normalize('NFKC').toLowerCase().slice(0, 500).match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w) && w.length <= 40))].slice(0, MAX_KEYWORDS);
}

/** One line of merchant text for the block: control characters and line breaks removed, clipped. */
const plain = (value: string | null | undefined, max = NAME_CHARS): string =>
  (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// The English wording of the screens' order labels (messages/en.json Sales.orders.ful / Sales.orders.pay),
// keyed by the shared order states in order-state.ts. The model replies in the customer's language.
const FULFILMENT_WORDS: Record<FulfilmentState, string> = {
  new: 'received', confirmed: 'confirmed', partlyShipped: 'partly shipped', shipped: 'shipped', delivered: 'delivered',
  cancelled: 'cancelled', expired: 'expired (not paid in time)', review: 'payment being checked',
};
const PAYMENT_WORDS: Record<PaymentState, string> = {
  paid: 'paid', pending: 'waiting for payment', refunded: 'refunded', partlyRefunded: 'partly refunded', cod: 'cash on delivery',
};

interface ShopRow { handle: string | null; currency: string | null }
interface ProductRow { id: string; name: string; min_minor: bigint; max_minor: bigint; in_stock: boolean }
interface OrderRow {
  id: string; external_id: string | null; status: OrderStatus; refund_state: RefundState | null; payment_method: string | null;
  paid_at: Date | null; currency: string; total_minor: bigint | null; courier_name: string | null; tracking_status: string | null;
}

async function productLines(tx: TenantTransaction, accountId: string, shop: ShopRow, text: string): Promise<string[]> {
  const words = productKeywords(text);
  if (!shop.handle || !words.length) return [];
  const patterns = words.map(likeContains);
  // The shop's own read rules (as in shop-search.ts): live products with a priced, unarchived variant. Ranked by how
  // many words match the name or category; only the top few products' variants are read.
  const rows = await tx.$queryRaw<ProductRow[]>`
    SELECT m.id::text AS id, m.name, min(v.price_minor) AS min_minor, max(v.price_minor) AS max_minor,
      bool_or(COALESCE(shop_variant_availability(v.account_id, v.id), 1) > 0) AS in_stock
    FROM (
      SELECT p.id, p.name, (SELECT count(*) FROM unnest(${patterns}::text[]) AS w(pattern)
          WHERE p.name ILIKE w.pattern ESCAPE '\\' OR COALESCE(c.name, '') ILIKE w.pattern ESCAPE '\\') AS score
      FROM shop_products p
      LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
      WHERE p.account_id=${accountId}::uuid AND shop_product_live(p.status, p.publish_at, p.hide_at)
        AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)
        AND EXISTS (SELECT 1 FROM unnest(${patterns}::text[]) AS w(pattern)
          WHERE p.name ILIKE w.pattern ESCAPE '\\' OR COALESCE(c.name, '') ILIKE w.pattern ESCAPE '\\')
      ORDER BY score DESC, p.name, p.id
      LIMIT ${MAX_PRODUCTS}
    ) m
    JOIN shop_variants v ON v.account_id=${accountId}::uuid AND v.product_id=m.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
    GROUP BY m.id, m.name, m.score
    ORDER BY m.score DESC, m.name, m.id`;
  const origin = appOrigin();
  return rows.map((p) => {
    const low = shop.currency ? formatMoney(p.min_minor, shop.currency) : '';
    const price = !low ? 'price on request' : p.min_minor === p.max_minor ? low : `from ${low}`;
    return `- ${plain(p.name)}: ${price}, ${p.in_stock ? 'in stock' : 'out of stock'}, ${origin}${PUBLIC_SHOP_PATH}${shop.handle}/p/${p.id}`;
  });
}

async function orderLines(tx: TenantTransaction, accountId: string, contactId: string, handle: string | null): Promise<string[]> {
  // The newest live parcel per order in the same query (split shipments: the newest one's courier is shown).
  const rows = await tx.$queryRaw<OrderRow[]>`
    SELECT o.id::text AS id, o.external_id, o.status, o.refund_state, o.payment_method, o.paid_at, o.currency, o.total_minor,
      s.courier_name, s.tracking_status
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT courier_name, tracking_status FROM order_shipments
      WHERE account_id=o.account_id AND order_id=o.id AND create_state NOT IN ('failed','cancelled')
      ORDER BY created_at DESC LIMIT 1
    ) s ON true
    WHERE o.account_id=${accountId}::uuid AND o.contact_id=${contactId}::uuid
    ORDER BY o.created_at DESC, o.id
    LIMIT ${MAX_ORDERS}`;
  const origin = appOrigin();
  return rows.map((o) => {
    const reference = plain(orderRef(o), 41);
    const parts = [`- Order ${reference}: ${FULFILMENT_WORDS[fulfilmentState(o.status)]}, ${PAYMENT_WORDS[paymentState(o)]}`,
      `total ${formatMoney(o.total_minor, o.currency) || 'to be confirmed'}`];
    if (o.courier_name || o.tracking_status) {
      parts.push(`courier ${[plain(o.courier_name, 60), o.tracking_status ? plain(o.tracking_status.replace(/_/g, ' '), 40) : ''].filter(Boolean).join(', ')}`);
    }
    if (handle) parts.push(`tracking ${origin}${orderTrackingPath(handle, orderTrackingToken(accountId, o.id))}`);
    return parts.join(', ');
  });
}

/**
 * The customer-context block for one auto-reply, or null when there is nothing to say.
 * Read-only; the caller runs it inside withTenant for the workspace.
 */
export async function buildCustomerContext(tx: TenantTransaction, accountId: string, contactId: string, latestText: string): Promise<string | null> {
  // The shop a customer can reach: published and not "coming soon" (a password shop still sells over WhatsApp,
  // as visitorMayEnterTx 'inbound' allows), with the store currency.
  const [shop] = await tx.$queryRaw<ShopRow[]>`
    SELECT (SELECT handle FROM shop_storefronts WHERE account_id=${accountId}::uuid AND published AND access_mode <> 'coming_soon') AS handle,
      (SELECT currency FROM commerce_settings WHERE account_id=${accountId}::uuid) AS currency`;
  const shopRow: ShopRow = shop ?? { handle: null, currency: null };
  const sections: Array<[string, string[]]> = [
    ['Products matching the customer\'s message (price, stock, link):', await productLines(tx, accountId, shopRow, latestText)],
    ['This customer\'s latest orders (newest first):', await orderLines(tx, accountId, contactId, shopRow.handle)],
  ];
  const booking = (await customerBookingContext(tx, accountId, contactId) ?? '').split('\n').map((line) => plain(line, 300)).filter(Boolean);
  sections.push(['This customer\'s bookings:', booking]);
  return clampSections(sections);
}

/** Whole lines only, within the cap: a section's heading is kept only with at least one of its lines. */
export function clampSections(sections: Array<[string, string[]]>, max = CUSTOMER_CONTEXT_MAX_CHARS): string | null {
  const out: string[] = [];
  let used = 0;
  for (const [heading, lines] of sections) {
    let headed = false;
    for (const line of lines) {
      const cost = (out.length ? 1 : 0) + line.length + (headed ? 0 : heading.length + 1);
      if (used + cost > max) break;
      if (!headed) { out.push(heading); headed = true; }
      out.push(line);
      used += cost;
    }
  }
  return out.length ? out.join('\n') : null;
}

/**
 * The auto-reply's entry point: the block for this customer, read as the worker in the workspace's
 * tenant, or null. Best-effort: a failed read never costs the reply (and nothing of the message is logged).
 */
export async function loadCustomerContext(accountId: string, contactId: string, latestText: string): Promise<string | null> {
  try {
    return await withTenant({ accountId, role: 'owner' },
      (tx) => buildCustomerContext(tx, accountId, contactId, latestText), getWorkerPrisma())
  } catch (error) {
    console.warn('[ai customer-context] unavailable', { error: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}
