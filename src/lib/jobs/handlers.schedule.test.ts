import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// scheduleWork's catch-up bookkeeping (audit 50/56): which range it queues, and that the stored
// minute advances only after every workspace's automation.schedule job is queued.
const h = vi.hoisted(() => ({
  accounts: [] as { account_id: string }[],
  state: [] as { last_minute: Date }[] | Error,
  writes: [] as unknown[][],
  enqueued: [] as { payload: Record<string, unknown>; options: Record<string, unknown> }[],
  enqueueFails: false,
}));

vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('crm_accounts_for_scheduling')) return Promise.resolve(h.accounts);
      if (sql.includes('worker_schedule_state')) return h.state instanceof Error ? Promise.reject(h.state) : Promise.resolve(h.state);
      return Promise.resolve([]);
    },
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('worker_schedule_state')) h.writes.push(values);
      return Promise.resolve(1);
    },
  }),
}));
vi.mock('./queue', () => ({
  enqueueJob: vi.fn(async (_type: string, payload: Record<string, unknown>, options: Record<string, unknown>) => {
    if (h.enqueueFails && h.enqueued.length === 1) throw new Error('queue unavailable');
    h.enqueued.push({ payload, options });
    return 'job';
  }),
}));
vi.mock('@/lib/whatsapp/health-sync', () => ({ HEALTH_SYNC_JOB: 'whatsapp.health_sync', scheduleHealthSync: vi.fn(async () => {}), syncNumberHealth: vi.fn() }));
vi.mock('@/lib/inbox/jobs', () => ({ handleInboxJob: vi.fn(), isInboxJob: () => false, scheduleInboxSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/notifications/digest', () => ({ NOTIFICATION_DIGEST_JOB: 'notifications.digest', scheduleNotificationDigests: vi.fn(async () => {}), sendNotificationDigest: vi.fn() }));
vi.mock('@/lib/billing/subscriptions', () => ({ scheduleBillingSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/reports', () => ({ scheduleReportSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/report-schedules', () => ({ scheduleReportSchedules: vi.fn(async () => {}), runReportSchedules: vi.fn() }));
vi.mock('@/lib/meta-ads/schedule', () => ({ scheduleMetaAds: vi.fn(async () => {}) }));
vi.mock('@/lib/payments/reconcile-sweep', () => ({ scheduleReconcileSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/fulfilment/sweep', () => ({ scheduleFulfilmentSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/instagram/token-sweep', () => ({ scheduleInstagramSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/instagram/resubscribe', () => ({ scheduleInstagramResubscribe: vi.fn(async () => {}) }));
vi.mock('@/lib/ai/retention', () => ({ scheduleAiRetention: vi.fn(async () => {}) }));
vi.mock('@/lib/billing/reconciliation', () => ({ scheduleBillingReconcile: vi.fn(async () => {}) }));
vi.mock('@/lib/jobs/usage-housekeeping', () => ({ scheduleUsageHousekeeping: vi.fn(async () => {}) }));
vi.mock('@/lib/jobs/workspace-export', () => ({ scheduleWorkspaceExportSweeps: vi.fn(async () => {}) }));
vi.mock('@/lib/sequences/jobs', () => ({ SEQUENCES_DUE_JOB: 'sequences.due', scheduleSequenceSweeps: vi.fn(async () => 0), handleSequenceJob: vi.fn() }));

import { scheduleWork } from './handlers';
import { scheduleSequenceSweeps } from '@/lib/sequences/jobs';

const NOW = new Date('2026-10-15T09:10:20.000Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.accounts = [{ account_id: A }, { account_id: B }];
  h.state = [];
  h.writes = [];
  h.enqueued = [];
  h.enqueueFails = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('[audit-50/56] scheduleWork catch-up', () => {
  it('queues every minute since the last one queued, then advances the stored minute', async () => {
    h.state = [{ last_minute: new Date('2026-10-15T09:05:00.000Z') }];
    await scheduleWork();
    expect(h.enqueued.map((e) => e.payload)).toEqual([
      { minute: '2026-10-15T09:10:00.000Z', from: '2026-10-15T09:06:00.000Z' },
      { minute: '2026-10-15T09:10:00.000Z', from: '2026-10-15T09:06:00.000Z' },
    ]);
    expect(h.enqueued.map((e) => e.options.tenantId)).toEqual([A, B]);
    expect(h.writes).toEqual([[new Date('2026-10-15T09:10:00.000Z')]]);
  });

  it('offers due sequence messages on every pass (Stage 5)', async () => {
    await scheduleWork();
    expect(scheduleSequenceSweeps).toHaveBeenCalled();
  });

  it('starts from the current minute with no stored state', async () => {
    await scheduleWork();
    expect(h.enqueued[0].payload).toEqual({ minute: '2026-10-15T09:10:00.000Z', from: '2026-10-15T09:10:00.000Z' });
    expect(h.writes).toHaveLength(1);
  });

  it('keeps the stored minute when a workspace could not be queued, so the next pass covers the range again', async () => {
    h.state = [{ last_minute: new Date('2026-10-15T09:05:00.000Z') }];
    h.enqueueFails = true;
    await expect(scheduleWork()).rejects.toThrow('queue unavailable');
    expect(h.writes).toEqual([]);
  });

  it('caps the catch-up at 60 minutes and logs the skipped gap without tenant data', async () => {
    h.state = [{ last_minute: new Date('2026-10-15T06:00:00.000Z') }];
    await scheduleWork();
    expect(h.enqueued[0].payload).toEqual({ minute: '2026-10-15T09:10:00.000Z', from: '2026-10-15T08:11:00.000Z' });
    expect(console.error).toHaveBeenCalledWith('[worker] automation schedule gap longer than the catch-up window', { skippedMinutes: 130 });
  });

  it('schedules only the current minute and stores nothing when the state table is unreadable (before its migration)', async () => {
    h.state = new Error('relation "worker_schedule_state" does not exist');
    await scheduleWork();
    expect(h.enqueued[0].payload).toEqual({ minute: '2026-10-15T09:10:00.000Z', from: '2026-10-15T09:10:00.000Z' });
    expect(h.writes).toEqual([]);
  });
});
