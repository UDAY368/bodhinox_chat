// One contact's orders, payments and deals, for the chat side panel and the
// contact profile. Every query runs inside withTenant and is bounded: the
// panel gets the newest few of each with their counts from one statement; the
// profile pages payments by offset with a total.
//
// Orders and payments are agent-and-above (the same as their RLS policies);
// a viewer gets deals only, and orders/payments come back null so the UI hides
// those blocks instead of showing a misleading zero.
//
// A payment belongs to the contact through its order, its payment link or its
// appointment (customer_payments has no contact column).
import { Prisma } from '@prisma/client';

import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';

export const SUMMARY_LIMIT = 3;
export const PAYMENTS_PAGE_SIZE = 10;

export interface SummaryOrder {
  id: string;
  external_id: string | null;
  status: string;
  currency: string;
  total_minor: number;
  created_at: string;
}
export interface SummaryPayment {
  id: string;
  order_id: string | null;
  source: string;
  status: string;
  amount_minor: number;
  refunded_minor: number;
  currency: string;
  created_at: string;
}
export interface SummaryDeal {
  id: string;
  title: string;
  value: number;
  currency: string | null;
  status: string | null;
  stage_name: string | null;
}
export interface Block<T> {
  count: number;
  items: T[];
}
export interface ContactCommerceSummary {
  orders: Block<SummaryOrder> | null;
  payments: Block<SummaryPayment> | null;
  deals: Block<SummaryDeal>;
}

const canSeeCommerce = (ctx: TenantContext) => !!ctx.role && hasMinRole(ctx.role, 'agent');

/** The contact's payments, as a WHERE fragment over customer_payments p. */
function paymentsOf(accountId: string, contactId: string) {
  return Prisma.sql`p.account_id=${accountId}::uuid AND (
      p.order_id IN (SELECT o.id FROM orders o WHERE o.account_id=${accountId}::uuid AND o.contact_id=${contactId}::uuid)
      OR p.payment_link_id IN (SELECT l.id FROM payment_links l WHERE l.account_id=${accountId}::uuid AND l.contact_id=${contactId}::uuid)
      OR p.appointment_id IN (SELECT a.id FROM appointments a WHERE a.account_id=${accountId}::uuid AND a.contact_id=${contactId}::uuid))`;
}

const PAYMENT_COLUMNS = Prisma.sql`p.id::text AS id, p.order_id::text AS order_id, p.source, p.status,
  p.amount_minor::text AS amount_minor, p.refunded_minor::text AS refunded_minor, p.currency, p.created_at`;

type RawPayment = Omit<SummaryPayment, 'amount_minor' | 'refunded_minor' | 'created_at'> & {
  amount_minor: string; refunded_minor: string; created_at: string | Date;
};
const iso = (value: string | Date) => new Date(value).toISOString();
const toPayment = (r: RawPayment): SummaryPayment => ({
  ...r, amount_minor: Number(r.amount_minor), refunded_minor: Number(r.refunded_minor), created_at: iso(r.created_at),
});

