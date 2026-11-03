import { beforeEach, describe, expect, it, vi } from 'vitest';

type Rows = { id: string }[];
const h = vi.hoisted(() => ({
  sql: [] as string[],
  rows: { unclearLinks: [] as Rows, paidLinks: [] as Rows, unclearRefunds: [] as Rows, pendingRefunds: [] as Rows },
  link: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'unchanged'),
  refund: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'unchanged'),
}));

function fakeTx() {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      h.sql.push(sql);
      if (sql.includes("l.status='paid'")) return h.rows.paidLinks;
      if (sql.includes('FROM payment_links')) return h.rows.unclearLinks;
      if (sql.includes("status='pending'")) return h.rows.pendingRefunds;
      return h.rows.unclearRefunds;
    },
  };
}

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_c: unknown, op: (tx: unknown) => unknown) => op(fakeTx()) }));
vi.mock('./providers', () => ({ loadRazorpaySecrets: async () => ({}), PaymentProviderError: class extends Error {} }));
vi.mock('./links', () => ({ reconcilePaymentLink: h.link, STALE_CREATING_MS: 120_000 }));
vi.mock('./refunds', () => ({ reconcileRefund: h.refund, RefundError: class extends Error {}, STALE_SENDING_MS: 120_000 }));

import { runReconcileSweep } from './reconcile-sweep';

const ACCOUNT = '00000000-0000-4000-8000-000000000001';
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

describe('runReconcileSweep fairness (C11)', () => {
  beforeEach(() => {
    h.sql = []; h.link.mockClear(); h.refund.mockClear();
    h.rows = { unclearLinks: [], paidLinks: [], unclearRefunds: [], pendingRefunds: [] };
  });

  it('reconciles an unknown refund and a paid link even behind full batches of stuck rows', async () => {
    h.rows.pendingRefunds = ids('pending', 20);
    h.rows.unclearRefunds = [{ id: 'unknown-refund' }];
    h.rows.unclearLinks = ids('expired', 50);
    h.rows.paidLinks = [{ id: 'paid-link' }];
    const summary = await runReconcileSweep(ACCOUNT);
    expect(h.refund).toHaveBeenCalledWith(ACCOUNT, 'unknown-refund');
    expect(h.link).toHaveBeenCalledWith(ACCOUNT, 'paid-link');
    expect(summary).toEqual({ links: 51, refunds: 21, failures: 0 });
  });

  it('queries each class separately, in random order, so unchanged rows do not hold the head of the queue', async () => {
    await runReconcileSweep(ACCOUNT);
    expect(h.sql).toHaveLength(4);
    for (const sql of h.sql) {
      expect(sql).toContain('ORDER BY random()');
      expect(sql).not.toMatch(/ORDER BY (l\.)?updated_at/);
    }
    expect(h.sql.find((s) => s.includes("status='pending'"))).not.toContain("'unknown'");
  });
});
