import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { ledgerKey, newRequestKey, recordUsage, releaseUsage, reserveUsage, settleUsage } from './usage-ledger';

function fakeTx(row: Record<string, unknown>) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return [row];
    }),
  } as unknown as TenantTransaction;
  return { tx, calls };
}

describe('usage ledger wrappers', () => {
  it('calls the invoker functions with the metric, key, quantity and limit only (no account argument)', async () => {
    const { tx, calls } = fakeTx({ result: 'reserved' });
    expect(await reserveUsage(tx, 'ai_messages', 'inbound:wamid.1', 1, 100)).toBe('reserved');
    expect(calls[0].sql).toContain('billing_reserve_usage(');
    expect(calls[0].values).toEqual(['ai_messages', 'inbound:wamid.1', 1, 100]);
    expect(await reserveUsage(tx, 'ai_tokens', 'req:x', 500, null)).toBe('reserved');
    expect(calls[1].values).toEqual(['ai_tokens', 'req:x', 500, null]);
  });

  it('settles, releases and records through their own functions', async () => {
    const { tx, calls } = fakeTx({ done: true });
    expect(await settleUsage(tx, 'ai_tokens', 'task:1', 0)).toBe(true);
    expect(await releaseUsage(tx, 'ai_messages', 'task:1')).toBe(true);
    expect(await recordUsage(tx, 'ai_tokens', 'task:1', 7)).toBe(true);
    expect(calls.map((c) => c.sql.match(/billing_\w+_usage/)?.[0])).toEqual(['billing_settle_usage', 'billing_release_usage', 'billing_record_usage']);
  });

  it('refuses unknown metrics, bad keys and non-positive quantities before any query', async () => {
    const { tx, calls } = fakeTx({ result: 'reserved' });
    await expect(reserveUsage(tx, 'storage_bytes' as never, 'k', 1, null)).rejects.toThrow(/metric/);
    await expect(reserveUsage(tx, 'ai_messages', 'has space', 1, null)).rejects.toThrow(/source key/);
    await expect(reserveUsage(tx, 'ai_messages', 'x'.repeat(201), 1, null)).rejects.toThrow(/source key/);
    await expect(reserveUsage(tx, 'ai_messages', 'k', 0, null)).rejects.toThrow(/positive/);
    await expect(reserveUsage(tx, 'ai_messages', 'k', 1, -1)).rejects.toThrow(/limit/);
    await expect(settleUsage(tx, 'ai_messages', 'k', -1)).rejects.toThrow(/negative/);
    await expect(recordUsage(tx, 'ai_messages', 'k', 1.5)).rejects.toThrow(/positive/);
    expect(calls).toHaveLength(0);
  });

  it('keeps a valid key and hashes anything else to a stable ledger key', () => {
    expect(ledgerKey('flow-ai:run-1:wamid.HBgM=')).toBe('flow-ai:run-1:wamid.HBgM=');
    const long = `flow-ai:${'x'.repeat(300)}`;
    expect(ledgerKey(long)).toMatch(/^h:[0-9a-f]{64}$/);
    expect(ledgerKey(long)).toBe(ledgerKey(long));
    expect(ledgerKey('inbound:with space')).not.toBe(ledgerKey('inbound:with  space'));
    expect(newRequestKey()).toMatch(/^req:[0-9a-f-]{36}$/);
    expect(newRequestKey()).not.toBe(newRequestKey());
  });
});

describe('billing_reserve_usage SQL (Phase 14 review F2)', () => {
  it('reads the counter and the live holds in one statement, so a settle committing in between is never missed', () => {
    const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261112100200_usage_ledger/migration.sql'), 'utf8');
    const body = sql.slice(sql.indexOf('CREATE FUNCTION billing_reserve_usage'), sql.indexOf('CREATE FUNCTION billing_settle_usage'));
    expect(body).toMatch(/INTO used, held;/);
    expect(body).not.toMatch(/INTO used FROM|INTO held FROM/);
  });
});
