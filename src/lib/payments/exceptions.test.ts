import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ inflight: 0, credit: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true), sql: [] as string[] }));
const ORDER = { id: 'o1', status: 'payment_review', currency: 'INR', total_minor: 10_000, subtotal_minor: 10_000, amount_paid_minor: 0 };

function fakeTx() {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      h.sql.push(sql);
      if (sql.includes('SELECT payment_id::text')) return [{ payment_id: '00000000-0000-4000-8000-000000000002' }];
      if (sql.includes('FROM customer_payments')) return [{ id: 'p1', amount_minor: BigInt(10_000), refunded_minor: BigInt(0), settlement: 'exception', payment_link_id: null }];
      if (sql.includes('FROM payment_exceptions')) return [{ kind: 'late_payment_no_stock', status: 'open', order_id: 'o1', subject_key: 'k' }];
      if (sql.includes('FROM customer_refunds')) return [{ n: BigInt(h.inflight) }];
      throw new Error(`unexpected query ${sql}`);
    },
    $executeRaw: async () => 1,
  };
}

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op(fakeTx()) }));
vi.mock('./settle', () => ({
  creditOrderTx: h.credit,
  lockOrderTx: async () => ORDER,
  orderDue: (o: typeof ORDER) => (o.total_minor ?? o.subtotal_minor) - o.amount_paid_minor,
}));
vi.mock('./links', () => ({ selectLink: async () => null }));
vi.mock('./ledger', async (orig) => ({ ...(await orig<typeof import('./ledger')>()), auditTx: async () => undefined }));

import { resolvePaymentException } from './exceptions';

const ctx = { accountId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000009', role: 'admin' as const };
const EXC = '00000000-0000-4000-8000-000000000003';

describe('resolvePaymentException restocked (C5/C8)', () => {
  beforeEach(() => { h.inflight = 0; h.credit.mockClear(); h.sql = []; });

  it('refuses to credit a late payment while a refund of it is still in flight', async () => {
    h.inflight = 1;
    await expect(resolvePaymentException(ctx, EXC, 'restocked')).rejects.toMatchObject({ code: 'not_payable' });
    expect(h.credit).not.toHaveBeenCalled();
    const refundSql = h.sql.find((s) => s.includes('FROM customer_refunds'))!;
    for (const status of ['requested', 'sending', 'pending', 'unknown']) expect(refundSql).toContain(`'${status}'`);
    // Checked after the payment row is locked, so no new refund can slip in.
    expect(h.sql.findIndex((s) => s.includes('FROM customer_payments'))).toBeLessThan(h.sql.indexOf(refundSql));
  });

  it('credits exactly the amount due when no refund is in flight', async () => {
    await resolvePaymentException(ctx, EXC, 'restocked');
    expect(h.credit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ paymentId: 'p1', amountMinor: 10_000, late: true }));
  });
});
