import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  planError: null as unknown,
  claimed: 0,
  delivered: 0,
  finalized: 0,
  unlocked: 0,
  enqueued: [] as unknown[],
  steps: [] as string[],
  throttled: false,
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('./scope', () => ({ withJobScope: (_scope: unknown, fn: () => unknown) => fn() }));
vi.mock('./queue', () => ({ enqueueJob: async (...args: unknown[]) => { h.enqueued.push(args); return 'job-2'; } }));
vi.mock('@/lib/whatsapp/process-webhook', () => ({ processWebhook: vi.fn(), processInboundActions: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ expireAwaitingReplies: vi.fn(), resumePendingExecution: vi.fn() }));
vi.mock('./scheduled-audience', () => ({ executeScheduledOccurrence: vi.fn(), queueScheduledOccurrence: vi.fn() }));
vi.mock('@/lib/flows/fallback', () => ({ resolveFallbackPolicy: vi.fn() }));
vi.mock('@/lib/flows/engine', () => ({ handleFlowTimer: vi.fn(), staleSince: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ deliverQueuedWebhook: vi.fn() }));
vi.mock('@/lib/whatsapp/health-sync', () => ({ HEALTH_SYNC_JOB: 'whatsapp.health_sync', scheduleHealthSync: vi.fn(), syncNumberHealth: vi.fn() }));
vi.mock('@/lib/whatsapp/number-admin', () => ({ NUMBER_DISCONNECTED_REASON: 'whatsapp_number_disconnected' }));
vi.mock('@/lib/broadcasts/schedule', () => ({
  broadcastDispatchable: async () => true,
  lockBroadcastDelivery: async () => true,
  unlockBroadcastDelivery: async () => { h.unlocked += 1; },
  claimBroadcastStart: async () => { h.claimed += 1; return true; },
  prepareFailedRetry: async (_account: string, _broadcast: string, retryId: string) => { h.steps.push(`prepare:${retryId}`); return 1; },
}));
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  planBroadcastResume: async () => { h.steps.push('plan'); if (h.planError) throw h.planError; return { plan: {}, remaining: 0 }; },
}));
vi.mock('@/lib/whatsapp/broadcast-core', () => {
  class BroadcastError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  }
  return {
    BroadcastError,
    MAX_THROTTLE_RETRIES: 6,
    throttleDelayMs: () => 1000,
    deliverBroadcast: async () => { h.delivered += 1; return h.throttled ? { sent: 0, throttled: true } : { sent: 1, throttled: false }; },
    finalizeBroadcastStatus: async () => { h.finalized += 1; },
  };
});

import { handleJob } from './handlers';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import type { Job } from './queue';

const ACCOUNT = '11111111-1111-4111-8111-11111111111a';
const BROADCAST = '22222222-2222-4222-8222-22222222222b';
const job = { id: 'job-1', type: 'broadcast.dispatch', tenant_id: ACCOUNT, payload: { broadcastId: BROADCAST, scope: 'pending' } } as unknown as Job;

describe('broadcast.dispatch on a disconnected number', () => {
  beforeEach(() => {
    Object.assign(h, { planError: null, claimed: 0, delivered: 0, finalized: 0, unlocked: 0, enqueued: [], steps: [], throttled: false });
  });

  it('holds the campaign: completes without retry, status untouched, one reason logged', async () => {
    h.planError = new BroadcastError('whatsapp_number_disconnected', 'This WhatsApp number was disconnected.', 409);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Resolves (no throw), so the queue neither retries nor burns an attempt.
    await expect(handleJob(job)).resolves.toBeUndefined();
    expect(h.claimed).toBe(0); // never moved to 'sending'
    expect(h.delivered).toBe(0);
    expect(h.finalized).toBe(0); // status left as it was
    expect(h.enqueued).toEqual([]); // no follow-up pass, no other number
    expect(h.unlocked).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ broadcastId: BROADCAST, reason: 'whatsapp_number_disconnected' });
    warn.mockRestore();
  });

  it('still throws (and so retries) other broadcast errors', async () => {
    h.planError = new BroadcastError('internal', 'Failed to load recipients', 500);
    await expect(handleJob(job)).rejects.toMatchObject({ code: 'internal' });
    expect(h.unlocked).toBe(1);
  });

  it('sends normally once the number is connected', async () => {
    await handleJob(job);
    expect(h.claimed).toBe(1);
    expect(h.delivered).toBe(1);
  });
});

describe('broadcast.dispatch for one "Retry failed" request (audit finding 11)', () => {
  const RETRY = '33333333-3333-4333-8333-33333333333c';
  const retryJob = { ...job, payload: { broadcastId: BROADCAST, scope: 'failed', retryId: RETRY } } as unknown as Job;
  beforeEach(() => {
    Object.assign(h, { planError: null, claimed: 0, delivered: 0, finalized: 0, unlocked: 0, enqueued: [], steps: [], throttled: false });
  });

  it('applies the retry generation before planning the pass', async () => {
    await handleJob(retryJob);
    expect(h.steps).toEqual([`prepare:${RETRY}`, 'plan']);
    expect(h.delivered).toBe(1);
  });

  it('never applies a retry generation to a Resume of pending recipients', async () => {
    await handleJob({ ...job, payload: { broadcastId: BROADCAST, scope: 'pending', retryId: RETRY } } as unknown as Job);
    expect(h.steps).toEqual(['plan']);
  });

  it('a throttled follow-up pass does not apply the same request again', async () => {
    h.throttled = true;
    await handleJob(retryJob);
    expect(h.enqueued).toHaveLength(1);
    const [, payload] = h.enqueued[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ broadcastId: BROADCAST, scope: 'failed', throttles: 1 });
    expect(payload).not.toHaveProperty('retryId');
  });
});
