/**
 * Small transaction helpers shared by settlement, refunds, offline payments
 * and the exception queue. Every helper runs inside the caller's worker
 * transaction so what it writes commits (or rolls back) with the money
 * movement it describes. Codes and ids only: never customer or provider text.
 */
import { createHash } from 'node:crypto';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';

export const EXCEPTION_KINDS = [
  'late_payment_no_stock', 'late_payment_slot_lost', 'payment_on_closed_order', 'duplicate_payment',
  'amount_mismatch', 'currency_mismatch', 'merchant_changed', 'payment_unmatched', 'refund_unknown', 'refund_failed',
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9_]{1,64}$/;

/**
 * A stable v4-shaped uuid from a seed, so a replayed staff request (same
 * workspace, user and client request id) maps to the same row id and an
 * INSERT ... ON CONFLICT (id) returns the first one instead of acting twice.
 */
export function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface ExceptionInput {
  accountId: string;
  kind: ExceptionKind;
  /** e.g. payment:<id>, refund:<id>, link:<id>. One open exception per kind and subject. */
  subjectKey: string;
  orderId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  appointmentId?: string | null;
  paymentLinkId?: string | null;
  /** A code only. */
  detail?: string | null;
}

/**
 * Opens an exception (once per kind and subject while open) and alerts the
 * owners and admins once. Returns the open exception's id.
 */
export async function openExceptionTx(tx: TenantTransaction, input: ExceptionInput): Promise<string> {
  const detail = input.detail && CODE.test(input.detail) ? input.detail : null;
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO payment_exceptions(account_id,kind,subject_key,order_id,payment_id,refund_id,appointment_id,payment_link_id,detail)
    VALUES(${input.accountId}::uuid,${input.kind},${input.subjectKey},${input.orderId ?? null}::uuid,${input.paymentId ?? null}::uuid,
      ${input.refundId ?? null}::uuid,${input.appointmentId ?? null}::uuid,${input.paymentLinkId ?? null}::uuid,${detail})
    ON CONFLICT (account_id,kind,subject_key) WHERE status='open' DO NOTHING
    RETURNING id::text AS id`;
  if (inserted[0]) {
    await notifyAdminsTx(tx, input.accountId, inserted[0].id, input.kind);
    return inserted[0].id;
  }
  const open = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM payment_exceptions
    WHERE account_id=${input.accountId}::uuid AND kind=${input.kind} AND subject_key=${input.subjectKey} AND status='open'`;
  return open[0]?.id ?? '';
}

async function notifyAdminsTx(tx: TenantTransaction, accountId: string, exceptionId: string, kind: ExceptionKind): Promise<void> {
  const t = getT('Payments.notifications');
  const tKind = getT('Payments.exceptions.kinds');
  const title = t('exceptionTitle');
  const body = t('exceptionBody', { kind: tKind(kind) });
  await tx.$executeRaw`INSERT INTO notifications(account_id,user_id,type,title,body,dedupe_key)
    SELECT ${accountId}::uuid, m.user_id, 'payment_exception', ${title}, ${body}, ${`payment-exception:${exceptionId}`}
    FROM account_memberships m WHERE m.account_id=${accountId}::uuid AND m.role IN ('owner','admin')
    ON CONFLICT DO NOTHING`;
}

/** Resolves every open exception matching the filter (e.g. a payment fully refunded). */
export async function resolveExceptionsTx(tx: TenantTransaction, accountId: string, where: { paymentId?: string; subjectKey?: string },
  resolution: 'refunded' | 'restocked' | 'accepted' | 'dismissed', userId: string | null): Promise<number> {
  if (!where.paymentId && !where.subjectKey) return 0;
  return tx.$executeRaw`UPDATE payment_exceptions SET status='resolved', resolution=${resolution}, resolved_by=${userId}::uuid, resolved_at=now()
    WHERE account_id=${accountId}::uuid AND status='open'
      AND (${where.paymentId ?? null}::uuid IS NULL OR payment_id=${where.paymentId ?? null}::uuid)
      AND (${where.subjectKey ?? null}::text IS NULL OR subject_key=${where.subjectKey ?? null})`;
}

/** Appends to an order's history (worker role). `actorUserId` set means staff. */
export async function orderEventTx(tx: TenantTransaction, accountId: string, orderId: string, kind: string,
  opts: { actorUserId?: string | null; detail?: string | null } = {}): Promise<void> {
  const actor = opts.actorUserId ? 'staff' : 'system';
  const detail = opts.detail && CODE.test(opts.detail) ? opts.detail : null;
  await tx.$executeRaw`INSERT INTO order_events(account_id,order_id,kind,actor,actor_user_id,detail)
    VALUES(${accountId}::uuid,${orderId}::uuid,${kind},${actor},${opts.actorUserId ?? null}::uuid,${detail})`;
}

/** One job, deduplicated by key, committed with the caller's transaction. */
export async function enqueueJobTx(tx: TenantTransaction, accountId: string, type: string, payload: Record<string, unknown>, dedupeKey: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
    VALUES(${type},${accountId}::uuid,${JSON.stringify(payload)}::jsonb,${dedupeKey})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/** Audit entry; metadata is ids, codes and amounts only. */
export async function auditTx(tx: TenantTransaction, accountId: string, userId: string | null, action: string, resourceId: string,
  metadata: Record<string, string | number | boolean | null> = {}): Promise<void> {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,${action},${resourceId},${JSON.stringify(metadata)}::jsonb)`;
}
