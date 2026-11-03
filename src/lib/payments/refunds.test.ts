import { describe, expect, it } from 'vitest';
import { isStaleAttempt, orderRestockable } from './refunds';

const row = (extra: Partial<{ provider_refund_id: string | null; attempt: number; superseded_provider_refund_ids: string[] }> = {}) => ({
  provider_refund_id: null, attempt: 1, superseded_provider_refund_ids: [], ...extra,
});

describe('isStaleAttempt (one refund, many attempts, one notes.bodhinox_refund_id)', () => {
  it('accepts the live attempt: its own provider id, or the first report while the row holds none', () => {
    expect(isStaleAttempt(row({ provider_refund_id: 'rfnd_B', attempt: 2 }), { id: 'rfnd_B', attempt: 2 })).toBe(false);
    expect(isStaleAttempt(row({ provider_refund_id: 'rfnd_B', attempt: 2 }), { id: 'rfnd_B', attempt: null })).toBe(false);
    expect(isStaleAttempt(row({ attempt: 2, superseded_provider_refund_ids: ['rfnd_A'] }), { id: 'rfnd_B', attempt: 2 })).toBe(false);
    expect(isStaleAttempt(row({ attempt: 2, superseded_provider_refund_ids: ['rfnd_A'] }), { id: 'rfnd_B', attempt: null })).toBe(false);
  });

  it('never lets an earlier attempt move the live one', () => {
    // Attempt 1 (rfnd_A) failed; the retry sent rfnd_B, which the row now holds.
    expect(isStaleAttempt(row({ provider_refund_id: 'rfnd_B', attempt: 2, superseded_provider_refund_ids: ['rfnd_A'] }), { id: 'rfnd_A', attempt: 1 })).toBe(true);
    // Even without notes.attempt, a different id than the row holds is another attempt.
    expect(isStaleAttempt(row({ provider_refund_id: 'rfnd_B', attempt: 2 }), { id: 'rfnd_A', attempt: null })).toBe(true);
    // The retry is still being sent (no provider id yet): the superseded id and the attempt note both say stale.
    expect(isStaleAttempt(row({ attempt: 2, superseded_provider_refund_ids: ['rfnd_A'] }), { id: 'rfnd_A', attempt: null })).toBe(true);
    expect(isStaleAttempt(row({ attempt: 3 }), { id: 'rfnd_X', attempt: 2 })).toBe(true);
  });
});

describe('orderRestockable (refund restock without a return)', () => {
  const order = (status: string, refund_state: string | null, dispatched_at: Date | null = null) => ({ status, refund_state, dispatched_at });
  it('restocks an order being unwound before dispatch', () => {
    expect(orderRestockable(order('cancelled', 'full'))).toBe(true);
    expect(orderRestockable(order('cancelled', 'partial'))).toBe(true);
    expect(orderRestockable(order('paid', 'full'))).toBe(true);
  });

  it('never restocks a partial refund of an order that still ships, or a dispatched order', () => {
    expect(orderRestockable(order('paid', 'partial'))).toBe(false);
    expect(orderRestockable(order('paid', 'none'))).toBe(false);
    expect(orderRestockable(order('payment_review', 'none'))).toBe(false);
    expect(orderRestockable(order('dispatched', 'full'))).toBe(false);
    expect(orderRestockable(order('fulfilled', 'full'))).toBe(false);
    expect(orderRestockable(order('cancelled', 'full', new Date()))).toBe(false);
  });
});

describe('customer_refunds.superseded_provider_refund_ids (migration, schema and inventory in step)', () => {
  it('is declared alike in the migration, schema.prisma and the schema inventory', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('prisma/migrations/20261107101000_customer_payments/migration.sql', 'utf8');
    expect(sql).toMatch(/superseded_provider_refund_ids text\[\] NOT NULL DEFAULT '\{\}' CHECK \(cardinality\(superseded_provider_refund_ids\) <= 20\)/);
    const prisma = readFileSync('prisma/schema.prisma', 'utf8');
    expect(prisma.match(/model customer_refunds \{[^}]*\}/)?.[0]).toMatch(/superseded_provider_refund_ids String\[\] @default\(\[\]\)/);
    const inventory = JSON.parse(readFileSync('prisma/schema-inventory.json', 'utf8')) as { tables: Record<string, { name: string; type: string; nullable: boolean }[]> };
    expect(inventory.tables.customer_refunds.find((c) => c.name === 'superseded_provider_refund_ids'))
      .toMatchObject({ type: 'text[]', nullable: false });
  });
});
