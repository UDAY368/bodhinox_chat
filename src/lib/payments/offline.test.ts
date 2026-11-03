import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  links: [] as { id: string; status: string; unsettled: boolean }[],
  credit: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  cancel: vi.fn<(...args: unknown[]) => Promise<{ status: string }>>(async () => ({ status: 'cancelled' })),
}));
const ORDER = { id: 'o1', status: 'awaiting_payment', source: 'store', external_id: null, priced_at: null, total_minor: 10_000, subtotal_minor: 10_000,
  amount_paid_minor: 0, currency: 'INR', contact_id: null, conversation_id: null };

function fakeTx() {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('AS replay')) return [{ currency: 'INR', replay: false }];
      if (sql.includes('FROM payment_links')) return h.links;
      if (sql.includes('FROM orders')) return [ORDER];
      throw new Error(`unexpected query ${sql}`);
    },
    $executeRaw: async () => 1,
  };
}

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op(fakeTx()) }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => undefined }));
vi.mock('./links', () => ({ cancelPaymentLinkRecord: h.cancel, PaymentLinkError: class extends Error {} }));
vi.mock('./settle', async (orig) => ({ ...(await orig<typeof import('./settle')>()), creditOrderTx: h.credit, lockOrderTx: async () => ORDER }));
vi.mock('./ledger', async (orig) => ({ ...(await orig<typeof import('./ledger')>()), auditTx: async () => undefined }));

import { recordOfflinePayment, refuseLiveLinks } from './offline';

const ctx = { accountId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000009', role: 'admin' as const };
const ORDER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const input = (n: number) => ({ amount: '100.00', method: 'cash' as const, clientRequestId: `00000000-0000-4000-8000-00000000000${n}` });

describe('offline payment against an order already paid online (C10)', () => {
  beforeEach(() => { h.links = []; h.credit.mockClear(); h.cancel.mockClear(); });

  it('refuses while a paid link has not settled yet, before cancelling or crediting anything', async () => {
    h.links = [{ id: 'l1', status: 'paid', unsettled: true }, { id: 'l2', status: 'created', unsettled: false }];
    await expect(recordOfflinePayment(ctx, ORDER_ID, input(1))).rejects.toMatchObject({ code: 'link_paid' });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.credit).not.toHaveBeenCalled();
  });

  it('allows a paid link whose payment settled as an exception, and credits the amount due', async () => {
    h.links = [{ id: 'l1', status: 'paid', unsettled: false }];
    await recordOfflinePayment(ctx, ORDER_ID, input(2));
    expect(h.credit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountMinor: 10_000, late: false }));
  });

  it('keeps refusing links whose outcome is unclear', () => {
    for (const status of ['creating', 'unknown', 'partially_paid'])
      expect(() => refuseLiveLinks([{ id: 'l', status, unsettled: false }])).toThrow(expect.objectContaining({ code: 'link_pending' }));
    expect(() => refuseLiveLinks([{ id: 'l', status: 'created', unsettled: false }])).not.toThrow();
  });
});
