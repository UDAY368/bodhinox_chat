/**
 * Audit #13: one scheduled automation that cannot run (too many recipients, a
 * foreign reference) or that fails transiently must not cost the other
 * automations of the workspace their occurrence, nor the wait-step resumes
 * and the flow sweep of the same tick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  schedules: [] as { id: string; user_id: string; name: string; trigger_config: Record<string, unknown> }[],
  due: [] as { id: string }[],
  failFor: new Map<string, Error>(),
  queued: [] as string[],
  skipped: [] as unknown[][],
  enqueued: [] as unknown[][],
  swept: 0,
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: vi.fn() }));
vi.mock('@/lib/data/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'lte', 'order']) chain[m] = () => chain;
      chain.limit = async () => {
        if (table === 'flow_runs') { h.swept += 1; return { data: [], error: null }; }
        return { data: table === 'automation_pending_executions' ? h.due : [], error: null };
      };
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === 'automations' ? h.schedules : [], error: null });
      return chain;
    },
  }),
}));
vi.mock('./scope', () => ({ withJobScope: (_scope: unknown, fn: () => unknown) => fn() }));
vi.mock('./queue', () => ({ enqueueJob: vi.fn(async (...args: unknown[]) => { h.enqueued.push(args); return 'job'; }) }));
vi.mock('@/lib/whatsapp/process-webhook', () => ({ processWebhook: vi.fn(), processInboundActions: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ expireAwaitingReplies: vi.fn(), resumePendingExecution: vi.fn() }));
vi.mock('./scheduled-audience', () => {
  class ScheduledAudienceError extends Error {}
  return {
    ScheduledAudienceError,
    executeScheduledOccurrence: vi.fn(),
    queueScheduledOccurrence: vi.fn(async (_db: unknown, _acc: string, automation: { id: string }) => {
      const failure = h.failFor.get(automation.id);
      if (failure) throw failure;
      h.queued.push(automation.id);
    }),
    recordSkippedOccurrence: vi.fn(async (...args: unknown[]) => { h.skipped.push(args); }),
  };
});
vi.mock('@/lib/flows/engine', () => ({ handleFlowTimer: vi.fn(), handleFlowReplay: vi.fn(), staleSince: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ deliverQueuedWebhook: vi.fn() }));
vi.mock('@/lib/whatsapp/health-sync', () => ({ HEALTH_SYNC_JOB: 'whatsapp.health_sync', scheduleHealthSync: vi.fn(), syncNumberHealth: vi.fn() }));
vi.mock('@/lib/whatsapp/number-admin', () => ({ NUMBER_DISCONNECTED_REASON: 'whatsapp_number_disconnected' }));

import { handleJob } from './handlers';
import { ScheduledAudienceError } from './scheduled-audience';
import type { Job } from './queue';

const ACCOUNT = '11111111-1111-4111-8111-11111111111a';
const MINUTE = '2026-11-10T09:00:00.000Z';
const tick = () => ({ id: 'job-1', type: 'automation.schedule', tenant_id: ACCOUNT, payload: { minute: MINUTE },
  attempts: 1, max_attempts: 5 }) as unknown as Job;
const schedule = (id: string) => ({ id, user_id: 'u', name: id, trigger_config: { schedule: '0 9 * * *', timezone: 'UTC' } });

beforeEach(() => {
  h.schedules = [schedule('big'), schedule('small')];
  h.due = [{ id: '33333333-3333-4333-8333-33333333333c' }];
  h.failFor = new Map();
  h.queued = [];
  h.skipped = [];
  h.enqueued = [];
  h.swept = 0;
});

describe('automation.schedule tick', () => {
  it('logs an automation that cannot run and still queues the others, the resumes and the sweep', async () => {
    h.failFor.set('big', new ScheduledAudienceError('Scheduled audience exceeds the 10000-contact limit'));
    await handleJob(tick());
    expect(h.queued).toEqual(['small']);
    expect(h.skipped).toHaveLength(1);
    expect(h.skipped[0].slice(2)).toEqual([h.schedules[0], MINUTE, 'Scheduled audience exceeds the 10000-contact limit']);
    expect(h.enqueued.map((call) => call[0])).toEqual(['automation.resume']);
    expect(h.swept).toBe(1);
  });

  it('rethrows a transient failure after the other automations, resumes and sweep, so the minute is retried', async () => {
    h.failFor.set('big', new Error('database unavailable'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleJob(tick())).rejects.toThrow('database unavailable');
    expect(h.queued).toEqual(['small']);
    expect(h.skipped).toEqual([]);
    expect(h.enqueued.map((call) => call[0])).toEqual(['automation.resume']);
    expect(h.swept).toBe(1);
    // The log line names the automation only, never the error text.
    expect(JSON.stringify(errors.mock.calls)).not.toContain('database unavailable');
    errors.mockRestore();
  });
});
