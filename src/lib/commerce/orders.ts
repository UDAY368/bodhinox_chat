/**
 * Orders service. Browser routes call the list/detail/update/settings
 * functions with the caller's live session (withTenant, app role, so RLS
 * applies: agents and above read orders, admins change settings). The inbound
 * pipeline calls recordWhatsAppOrder inside its own worker transaction, so the
 * order commits with the message that carried it.
 */

import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/auth/account';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { isVariableMap } from './event-rules';
import { minorFromDb } from './money';
import { classifyMaskedPhoneSearch, loadPhoneMask } from '@/lib/inbox/masking-apply';
import { transitionOrder } from './order-lifecycle';
import {
  canTransition,
  isOrderSource,
  isOrderStatus,
  ORDER_LIMITS,
  type InboundOrder,
  type OrderSource,
  type OrderStatus,
  type RefundState,
} from './order-format';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OrderErrorCode = 'invalid' | 'not_found' | 'bad_transition' | 'conflict' | 'shipment_live';
export class OrderError extends Error {
  constructor(readonly status: number, readonly code: OrderErrorCode, message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

export function orderErrorResponse(error: unknown): NextResponse {
  if (error instanceof OrderError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  return toErrorResponse(error);
}

// ---------------------------------------------------------------------------
// Inbound (worker)

/** Names of the cart's products from the synced catalogue, keyed by retailer id. */
async function productNames(tx: TenantTransaction, accountId: string, catalogId: string | null, retailerIds: string[]) {
  if (!retailerIds.length) return new Map<string, string>();
  const rows = await tx.$queryRaw<{ retailer_id: string; name: string }[]>`
    SELECT p.retailer_id, p.name FROM products p JOIN whatsapp_catalogs c
      ON c.account_id=p.account_id AND c.id=p.catalog_row_id
    WHERE p.account_id=${accountId}::uuid AND p.retailer_id = ANY(${retailerIds}::text[])
      AND (${catalogId}::text IS NULL OR c.catalog_id=${catalogId})`;
  return new Map(rows.map((r) => [r.retailer_id, r.name]));
}

/** The cart with product names filled in from the catalogue (unknown products keep a null name). */
export async function withProductNames(tx: TenantTransaction, accountId: string, order: InboundOrder): Promise<InboundOrder> {
  const names = await productNames(tx, accountId, order.catalog_id, [...new Set(order.items.map((i) => i.retailer_id))]);
  return { ...order, items: order.items.map((i) => ({ ...i, name: names.get(i.retailer_id)?.slice(0, 500) ?? null })) };
}

/**
 * Store a WhatsApp cart once per inbound message id (UNIQUE(account_id,
 * message_id)). `tx` must be the worker transaction that inserts the message.
 * Returns false when the order already exists (a redelivered webhook).
 *
 * The cart's Meta prices are only what the customer saw: when store checkout
 * is enabled, the same transaction queues commerce.prepare_whatsapp_order,
 * which reprices the lines from the Bodhinox catalogue and sends a checkout
 * link (design E2, E6). Without checkout the order stays unpriced (legacy).
 */
export async function recordWhatsAppOrder(tx: TenantTransaction, input: {
  accountId: string; orderId: string; metaMessageId: string; contactId: string; conversationId: string;
  whatsappConfigId: string | null; order: InboundOrder;
}): Promise<boolean> {
  const { order } = input;
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO orders(id,account_id,source,message_id,contact_id,conversation_id,whatsapp_config_id,catalog_id,
      currency,subtotal_minor,total_minor,customer_note)
    VALUES(${input.orderId}::uuid,${input.accountId}::uuid,'whatsapp',${input.metaMessageId},${input.contactId}::uuid,
      ${input.conversationId}::uuid,${input.whatsappConfigId}::uuid,${order.catalog_id},${order.currency},
      ${order.subtotal_minor},${order.subtotal_minor},${order.note})
    ON CONFLICT (account_id,message_id) DO NOTHING RETURNING id`;
  if (!inserted.length) return false;
  for (const item of order.items) {
    await tx.$executeRaw`INSERT INTO order_items(account_id,order_id,retailer_id,name,quantity,unit_price_minor,currency)
      VALUES(${input.accountId}::uuid,${input.orderId}::uuid,${item.retailer_id},${item.name},${item.quantity},
        ${item.unit_price_minor},${order.currency})`;
  }
  const [settings] = await tx.$queryRaw<{ checkout_enabled: boolean }[]>`
    SELECT checkout_enabled FROM commerce_settings WHERE account_id=${input.accountId}::uuid`;
  if (settings?.checkout_enabled) {
    await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
      VALUES('commerce.prepare_whatsapp_order',${input.accountId}::uuid,${JSON.stringify({ orderId: input.orderId })}::jsonb,
        ${`prep:${input.orderId}`})
      ON CONFLICT(dedupe_key) DO NOTHING`;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Browser API (app role, caller's session)

export interface OrderListItem {
  id: string;
  source: OrderSource;
  external_id: string | null;
  status: OrderStatus;
  currency: string;
  subtotal_minor: number;
  total_minor: number | null;
  /** 'cod': cash on delivery (the cash is recorded with Record offline payment). */
  payment_method: 'online' | 'cod';
  item_count: number;
  contact: { id: string; name: string | null; phone: string | null } | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderDetail extends OrderListItem {
  catalog_id: string | null;
  whatsapp_config_id: string | null;
  note: string | null;
  customer_note: string | null;
  /** Server-priced (Phase 8): the money columns and line snapshots are frozen once set. */
  priced_at: string | null;
  discount_minor: number;
  shipping_minor: number;
  /** The cash-on-delivery fee inside the total (its tax is inside tax_minor). */
  cod_fee_minor: number;
  tax_minor: number;
  tax_inclusive: boolean | null;
  coupon_code: string | null;
  shipping_address: Record<string, unknown> | null;
  reservation_expires_at: string | null;
  paid_at: string | null;
  amount_paid_minor: number;
  amount_refunded_minor: number;
  refund_state: RefundState;
  dispatched_at: string | null;
  delivered_at: string | null;
  tracking_note: string | null;
  feedback_score: number | null;
  items: Array<{
    id: string; retailer_id: string | null; name: string | null; quantity: number; unit_price_minor: number; currency: string;
    variant_id: string | null; sku: string | null; hsn_code: string | null;
    /** The price the customer's WhatsApp cart showed, kept for reference only. */
    submitted_unit_price_minor: number | null;
    tax_rate_bps: number | null; tax_minor: number | null; discount_minor: number | null; line_total_minor: number | null;
  }>;
}

export interface OrderFilters {
  status?: OrderStatus;
  source?: OrderSource;
  contactId?: string;
  conversationId?: string;
  /** Matches the contact's name or phone, or the store's order number. */
  q?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  /** Opaque cursor from a previous page's next_cursor. */
  cursor?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

function dateParam(value: string | null, field: string): Date | undefined {
  if (!value) return undefined;
  const date = ISO_DATE.test(value) ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(date.getTime())) throw new OrderError(400, 'invalid', `Invalid ${field}`);
  return date;
}

/** Validate list query parameters; unknown values are a 400, never silently ignored. */
export function parseOrderFilters(params: URLSearchParams): OrderFilters {
  const status = params.get('status');
  const source = params.get('source');
  const contactId = params.get('contact_id');
  const conversationId = params.get('conversation_id');
  const limit = params.get('limit');
  if (status && !isOrderStatus(status)) throw new OrderError(400, 'invalid', 'Invalid status');
  if (source && !isOrderSource(source)) throw new OrderError(400, 'invalid', 'Invalid source');
  if (contactId && !UUID.test(contactId)) throw new OrderError(400, 'invalid', 'Invalid contact_id');
  if (conversationId && !UUID.test(conversationId)) throw new OrderError(400, 'invalid', 'Invalid conversation_id');
  if (limit && !/^\d{1,3}$/.test(limit)) throw new OrderError(400, 'invalid', 'Invalid limit');
  const q = params.get('q')?.trim().slice(0, 100) || undefined;
  return {
    ...(status ? { status: status as OrderStatus } : {}),
    ...(source ? { source: source as OrderSource } : {}),
    ...(contactId ? { contactId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(q ? { q } : {}),
    from: dateParam(params.get('from'), 'from'),
    to: dateParam(params.get('to'), 'to'),
    ...(limit ? { limit: Math.min(Math.max(Number(limit), 1), 100) } : {}),
    ...(params.get('cursor') ? { cursor: params.get('cursor')! } : {}),
  };
}

/**
 * Cursor: the last row's created_at in whole microseconds since the epoch
 * (timestamptz's full precision; a JS Date keeps only milliseconds, which
 * skipped rows created in the same millisecond) and its id.
 */
function decodeCursor(cursor: string): { micros: bigint; id: string } {
  const [stamp, id] = cursor.split('_');
  if (!/^\d{1,17}$/.test(stamp ?? '') || !UUID.test(id ?? '')) throw new OrderError(400, 'invalid', 'Invalid cursor');
  return { micros: BigInt(stamp), id };
}

/** created_at as exact epoch microseconds, whatever extract() returns on this server version. */
const EPOCH_MICROS = Prisma.sql`(extract(epoch from date_trunc('second', created_at))::bigint * 1000000
  + extract(microseconds from created_at)::bigint % 1000000)`;

const listSelect = {
  id: true, source: true, external_id: true, status: true, currency: true, subtotal_minor: true, total_minor: true,
  contact_id: true, conversation_id: true, created_at: true, updated_at: true, payment_method: true,
} as const;
type ListRow = Prisma.ordersGetPayload<{ select: typeof listSelect }>;

async function decorate(tx: TenantTransaction, accountId: string, rows: ListRow[]): Promise<OrderListItem[]> {
  const ids = rows.map((r) => r.id);
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((v): v is string => Boolean(v)))];
  const [counts, contacts] = await Promise.all([
    ids.length ? tx.order_items.groupBy({ by: ['order_id'], where: { account_id: accountId, order_id: { in: ids } }, _sum: { quantity: true } }) : [],
    contactIds.length ? tx.contacts.findMany({ where: { account_id: accountId, id: { in: contactIds } }, select: { id: true, name: true, phone: true } }) : [],
  ]);
  const countOf = new Map(counts.map((c) => [c.order_id, c._sum.quantity ?? 0]));
  const contactOf = new Map(contacts.map((c) => [c.id, c]));
  return rows.map((r) => {
    const contact = r.contact_id ? contactOf.get(r.contact_id) : undefined;
    return {
      id: r.id, source: r.source as OrderSource, external_id: r.external_id, status: r.status as OrderStatus,
      currency: r.currency, subtotal_minor: minorFromDb(r.subtotal_minor)!, total_minor: minorFromDb(r.total_minor),
      payment_method: r.payment_method === 'cod' ? 'cod' : 'online', item_count: countOf.get(r.id) ?? 0,
      contact: contact ? { id: contact.id, name: contact.name ?? null, phone: contact.phone || null } : null,
      conversation_id: r.conversation_id, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
    };
  });
}

/** Newest first, keyset-paged. */
export async function listOrders(ctx: TenantContext, filters: OrderFilters = {}): Promise<{ orders: OrderListItem[]; next_cursor: string | null }> {
  const limit = filters.limit ?? 50;
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null;
  return withTenant(ctx, async (tx) => {
    const and: Prisma.ordersWhereInput[] = [{ account_id: ctx.accountId }];
    if (filters.status) and.push({ status: filters.status });
    if (filters.source) and.push({ source: filters.source });
    if (filters.contactId) and.push({ contact_id: filters.contactId });
    if (filters.conversationId) and.push({ conversation_id: filters.conversationId });
    if (filters.from) and.push({ created_at: { gte: filters.from } });
    if (filters.to) and.push({ created_at: { lte: filters.to } });
    if (filters.q) {
      // A member whose numbers are masked may search a number only by its last digits.
      const phoneSearch = /\d/.test(filters.q) && (await loadPhoneMask(tx, ctx)) ? classifyMaskedPhoneSearch(filters.q) : null;
      const phone: Prisma.contactsWhereInput[] = !phoneSearch || phoneSearch.kind === 'text'
        ? [{ phone: { contains: filters.q } }]
        : phoneSearch.kind === 'suffix' ? [{ phone: { endsWith: phoneSearch.digits } }] : [];
      const contacts = await tx.contacts.findMany({
        where: { account_id: ctx.accountId, OR: [{ name: { contains: filters.q, mode: 'insensitive' } }, ...phone] },
        select: { id: true }, take: 200,
      });
      and.push({ OR: [{ external_id: { contains: filters.q, mode: 'insensitive' } }, { contact_id: { in: contacts.map((c) => c.id) } }] });
    }
    if (cursor) {
      // (created_at, id) < cursor at full precision. Rows in an earlier
      // millisecond go through the indexed Prisma filter; the few in the
      // cursor's own millisecond are compared exactly in SQL.
      const msStart = new Date(Number(cursor.micros / BigInt(1000)));
      const sameMs = await tx.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM orders
        WHERE account_id=${ctx.accountId}::uuid AND created_at >= ${msStart} AND created_at < ${new Date(msStart.getTime() + 1)}
          AND (${EPOCH_MICROS} < ${cursor.micros} OR (${EPOCH_MICROS} = ${cursor.micros} AND id < ${cursor.id}::uuid))`;
      and.push({ OR: [{ created_at: { lt: msStart } }, { id: { in: sameMs.map((r) => r.id) } }] });
    }
    const rows = await tx.orders.findMany({ where: { AND: and }, select: listSelect, orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: limit + 1 });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    let nextCursor: string | null = null;
    if (rows.length > limit && last) {
      const [stamp] = await tx.$queryRaw<{ micros: string }[]>`
        SELECT ${EPOCH_MICROS}::text AS micros FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${last.id}::uuid`;
      nextCursor = `${stamp.micros}_${last.id}`;
    }
    return { orders: await decorate(tx, ctx.accountId, page), next_cursor: nextCursor };
  });
}

async function readOrder(tx: TenantTransaction, accountId: string, id: string): Promise<OrderDetail> {
  if (!UUID.test(id)) throw new OrderError(404, 'not_found', 'Order not found');
  const row = await tx.orders.findFirst({
    where: { account_id: accountId, id },
    select: {
      ...listSelect, catalog_id: true, whatsapp_config_id: true, note: true, customer_note: true,
      priced_at: true, discount_minor: true, shipping_minor: true, cod_fee_minor: true, tax_minor: true, tax_inclusive: true, coupon_code: true,
      shipping_address: true, reservation_expires_at: true, paid_at: true, amount_paid_minor: true, amount_refunded_minor: true,
      refund_state: true, dispatched_at: true, delivered_at: true, tracking_note: true, feedback_score: true,
    },
  });
  if (!row) throw new OrderError(404, 'not_found', 'Order not found');
  const [base] = await decorate(tx, accountId, [row]);
  const items = await tx.order_items.findMany({
    where: { account_id: accountId, order_id: id }, orderBy: { id: 'asc' },
    select: {
      id: true, retailer_id: true, name: true, quantity: true, unit_price_minor: true, currency: true, variant_id: true, sku: true,
      hsn_code: true, submitted_unit_price_minor: true, tax_rate_bps: true, tax_minor: true, discount_minor: true, line_total_minor: true,
    },
  });
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const address = row.shipping_address;
  return {
    ...base, catalog_id: row.catalog_id, whatsapp_config_id: row.whatsapp_config_id, note: row.note, customer_note: row.customer_note,
    priced_at: iso(row.priced_at), discount_minor: minorFromDb(row.discount_minor)!, shipping_minor: minorFromDb(row.shipping_minor)!,
    cod_fee_minor: minorFromDb(row.cod_fee_minor) ?? 0, tax_minor: minorFromDb(row.tax_minor)!, tax_inclusive: row.tax_inclusive, coupon_code: row.coupon_code,
    shipping_address: address && typeof address === 'object' && !Array.isArray(address) ? (address as Record<string, unknown>) : null,
    reservation_expires_at: iso(row.reservation_expires_at), paid_at: iso(row.paid_at),
    amount_paid_minor: minorFromDb(row.amount_paid_minor)!, amount_refunded_minor: minorFromDb(row.amount_refunded_minor)!,
    refund_state: row.refund_state as RefundState, dispatched_at: iso(row.dispatched_at), delivered_at: iso(row.delivered_at),
    tracking_note: row.tracking_note, feedback_score: row.feedback_score,
    items: items.map((i) => ({
      ...i, unit_price_minor: minorFromDb(i.unit_price_minor)!, submitted_unit_price_minor: minorFromDb(i.submitted_unit_price_minor),
      tax_minor: minorFromDb(i.tax_minor), discount_minor: minorFromDb(i.discount_minor), line_total_minor: minorFromDb(i.line_total_minor),
    })),
  };
}

export async function getOrder(ctx: TenantContext, id: string): Promise<OrderDetail> {
  return withTenant(ctx, (tx) => readOrder(tx, ctx.accountId, id));
}

export interface OrderPatch { status?: OrderStatus; note?: string | null }

export function parseOrderPatch(body: unknown): OrderPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OrderError(400, 'invalid', 'Invalid request body');
  const input = body as Record<string, unknown>;
  const unknown = Object.keys(input).filter((k) => k !== 'status' && k !== 'note');
  if (unknown.length) throw new OrderError(400, 'invalid', 'Only status and note can be changed');
  const patch: OrderPatch = {};
  if (input.status !== undefined) {
    if (!isOrderStatus(input.status)) throw new OrderError(400, 'invalid', 'Invalid status');
    patch.status = input.status;
  }
  if (input.note !== undefined) {
    if (input.note !== null && typeof input.note !== 'string') throw new OrderError(400, 'invalid', 'Invalid note');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (note.length > ORDER_LIMITS.noteMaxLength) throw new OrderError(400, 'invalid', 'Note is too long');
    patch.note = note || null;
  }
  if (patch.status === undefined && patch.note === undefined) throw new OrderError(400, 'invalid', 'Nothing to change');
  return patch;
}

/**
 * Change the internal note and/or the status. A status change goes only along
 * ORDER_TRANSITIONS (never to paid: payments settle through verified gateway
 * payments or "Record offline payment") and is carried out by
 * order-lifecycle.transitionOrder, which releases stock and cancels links as
 * needed; it is conditional on the status read, so two agents moving the same
 * order at once get one success and one 409. The Conversions API Purchase is
 * queued by settlement now, not here.
 */
export async function updateOrder(ctx: TenantContext, id: string, patch: OrderPatch): Promise<OrderDetail> {
  const current = await withTenant(ctx, (tx) => readOrder(tx, ctx.accountId, id));
  if (patch.status !== undefined && patch.status !== current.status) {
    if (!canTransition(current.status, patch.status, {
      priced: current.priced_at !== null, unpaidCod: current.payment_method === 'cod' && !current.paid_at && current.priced_at !== null,
    }))
      throw new OrderError(409, 'bad_transition', `An order cannot move from ${current.status} to ${patch.status}`);
    if (!ctx.userId) throw new OrderError(403, 'invalid', 'A signed-in member is required');
    await transitionOrder({ ...ctx, userId: ctx.userId }, id, { from: current.status, to: patch.status });
  }
  return withTenant(ctx, async (tx) => {
    if (patch.note !== undefined) {
      const { count } = await tx.orders.updateMany({ where: { account_id: ctx.accountId, id }, data: { note: patch.note } });
      if (count !== 1) throw new OrderError(404, 'not_found', 'Order not found');
    }
    return readOrder(tx, ctx.accountId, id);
  });
}

// ---------------------------------------------------------------------------
// Order confirmation settings

export type ConfirmationMode = 'off' | 'text' | 'template';
export interface OrderSettings {
  confirmation_mode: ConfirmationMode;
  confirmation_text: string | null;
  template_name: string | null;
  template_language: string | null;
  variable_map: Record<string, string>;
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = {
  confirmation_mode: 'off', confirmation_text: null, template_name: null, template_language: null, variable_map: {},
};

type SettingsRow = OrderSettings;
const settingsQuery = (tx: TenantTransaction, accountId: string) => tx.$queryRaw<SettingsRow[]>`
  SELECT confirmation_mode,confirmation_text,template_name,template_language,variable_map
  FROM order_settings WHERE account_id=${accountId}::uuid`;

function normaliseSettings(row: SettingsRow | undefined): OrderSettings {
  if (!row) return { ...DEFAULT_ORDER_SETTINGS };
  return { ...row, variable_map: isVariableMap(row.variable_map) ? row.variable_map : {} };
}

export async function getOrderSettings(ctx: TenantContext): Promise<OrderSettings> {
  return withTenant(ctx, async (tx) => normaliseSettings((await settingsQuery(tx, ctx.accountId))[0]));
}

/** Read through the worker role, for the inbound pipeline. */
export async function loadOrderSettingsForWorker(accountId: string): Promise<OrderSettings> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => normaliseSettings((await settingsQuery(tx, accountId))[0]), getWorkerPrisma());
}

const LANGUAGE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,4})?$/;

export function parseOrderSettings(body: unknown): OrderSettings {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OrderError(400, 'invalid', 'Invalid request body');
  const input = body as Record<string, unknown>;
  const mode = input.confirmation_mode;
  if (mode !== 'off' && mode !== 'text' && mode !== 'template') throw new OrderError(400, 'invalid', 'Invalid confirmation_mode');
  const text = typeof input.confirmation_text === 'string' ? input.confirmation_text.trim() : '';
  const name = typeof input.template_name === 'string' ? input.template_name.trim() : '';
  const language = typeof input.template_language === 'string' ? input.template_language.trim() : '';
  const variableMap = input.variable_map ?? {};
  if (text.length > 1024) throw new OrderError(400, 'invalid', 'Confirmation text is too long');
  if (mode === 'text' && !text) throw new OrderError(400, 'invalid', 'Confirmation text is required');
  if (mode === 'template' && (!name || name.length > 512 || !LANGUAGE.test(language)))
    throw new OrderError(400, 'invalid', 'A template and its language are required');
  if (!isVariableMap(variableMap)) throw new OrderError(400, 'invalid', 'Invalid variable_map');
  return {
    confirmation_mode: mode,
    confirmation_text: text || null,
    template_name: mode === 'template' ? name : null,
    template_language: mode === 'template' ? language : null,
    variable_map: mode === 'template' ? variableMap : {},
  };
}

/** Admins only (RLS enforces it too). */
export async function saveOrderSettings(ctx: TenantContext, settings: OrderSettings): Promise<OrderSettings> {
  return withTenant(ctx, async (tx) => {
    await tx.$executeRaw`INSERT INTO order_settings(account_id,confirmation_mode,confirmation_text,template_name,template_language,variable_map)
      VALUES(${ctx.accountId}::uuid,${settings.confirmation_mode},${settings.confirmation_text},${settings.template_name},
        ${settings.template_language},${JSON.stringify(settings.variable_map)}::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET confirmation_mode=EXCLUDED.confirmation_mode,
        confirmation_text=EXCLUDED.confirmation_text,template_name=EXCLUDED.template_name,
        template_language=EXCLUDED.template_language,variable_map=EXCLUDED.variable_map`;
    return normaliseSettings((await settingsQuery(tx, ctx.accountId))[0]);
  });
}
