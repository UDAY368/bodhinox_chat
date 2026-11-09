import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  replays: [] as unknown[],
  schedules: [] as string[],
  runs: [] as Record<string, unknown>[],
  versions: [] as { id: string; fallback_policy: unknown }[],
  timedOut: [] as string[],
  versionQueries: [] as unknown[][],
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_ctx: unknown, op: (tx: unknown) => unknown) => op({
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => { h.versionQueries.push(values); return h.versions; },
  }),
}));
vi.mock('@/lib/data/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'flow_run_events') return { insert: async () => ({ error: null }) };
      let updating = false;
      let id = '';
      const chain = {
        select: () => chain,
        update: () => { updating = true; return chain; },
        eq: (column: string, value: string) => { if (column === 'id') id = value; return chain; },
        limit: async () => ({ data: h.runs, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (updating) h.timedOut.push(id);
          return resolve({ data: updating ? [{ id }] : h.runs, error: null });
        },
      };
      return chain;
    },
  }),
}));
vi.mock('./scope', () => ({ withJobScope: (_scope: unknown, fn: () => unknown) => fn() }));
vi.mock('./queue', () => ({ enqueueJob: vi.fn() }));
vi.mock('@/lib/whatsapp/process-webhook', () => ({ processWebhook: vi.fn(), processInboundActions: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ expireAwaitingReplies: vi.fn(), resumePendingExecution: vi.fn() }));
vi.mock('./scheduled-audience', () => ({ executeScheduledOccurrence: vi.fn(), queueScheduledOccurrence: vi.fn(), recordSkippedOccurrence: vi.fn(), ScheduledAudienceError: class extends Error {} }));
vi.mock('@/lib/flows/fallback', () => ({
  resolveFallbackPolicy: (policy: { on_timeout_hours?: number } | null | undefined) => ({ on_timeout_hours: policy?.on_timeout_hours ?? 24 }),
}));
vi.mock('@/lib/flows/engine', () => ({
  handleFlowTimer: vi.fn(),
  handleFlowReplay: async (payload: unknown) => { h.replays.push(payload); return 'replayed'; },
  staleSince: (run: { last_advanced_at: string }) => run.last_advanced_at,
}));
vi.mock('@/lib/analytics/report-schedules', () => ({
  runReportSchedules: async (accountId: string) => { h.schedules.push(accountId); return []; },
  scheduleReportSchedules: vi.fn(),
}));
vi.mock('@/lib/webhooks/deliver', () => ({ deliverQueuedWebhook: vi.fn() }));
vi.mock('@/lib/whatsapp/health-sync', () => ({ HEALTH_SYNC_JOB: 'whatsapp.health_sync', scheduleHealthSync: vi.fn(), syncNumberHealth: vi.fn() }));
vi.mock('@/lib/whatsapp/number-admin', () => ({ NUMBER_DISCONNECTED_REASON: 'whatsapp_number_disconnected' }));

import { handleJob } from './handlers';
import type { Job } from './queue';

const ACCOUNT = '11111111-1111-4111-8111-11111111111a';
const RUN = '22222222-2222-4222-8222-22222222222b';
const job = (type: string, payload: Record<string, unknown> = {}) =>
  ({ id: 'job-1', type, tenant_id: ACCOUNT, payload, attempts: 1, max_attempts: 3 }) as unknown as Job;

beforeEach(() => {
  Object.assign(h, { replays: [], schedules: [], runs: [], versions: [], timedOut: [], versionQueries: [] });
});

describe('flow.replay', () => {
  it('replays with the job tenant, the queued seq and node', async () => {
    await handleJob(job('flow.replay', { accountId: ACCOUNT, runId: RUN, seq: 4, nodeKey: 'n1' }));
    expect(h.replays).toEqual([{ accountId: ACCOUNT, runId: RUN, seq: 4, nodeKey: 'n1' }]);
  });

  it('refuses a payload for another workspace or with a bad contract', async () => {
    await expect(handleJob(job('flow.replay', { accountId: '33333333-3333-4333-8333-33333333333c', runId: RUN })))
      .rejects.toThrow('Invalid flow replay contract');
    await expect(handleJob(job('flow.replay', { runId: RUN, seq: '4' }))).rejects.toThrow('Invalid flow replay contract');
    await expect(handleJob(job('flow.replay', { runId: RUN, nodeKey: 7 }))).rejects.toThrow('Invalid flow replay contract');
    await expect(handleJob(job('flow.replay', { runId: 'nope' }))).rejects.toThrow('Invalid job identifier');
    expect(h.replays).toEqual([]);
  });
});

describe('analytics.report_schedules', () => {
  it('runs the due schedules of the job tenant', async () => {
    await handleJob(job('analytics.report_schedules'));
    expect(h.schedules).toEqual([ACCOUNT]);
  });
});

describe('flow.sweep with pinned runs', () => {
  it('times a pinned run out by its version policy, and an unpinned one by the live flow', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    h.runs = [
      // Pinned to a version with a 1-hour timeout although the live flow says 24 hours: times out.
      { id: 'pinned', last_advanced_at: twoHoursAgo, flow_version_id: 'v1', flows: { fallback_policy: { on_timeout_hours: 24 } } },
      // Unpinned, live flow 24 hours: stays.
      { id: 'legacy', last_advanced_at: twoHoursAgo, flow_version_id: null, flows: { fallback_policy: { on_timeout_hours: 24 } } },
      // Unpinned, live flow 1 hour: times out.
      { id: 'legacy-short', last_advanced_at: twoHoursAgo, flow_version_id: null, flows: { fallback_policy: { on_timeout_hours: 1 } } },
    ];
    h.versions = [{ id: 'v1', fallback_policy: { on_timeout_hours: 1 } }];
    await handleJob(job('flow.sweep'));
    expect(h.timedOut.sort()).toEqual(['legacy-short', 'pinned']);
    // Versions are read once, scoped to the job's workspace.
    expect(h.versionQueries).toEqual([[ACCOUNT, ['v1']]]);
  });
});
