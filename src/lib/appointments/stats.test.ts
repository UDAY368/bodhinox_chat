import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { appointmentStats, bookingRevenue, noShowRate, showRate, totals } from './stats';

describe('appointment stats', () => {
  it('no-show rate is N/A (null) with nothing recorded', () => {
    expect(noShowRate(0, 0)).toBeNull();
    expect(noShowRate(3, 1)).toBe(0.25);
    expect(showRate(0, 0)).toBeNull();
    expect(showRate(3, 1)).toBe(0.75);
  });

  it('booking revenue counts only still-paid bookings in this workspace and range, without customer data', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const tx = { $queryRaw: async (s: TemplateStringsArray, ...values: unknown[]) => { calls.push({ sql: s.join('?'), values }); return []; } };
    await bookingRevenue(tx as unknown as TenantTransaction, 'acct', { from: '2026-11-01', to: '2026-11-30' });
    expect(calls[0].sql).toContain("payment_status='paid'");
    expect(calls[0].sql).toMatch(/account_id=\?::uuid/);
    expect(calls[0].sql).not.toMatch(/contact|phone|intake|note/);
    expect(calls[0].values).toEqual(expect.arrayContaining(['acct', '2026-11-01', '2026-11-30']));
    await expect(bookingRevenue(tx as unknown as TenantTransaction, 'acct', { from: '2026-11-30', to: '2026-11-01' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('sums rows', () => {
    const row = { service_id: 's', service_name: 'S', day: '2026-11-09', booked: 2, confirmed: 2, cancelled: 1, completed: 1, no_show: 1 };
    expect(totals([row, row])).toEqual({ booked: 4, confirmed: 4, cancelled: 2, completed: 2, no_show: 2, no_show_rate: 0.5, show_rate: 0.5 });
  });

  it('rejects bad or oversized ranges before querying', async () => {
    const tx = { $queryRaw: () => { throw new Error('must not query'); } } as unknown as TenantTransaction;
    await expect(appointmentStats(tx, 'a', { from: '2026-11-10', to: '2026-11-09' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(appointmentStats(tx, 'a', { from: '2025-01-01', to: '2026-11-09' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(appointmentStats(tx, 'a', { from: 'x', to: '2026-11-09' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
