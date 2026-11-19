/**
 * Counter sale (POS-lite, Store plan Phase 8 batch 8): a member at the shop counter sells to a customer (or a
 * walk-in) and takes cash or UPI in one tap. It adds no new way to price or to mark an order paid; it runs the
 * two existing paths back to back as the same signed-in member:
 *   1. createManualOrder (manual-orders.ts): server pricing, price lists, discount and gift rules, stock held
 *      with no expiry, idempotent on the client request id;
 *   2. recordOfflinePayment (payments/offline.ts): the staff-recorded payment that settles through creditOrderTx
 *      (stock committed, receipt queued, loyalty earned, order.paid), idempotent on the same request id.
 * They are two transactions, so a failure of step 2 leaves a real order, unpaid and holding its stock. The
 * result then says so ({ orderId, paymentId: null, paymentError }); the browser repeats the same request (same
 * id): step 1 is a replay, step 2 tries again. Nothing is paid twice either way.
 *
 * Role: admin and above, because recording a payment needs commerce.record_payments (admin) on top of the
 * commerce.checkout (agent) that manual orders need; both permissions are checked before anything is written.
 *
 * Walk-in customer: one phone-less contact per workspace (id derived from the workspace, name "Walk-in
 * customer"), created on first use inside the caller's tenant. It carries no phone, so no message or broadcast
 * can reach it, and it never matches a real customer. A named customer is any existing contact of the workspace.
 */
import { requirePermission } from '@/lib/auth/permissions';
import { ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant } from '@/lib/db/tenant';
import { OfflinePaymentError, REFERENCE_MAX, recordOfflinePayment, type OfflineMethod } from '@/lib/payments/offline';
import { minorToDecimalString, minorFromDb } from './money';
import { createManualOrder, ManualOrderError, parseManualOrder, type ManualOrderInput } from './manual-orders';
import type { StaffContext } from './order-lifecycle';
import { seededUuid } from './storefront';

export const COUNTER_METHODS = ['cash', 'upi'] as const satisfies readonly OfflineMethod[];
export type CounterMethod = (typeof COUNTER_METHODS)[number];
export const WALK_IN_NAME = 'Walk-in customer';
const PLACEHOLDER_CONTACT = '00000000-0000-4000-8000-000000000000';

export interface CounterSaleInput {
  /** null = the workspace's walk-in customer. */
  contactId: string | null;
  order: ManualOrderInput;
  method: CounterMethod;
  reference: string | null;
}

/** POST body: { contact_id?: uuid|null, lines: [{ variant_id, qty }], method: 'cash'|'upi', reference?, note?, client_request_id }. Prices are never accepted. */
export function parseCounterSale(body: unknown): CounterSaleInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ManualOrderError('invalid', 400);
  const { method, reference, contact_id: contactId, ...rest } = body as Record<string, unknown>;
  if (!(COUNTER_METHODS as readonly unknown[]).includes(method)) throw new ManualOrderError('invalid', 400);
  if (reference !== undefined && reference !== null && (typeof reference !== 'string' || reference.length > REFERENCE_MAX || /[\u0000-\u001f]/.test(reference)))
    throw new ManualOrderError('invalid', 400);
  if (contactId !== undefined && contactId !== null && typeof contactId !== 'string') throw new ManualOrderError('invalid', 400);
  // Same validation as a manual order (lines, note, request id, no prices); the contact is resolved later for a walk-in.
  const order = parseManualOrder({ ...rest, contact_id: contactId ?? PLACEHOLDER_CONTACT });
  return {
    contactId: contactId ? order.contactId : null, order, method: method as CounterMethod,
    reference: typeof reference === 'string' && reference.trim() ? reference.trim() : null,
  };
}

export const walkInContactId = (accountId: string): string => seededUuid(`walk-in-contact:${accountId}`);

/** The workspace's walk-in contact, made on first use (a concurrent first use finds it: ON CONFLICT DO NOTHING). */
export async function ensureWalkInContact(ctx: StaffContext): Promise<string> {
  const id = walkInContactId(ctx.accountId);
  await withTenant(ctx, (tx) => tx.$executeRaw`INSERT INTO contacts(id,account_id,user_id,phone,name)
    VALUES(${id}::uuid,${ctx.accountId}::uuid,${ctx.userId}::uuid,'',${WALK_IN_NAME}) ON CONFLICT (id) DO NOTHING`);
  return id;
}

export interface CounterSaleResult {
  orderId: string;
  /** false for a replay of a request whose order already existed. */
  created: boolean;
  paymentId: string | null;
  /** Set when the order exists but the payment did not go through: repeat the same request to retry it. */
  paymentError: string | null;
}

export async function createCounterSale(ctx: StaffContext, input: CounterSaleInput): Promise<CounterSaleResult> {
  if (!ctx.role || !hasMinRole(ctx.role, 'admin')) throw new ForbiddenError('Insufficient workspace role');
  await requirePermission(ctx, 'commerce.checkout');
  await requirePermission(ctx, 'commerce.record_payments');
  const contactId = input.contactId ?? (await ensureWalkInContact(ctx));
  const { orderId, created } = await createManualOrder(ctx, { ...input.order, contactId });
  const [order] = await withTenant(ctx, (tx) => tx.$queryRaw<{ total_minor: bigint | null; currency: string }[]>`
    SELECT total_minor, currency FROM orders WHERE account_id=${ctx.accountId}::uuid AND id=${orderId}::uuid`);
  const total = minorFromDb(order?.total_minor);
  if (!order || total === null) return { orderId, created, paymentId: null, paymentError: 'not_found' };
  try {
    const { paymentId } = await recordOfflinePayment(ctx, orderId, {
      amount: minorToDecimalString(total, order.currency), method: input.method, reference: input.reference,
      clientRequestId: input.order.clientRequestId,
    });
    return { orderId, created, paymentId, paymentError: null };
  } catch (error) {
    if (error instanceof OfflinePaymentError) return { orderId, created, paymentId: null, paymentError: error.code };
    throw error;
  }
}
