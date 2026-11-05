import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';

const h = vi.hoisted(() => ({
  recordBillingNotice: vi.fn(),
  withTenant: vi.fn(),
  getEntitlements: vi.fn(),
}));
vi.mock('./billing-notify', () => ({ recordBillingNotice: h.recordBillingNotice }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('./entitlements', () => ({ getEntitlements: h.getEntitlements }));

import { notifyLimitRefused, reachedThresholds, recordUsageNotices } from './usage-notices';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

function fakeTx(newRows: boolean) {
  const inserts: unknown[][] = [];
  const tx = {
    $executeRaw: vi.fn(async (_s: TemplateStringsArray, ...values: unknown[]) => { inserts.push(values); return newRows ? 1 : 0; }),
  } as unknown as TenantTransaction;
  return { tx, inserts };
}

beforeEach(() => {
  h.recordBillingNotice.mockReset().mockResolvedValue(undefined);
  h.withTenant.mockReset().mockImplementation(async (_c: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx(true).tx));
  h.getEntitlements.mockReset();
});

describe('reachedThresholds', () => {
  it('fires at 80% and 100% of a finite limit only', () => {
    expect(reachedThresholds(79, 100)).toEqual([]);
    expect(reachedThresholds(80, 100)).toEqual([80]);
    expect(reachedThresholds(100, 100)).toEqual([80, 100]);
    expect(reachedThresholds(5_000, null)).toEqual([]);
    expect(reachedThresholds(0, 0)).toEqual([80, 100]);
  });
});

describe('recordUsageNotices', () => {
  it('records each reached threshold once per month and notifies only for a new row', async () => {
    const { tx, inserts } = fakeTx(true);
    const at = new Date('2026-11-05T10:00:00Z');
    expect(await recordUsageNotices(tx, ACCOUNT, { key: 'contacts', used: 1000, limit: 1000, planName: 'Basic', at })).toEqual([80, 100]);
    expect(inserts.map((v) => v.slice(1, 4))).toEqual([['contacts', '2026-11', 80], ['contacts', '2026-11', 100]]);
    // Both rows are kept; only the highest is announced (no 80% warning at the same moment as 100%).
    expect(h.recordBillingNotice).toHaveBeenCalledTimes(1);
    expect(h.recordBillingNotice).toHaveBeenCalledWith(tx, ACCOUNT, 'usage_reached', 'usage:contacts:2026-11:100',
      { plan: 'Basic', number: expect.stringContaining('1,000/1,000') });
    h.recordBillingNotice.mockClear();
    await recordUsageNotices(fakeTx(true).tx, ACCOUNT, { key: 'contacts', used: 850, limit: 1000, planName: 'Basic', at });
    expect(h.recordBillingNotice).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'usage_warning', 'usage:contacts:2026-11:80', expect.objectContaining({ plan: 'Basic' }));

    h.recordBillingNotice.mockClear();
    const again = fakeTx(false);
    expect(await recordUsageNotices(again.tx, ACCOUNT, { key: 'contacts', used: 1000, limit: 1000, planName: 'Basic', at })).toEqual([]);
    expect(h.recordBillingNotice).not.toHaveBeenCalled();
  });

  it('writes nothing for an unlimited key or below 80%', async () => {
    const { tx, inserts } = fakeTx(true);
    await recordUsageNotices(tx, ACCOUNT, { key: 'ai_messages', used: 10_000, limit: null, planName: 'Enterprise' });
    await recordUsageNotices(tx, ACCOUNT, { key: 'ai_messages', used: 10, limit: 100, planName: 'Free' });
    expect(inserts).toHaveLength(0);
    expect(h.recordBillingNotice).not.toHaveBeenCalled();
  });
});

describe('notifyLimitRefused', () => {
  it('records the 100% notice on the worker for a finite limit, nothing for an unlimited one', async () => {
    h.getEntitlements.mockResolvedValue({ planName: 'Free', limits: { seats: 1, contacts: null } });
    await notifyLimitRefused(ACCOUNT, 'seats');
    expect(h.withTenant).toHaveBeenCalledWith({ accountId: ACCOUNT, role: 'owner' }, expect.any(Function), { worker: true });
    expect(h.recordBillingNotice).toHaveBeenCalledWith(expect.anything(), ACCOUNT, 'usage_reached', expect.stringMatching(/^usage:seats:\d{4}-\d{2}:100$/), expect.any(Object));
    h.recordBillingNotice.mockClear();
    await notifyLimitRefused(ACCOUNT, 'contacts');
    expect(h.recordBillingNotice).not.toHaveBeenCalled();
  });

  it('never throws and logs no detail when the notice fails', async () => {
    h.withTenant.mockRejectedValueOnce(new Error('connection refused: row value'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyLimitRefused(ACCOUNT, 'seats')).resolves.toBeUndefined();
    expect(JSON.stringify(error.mock.calls)).not.toContain('row value');
    error.mockRestore();
  });
});
