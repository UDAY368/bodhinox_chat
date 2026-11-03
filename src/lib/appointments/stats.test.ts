import { describe, expect, it } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { appointmentStats, noShowRate, totals } from './stats';

describe('appointment stats', () => {
  it('no-show rate is N/A (null) with nothing recorded', () => {
    expect(noShowRate(0, 0)).toBeNull();
    expect(noShowRate(3, 1)).toBe(0.25);
  });

  it('sums rows', () => {
    const row = { service_id: 's', service_name: 'S', day: '2026-11-09', booked: 2, confirmed: 2, cancelled: 1, completed: 1, no_show: 1 };
    expect(totals([row, row])).toEqual({ booked: 4, confirmed: 4, cancelled: 2, completed: 2, no_show: 2, no_show_rate: 0.5 });
  });

  it('rejects bad or oversized ranges before querying', async () => {
    const tx = { $queryRaw: () => { throw new Error('must not query'); } } as unknown as TenantTransaction;
    await expect(appointmentStats(tx, 'a', { from: '2026-11-10', to: '2026-11-09' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(appointmentStats(tx, 'a', { from: '2025-01-01', to: '2026-11-09' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(appointmentStats(tx, 'a', { from: 'x', to: '2026-11-09' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
