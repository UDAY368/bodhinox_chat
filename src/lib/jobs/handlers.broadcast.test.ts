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
  stopped: false,
  channel: 'whatsapp' as 'whatsapp' | 'instagram',
  igPass: { sent: 1, failed: 0, remaining: 0, stopped: false },
  igCalls: [] as unknown[][],
  timedOut: false,
  deliverOptions: null as null | Record<string, unknown>,
  windowWaits: [] as unknown[][],
  outsideWindow: false,
}));

vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({}) }));
vi.mock('@/lib/data/admin', () => ({ createAdminClient: () => ({}) }));
vi.mock('./scope', () => ({ withJobScope: (_scope: unknown, fn: () => unknown) => fn() }));
vi.mock('./queue', () => ({ enqueueJob: async (...args: unknown[]) => { h.enqueued.push(args); return 'job-2'; } }));
vi.mock('@/lib/whatsapp/process-webhook', () => ({ processWebhook: vi.fn(), processInboundActions: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({ expireAwaitingReplies: vi.fn(), resumePendingExecution: vi.fn() }));
vi.mock('./scheduled-audience', () => ({ executeScheduledOccurrence: vi.fn(), queueScheduledOccurrence: vi.fn(), recordSkippedOccurrence: vi.fn(), ScheduledAudienceError: class extends Error {} }));
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
vi.mock('@/lib/broadcasts/pause', () => ({ broadcastHalted: async () => false }));
vi.mock('@/lib/broadcasts/send-window', () => ({
  requeueForSendWindow: async (...args: unknown[]) => { h.windowWaits.push(args); return h.outsideWindow; },
}));
vi.mock('@/lib/broadcasts/instagram', () => ({
  broadcastChannel: async () => h.channel,
  deliverInstagramBroadcast: async (...args: unknown[]) => { h.igCalls.push(args); return h.igPass; },
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
    deliverBroadcast: async (_db: unknown, _plan: unknown, options: Record<string, unknown>) => {
      h.delivered += 1;
      h.deliverOptions = options;
      if (h.timedOut) return { sent: 3, throttled: false, timedOut: true };
      if (h.stopped) return { sent: 0, throttled: false, stopped: true };
      return h.throttled ? { sent: 0, throttled: true } : { sent: 1, throttled: false };
    },
    finalizeBroadcastStatus: async () => { h.finalized += 1; },
  };
});

import { handleJob } from './handlers';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import type { Job } from './queue';

const ACCOUNT = '11111111-1111-4111-8111-11111111111a';
const BROADCAST = '22222222-2222-4222-8222-22222222222b';
/** Every describe resets every field, so no test inherits another block's state. */
function reset() {
  Object.assign(h, {
    planError: null, claimed: 0, delivered: 0, finalized: 0, unlocked: 0, enqueued: [], steps: [], throttled: false, stopped: false,
    channel: 'whatsapp', igPass: { sent: 1, failed: 0, remaining: 0, stopped: false }, igCalls: [], timedOut: false, deliverOptions: null,
    windowWaits: [], outsideWindow: false,
  });
}
const job = { id: 'job-1', type: 'broadcast.dispatch', tenant_id: ACCOUNT, payload: { broadcastId: BROADCAST, scope: 'pending' } } as unknown as Job;

describe('broadcast.dispatch on a disconnected number', () => {
  beforeEach(reset);

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
  beforeEach(reset);

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

describe('broadcast.dispatch pause and Instagram campaigns', () => {
  beforeEach(reset);

  it('a paused WhatsApp pass queues no follow-up and leaves the status alone', async () => {
    h.stopped = true;
    await handleJob(job);
    expect(h.delivered).toBe(1);
    expect(h.enqueued).toEqual([]);
    expect(h.finalized).toBe(0);
    expect(h.unlocked).toBe(1);
  });

  it('an Instagram campaign never plans a WhatsApp template pass', async () => {
    h.channel = 'instagram';
    await handleJob(job);
    expect(h.steps).toEqual([]);
    expect(h.delivered).toBe(0);
    expect(h.igCalls).toHaveLength(1);
    expect(h.igCalls[0].slice(0, 3)).toEqual([ACCOUNT, BROADCAST, 'pending']);
    expect(h.claimed).toBe(1);
    expect(h.finalized).toBe(1);
    expect(h.unlocked).toBe(1);
  });

  it('an Instagram backlog queues the next pass; a paused one does not settle', async () => {
    h.channel = 'instagram';
    h.igPass = { sent: 1000, failed: 0, remaining: 5, stopped: false };
    await handleJob(job);
    expect(h.enqueued).toHaveLength(1);
    const [type, payload] = h.enqueued[0] as [string, Record<string, unknown>];
    expect(type).toBe('broadcast.dispatch');
    expect(payload).toEqual({ broadcastId: BROADCAST, scope: 'pending' });
    h.enqueued = []; h.finalized = 0;
    h.igPass = { sent: 3, failed: 0, remaining: 7, stopped: true };
    await handleJob(job);
    expect(h.enqueued).toEqual([]);
    expect(h.finalized).toBe(0);
  });
});

describe('broadcast.dispatch time box (batch 5)', () => {
  beforeEach(reset);

  it('gives a pending pass about 30 s and queues the next pass when it runs out, after the lock is released', async () => {
    h.timedOut = true;
    const before = Date.now();
    await handleJob(job);
    const deadline = h.deliverOptions?.deadline as number;
    expect(deadline).toBeGreaterThanOrEqual(before + 30_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(h.enqueued).toHaveLength(1);
    const [type, payload, options] = h.enqueued[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(type).toBe('broadcast.dispatch');
    expect(payload).toMatchObject({ broadcastId: BROADCAST, scope: 'pending', throttles: 0 });
    expect(options).toMatchObject({ tenantId: ACCOUNT, requeueCompleted: true, dedupeKey: `broadcast:${BROADCAST}:next:job-1` });
    expect((options.runAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(h.unlocked).toBe(1);
  });

  it('never cuts a Retry failed pass (its rows would be picked again)', async () => {
    await handleJob({ ...job, payload: { broadcastId: BROADCAST, scope: 'failed' } } as unknown as Job);
    expect(h.deliverOptions?.deadline).toBeUndefined();
    h.channel = 'instagram';
    await handleJob({ ...job, payload: { broadcastId: BROADCAST, scope: 'all' } } as unknown as Job);
    expect((h.igCalls[0][3] as Record<string, unknown>).deadline).toBeUndefined();
  });

  it('gives an Instagram pending pass the same budget', async () => {
    h.channel = 'instagram';
    await handleJob(job);
    expect((h.igCalls[0][3] as Record<string, unknown>).deadline).toEqual(expect.any(Number));
  });
});

describe('broadcast.dispatch quiet hours (send window)', () => {
  beforeEach(reset);

  it('outside the window the pass sends nothing, takes no lock and waits in one requeued job', async () => {
    h.outsideWindow = true;
    await handleJob(job);
    expect(h.windowWaits).toEqual([[ACCOUNT, BROADCAST, { broadcastId: BROADCAST, scope: 'pending' }, 'job-1']]);
    expect(h.delivered).toBe(0);
    expect(h.claimed).toBe(0);
    expect(h.unlocked).toBe(0);
  });

  it('a pass stopped mid-way asks the window to requeue the rest, without the applied retry id', async () => {
    h.stopped = true;
    await handleJob({ ...job, payload: { broadcastId: BROADCAST, scope: 'failed', retryId: '33333333-3333-4333-8333-33333333333c' } } as unknown as Job);
    expect(h.delivered).toBe(1);
    expect(h.windowWaits).toHaveLength(2);
    expect(h.windowWaits[1]).toEqual([ACCOUNT, BROADCAST, { broadcastId: BROADCAST, scope: 'failed' }, 'job-1']);
    expect(h.finalized).toBe(0);
  });

  it('a stopped Instagram pass asks the window to requeue the rest and does not settle', async () => {
    h.channel = 'instagram';
    h.igPass = { sent: 2, failed: 0, remaining: 4, stopped: true };
    await handleJob(job);
    expect(h.windowWaits).toEqual([
      [ACCOUNT, BROADCAST, { broadcastId: BROADCAST, scope: 'pending' }, 'job-1'],
      [ACCOUNT, BROADCAST, { broadcastId: BROADCAST, scope: 'pending' }, 'job-1'],
    ]);
    expect(h.enqueued).toEqual([]);
    expect(h.finalized).toBe(0);
    expect(h.unlocked).toBe(1);
  });
});
