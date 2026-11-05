// Phase 14 review (deploy-safety F4 / PA-5): plan price and Meta rate-card
// writes record their platform audit row inside the SAME worker transaction,
// so a failed audit rolls the change back instead of leaving it unaudited.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as { sql: string; tx: number }[], committed: 0, auditFails: false, txSeq: 0 }));

vi.mock('@/lib/db/prisma', () => {
  const tx = (id: number) => ({
    $queryRaw: async (sql: TemplateStringsArray) => {
      const text = sql.join('?');
      h.statements.push({ sql: text, tx: id });
      if (text.includes('crm_platform_audit')) {
        if (h.auditFails) throw new Error('connection reset');
        return [{ id: 'audit-1' }];
      }
      if (text.includes('FROM plans')) return [{ id: 'basic' }];
      return [{ id: 'row' }];
    },
    $executeRaw: async (sql: TemplateStringsArray) => { h.statements.push({ sql: sql.join('?'), tx: id }); return 1; },
  });
  const worker = {
    $transaction: async (fn: (t: ReturnType<typeof tx>) => Promise<unknown>) => {
      const result = await fn(tx(++h.txSeq));
      h.committed++;
      return result;
    },
    $queryRaw: async () => { throw new Error('audit outside the transaction'); },
  };
  return { getWorkerPrisma: () => worker, getPrisma: () => worker, getPlatformPrisma: () => worker };
});

import { upsertPlanPrices } from '@/lib/billing/prices';
import { upsertRateCards } from '@/lib/analytics/rate-card';

const audit = { adminEmail: 'ops@bodhinox.test', action: 'billing.prices_updated', targetRef: 'basic', detail: {} };
const price = { plan: 'basic', interval: 'month' as const, currency: 'INR', amountMinor: 99_900, provider: 'razorpay' as const, providerPlanId: 'plan_ABC123', active: true };

beforeEach(() => { h.statements = []; h.committed = 0; h.auditFails = false; h.txSeq = 0; });

describe('platform audit in the write transaction', () => {
  it('writes the price audit row in the same transaction as the prices', async () => {
    await upsertPlanPrices([price], audit);
    const auditRow = h.statements.find((s) => s.sql.includes('crm_platform_audit'));
    const priceRow = h.statements.find((s) => s.sql.includes('INSERT INTO plan_prices'));
    expect(auditRow?.tx).toBe(priceRow?.tx);
    expect(h.committed).toBe(1);
  });

  it('a failed audit fails the transaction, so the prices or rate cards never commit unaudited', async () => {
    h.auditFails = true;
    await expect(upsertPlanPrices([price], audit)).rejects.toThrow(/connection reset/);
    await expect(upsertRateCards([{ category: 'marketing', countryCode: 'IN', currency: 'USD', priceMinor: 1 }],
      { ...audit, action: 'analytics.rate_cards_updated' })).rejects.toThrow(/connection reset/);
    expect(h.committed).toBe(0);
  });

  it('writes the rate-card audit row in the same transaction as the cards', async () => {
    await upsertRateCards([{ category: 'marketing', countryCode: 'IN', currency: 'USD', priceMinor: 1 }], { ...audit, action: 'analytics.rate_cards_updated' });
    const auditRow = h.statements.find((s) => s.sql.includes('crm_platform_audit'));
    const cardRow = h.statements.find((s) => s.sql.includes('INSERT INTO rate_cards'));
    expect(auditRow?.tx).toBe(cardRow?.tx);
    expect(h.committed).toBe(1);
  });
});
