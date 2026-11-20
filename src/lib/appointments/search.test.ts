import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { searchAppointments } from './search';

function fakeTx(rows: unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: async (query: { strings: readonly string[]; values: unknown[] }) => {
      calls.push({ sql: query.strings.join('?'), values: query.values });
      return rows;
    },
  } as unknown as TenantTransaction;
  return { tx, calls };
}

describe('searchAppointments', () => {
  it('returns nothing for a blank term without querying', async () => {
    const { tx, calls } = fakeTx([]);
    expect(await searchAppointments(tx, 'acct', '   ')).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('is scoped to the workspace, caps at 10, puts upcoming first and hides expired holds', async () => {
    const { tx, calls } = fakeTx([]);
    await searchAppointments(tx, 'acct', 'consult', 500);
    expect(calls[0].values).toContain('acct');
    expect(calls[0].values).toContain(10);
    expect(calls[0].sql).toMatch(/a\.account_id=\?::uuid/);
    expect(calls[0].sql).toContain("a.status <> 'expired'");
    expect(calls[0].sql).toMatch(/ORDER BY \(a\.start_at >= now\(\)\) DESC/);
    expect(calls[0].sql).not.toMatch(/outcome_note|intake|hold_code/);
  });

  it('masks number search by default: a full number only matches names', async () => {
    const { tx, calls } = fakeTx([]);
    await searchAppointments(tx, 'acct', '9876543210', 5);
    expect(calls[0].sql).not.toContain('phone_normalized');
    await searchAppointments(tx, 'acct', '9876543210', 5, false);
    expect(calls[1].sql).toContain('phone_normalized');
  });

  it('maps rows to search items', async () => {
    const start = new Date('2026-12-01T05:30:00Z');
    const { tx } = fakeTx([
      { id: 'a1', service_name: 'Consult', start_at: start, contact_name: 'Asha' },
      { id: 'a2', service_name: 'Massage', start_at: start, contact_name: null },
    ]);
    expect(await searchAppointments(tx, 'acct', 'a')).toEqual([
      { id: 'a1', title: 'Asha', subtitle: 'Consult', href: '/appointments?id=a1', at: start.toISOString() },
      { id: 'a2', title: 'Massage', subtitle: '', href: '/appointments?id=a2', at: start.toISOString() },
    ]);
  });
});