async function contactExists(tx: TenantTransaction, accountId: string, contactId: string) {
  const rows = await tx.$queryRaw<{ ok: number }[]>`
    SELECT 1 AS ok FROM contacts WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
  return rows.length > 0;
}

/** Newest few orders, payments and deals with their counts, in one statement. Null when the contact is not in this workspace. */
export async function contactCommerceSummary(ctx: TenantContext, contactId: string): Promise<ContactCommerceSummary | null> {
  const commerce = canSeeCommerce(ctx);
  const a = ctx.accountId;
  return withTenant(ctx, async (tx) => {
    if (!(await contactExists(tx, a, contactId))) return null;
    const commerceSql = commerce
      ? Prisma.sql`
        (SELECT count(*) FROM orders o WHERE o.account_id=${a}::uuid AND o.contact_id=${contactId}::uuid)::int AS order_count,
        (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT o.id::text AS id, o.external_id, o.status, o.currency, o.total_minor::text AS total_minor, o.created_at
          FROM orders o WHERE o.account_id=${a}::uuid AND o.contact_id=${contactId}::uuid
          ORDER BY o.created_at DESC, o.id DESC LIMIT ${SUMMARY_LIMIT}) x) AS orders,
        (SELECT count(*) FROM customer_payments p WHERE ${paymentsOf(a, contactId)})::int AS payment_count,
        (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT ${PAYMENT_COLUMNS} FROM customer_payments p WHERE ${paymentsOf(a, contactId)}
          ORDER BY p.created_at DESC, p.id DESC LIMIT ${SUMMARY_LIMIT}) x) AS payments,`
      : Prisma.sql`0 AS order_count, NULL::json AS orders, 0 AS payment_count, NULL::json AS payments,`;
    const [row] = await tx.$queryRaw<{
      order_count: number; orders: (Omit<SummaryOrder, 'total_minor' | 'created_at'> & { total_minor: string; created_at: string })[] | null;
      payment_count: number; payments: RawPayment[] | null;
      deal_count: number; deals: (Omit<SummaryDeal, 'value'> & { value: string | number })[];
    }[]>`SELECT ${commerceSql}
        (SELECT count(*) FROM deals d WHERE d.account_id=${a}::uuid AND d.contact_id=${contactId}::uuid)::int AS deal_count,
        (SELECT COALESCE(json_agg(x), '[]'::json) FROM (
          SELECT d.id::text AS id, d.title, d.value, d.currency, d.status, s.name AS stage_name
          FROM deals d LEFT JOIN pipeline_stages s ON s.account_id=d.account_id AND s.id=d.stage_id
          WHERE d.account_id=${a}::uuid AND d.contact_id=${contactId}::uuid
          ORDER BY d.created_at DESC NULLS LAST, d.id DESC LIMIT ${SUMMARY_LIMIT}) x) AS deals`;
    return {
      orders: commerce
        ? {
            count: Number(row.order_count),
            items: (row.orders ?? []).map((o) => ({ ...o, total_minor: Number(o.total_minor), created_at: iso(o.created_at) })),
          }
        : null,
      payments: commerce ? { count: Number(row.payment_count), items: (row.payments ?? []).map(toPayment) } : null,
      deals: { count: Number(row.deal_count), items: row.deals.map((d) => ({ ...d, value: Number(d.value) })) },
    };
  });
}

/** One page (0-based) of the contact's payments, newest first, with the total. Agent and above; null when the contact is not in this workspace. */
export async function contactPaymentsPage(ctx: TenantContext, contactId: string, page: number): Promise<{ total: number; pageSize: number; payments: SummaryPayment[] } | null> {
  const a = ctx.accountId;
  const offset = Math.max(0, Math.min(Math.floor(page) || 0, 1000)) * PAYMENTS_PAGE_SIZE;
  return withTenant(ctx, async (tx) => {
    if (!(await contactExists(tx, a, contactId))) return null;
    const rows = await tx.$queryRaw<(RawPayment & { total: number })[]>`
      SELECT ${PAYMENT_COLUMNS}, count(*) OVER ()::int AS total FROM customer_payments p WHERE ${paymentsOf(a, contactId)}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ${PAYMENTS_PAGE_SIZE} OFFSET ${offset}`;
    // A page past the end has no rows to carry the window total; count separately then.
    const total = rows.length
      ? Number(rows[0].total)
      : offset === 0
        ? 0
        : Number((await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM customer_payments p WHERE ${paymentsOf(a, contactId)}`)[0].n);
    return { total, pageSize: PAYMENTS_PAGE_SIZE, // The window total is a page field, not part of each payment.
      payments: rows.map(({ total: windowTotal, ...r }) => { void windowTotal; return toPayment(r); }) };
  });
}
