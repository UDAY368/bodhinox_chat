import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DataClient } from '@/lib/data/types';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (s: string) => s,
  encrypt: (s: string) => s,
}));

// Control the SSRF guard per-test.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

// The disable notice runs on the worker connection inside withTenant.
const tenant = vi.hoisted(() => ({
  contexts: [] as unknown[],
  sql: [] as string[],
  params: [] as unknown[][],
  fail: false,
  recipients: [] as { user_id: string; in_app: boolean; email: boolean }[],
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker-prisma' }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown, db: unknown) => {
    if (tenant.fail) throw new Error('database unavailable');
    tenant.contexts.push({ ctx, db });
    const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
      tenant.sql.push(strings.join('?'));
      tenant.params.push(values);
    };
    return fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        record(strings, ...values);
        const sql = strings.join('?');
        if (sql.includes('disabled_at')) return [{ epoch: '1762770000' }];
        if (sql.includes('FROM account_memberships m')) return tenant.recipients;
        if (sql.includes('FROM account_memberships')) return tenant.recipients.map(({ user_id }) => ({ user_id }));
        return [];
      },
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        record(strings, ...values);
        return 2;
      },
    });
  },
}));

import {
  dispatchWebhookEvent,
  deliverQueuedWebhook,
  errorCode,
  DISABLE_AFTER_FAILING_MINUTES,
  MIN_FAILURES_BEFORE_DISABLE,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS,
} from './deliver';
import { enqueueJob } from '@/lib/jobs/queue';
vi.mock('@/lib/jobs/queue', () => ({
  enqueueJob: vi.fn(async () => 'queued-job'),
}));
import { isDeliverableUrl } from './ssrf';
import { retryDecision } from '@/lib/jobs/retry';
// Delivery goes through safeFetch (pinned DNS, no redirects, size and time caps).
const sf = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/webhooks/safe-fetch', () => ({ safeFetch: sf.fetch }));

interface Row {
  id: string;
  url: string;
  secret: string;
}
interface Calls {
  updates: { id: string; payload: Record<string, unknown> }[];
  rpcs: { name: string; args: Record<string, unknown> }[];
}

function makeDb(rows: Row[], calls: Calls, rpcResult: unknown = false) {
  const from = () => {
    let mode: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    let id: string | null = null;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: string) => {
        if (col === 'id') id = val;
        return b;
      },
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return b;
      },
      contains: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update' && id) calls.updates.push({ id, payload });
        return resolve({ data: null, error: null });
      },
    };
    return b;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.rpcs.push({ name, args });
    return Promise.resolve({ data: rpcResult, error: null });
  };
  return { from, rpc } as unknown as DataClient;
}

const emptyCalls = (): Calls => ({ updates: [], rpcs: [] });
const DELIVERY_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.mocked(enqueueJob).mockClear();
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
  sf.fetch.mockReset();
  tenant.contexts = [];
  tenant.sql = [];
  tenant.params = [];
  tenant.fail = false;
  tenant.recipients = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('deliverQueuedWebhook', () => {
  it('signs + POSTs through safeFetch and logs a delivered attempt that clears the streak', async () => {
    const fetchMock = sf.fetch.mockResolvedValue({ ok: true, status: 200, contentType: '', body: '' });
    const calls = emptyCalls();

    await deliverQueuedWebhook(
      makeDb([{ id: 'a', url: 'https://a.test/hook', secret: 's1' }], calls),
      'acct-1',
      {
        endpointId: 'a',
        event: 'message.received',
        payload: JSON.stringify({ id: DELIVERY_ID, data: { x: 1 } }),
      },
      3
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.method).toBe('POST');
    // Judged on the status alone: a 200 with a large or slow body is a success.
    expect(fetchMock.mock.calls[0][2]).toEqual({ timeoutMs: 5000, discardBody: true });
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(opts.body).id).toBe(DELIVERY_ID);
    expect(calls.rpcs).toEqual([
      {
        name: 'record_webhook_attempt',
        args: {
          p_endpoint_id: 'a',
          p_event: 'message.received',
          p_delivery_id: DELIVERY_ID,
          p_attempt: 3,
          p_delivered: true,
          p_http_status: 200,
          p_error: null,
          p_min_failures: MIN_FAILURES_BEFORE_DISABLE,
          p_disable_after_minutes: DISABLE_AFTER_FAILING_MINUTES,
        },
      },
    ]);
    expect(calls.updates).toHaveLength(0);
    expect(tenant.sql).toEqual([]);
  });

  it.each([
    ['a 500 reply', { ok: true, status: 500, contentType: '', body: '' }, 500, 'http_status'],
    ['a redirect (never followed)', { ok: true, status: 302, contentType: '', body: '' }, 302, 'http_status'],
    ['a blocked address at connect time', { ok: false, error: 'blocked' }, 0, 'blocked'],
    ['a timeout', { ok: false, error: 'timeout' }, 0, 'timeout'],
  ])('logs a failed attempt (one atomic RPC, codes only) on %s and throws so the queue retries', async (_label, result, status, code) => {
    sf.fetch.mockResolvedValue(result);
    const calls = emptyCalls();

    await expect(
      deliverQueuedWebhook(
        makeDb([{ id: 'b', url: 'https://b.test/hook', secret: 's2' }], calls),
        'acct-1',
        { endpointId: 'b', event: 'message.received', payload: '{}' }
      )
    ).rejects.toThrow('Webhook delivery failed');

    expect(calls.rpcs).toHaveLength(1);
    expect(calls.rpcs[0]).toMatchObject({
      name: 'record_webhook_attempt',
      args: { p_endpoint_id: 'b', p_attempt: 1, p_delivered: false, p_http_status: status, p_error: code, p_delivery_id: null },
    });
    // Not disabled by this attempt: no notice.
    expect(tenant.sql).toEqual([]);
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const calls = emptyCalls();

    await expect(
      deliverQueuedWebhook(
        makeDb([{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }], calls),
        'acct-1',
        { endpointId: 'c', event: 'message.received', payload: '{}' }
      )
    ).rejects.toThrow('Webhook target unavailable');

    expect(sf.fetch).not.toHaveBeenCalled();
    expect(calls.rpcs[0].args).toMatchObject({ p_delivered: false, p_error: 'blocked_target' });
  });

  it('notifies the owners and admins (their webhook_disabled preference decides in-app and email) when this attempt switched the endpoint off', async () => {
    const OWNER = '33333333-3333-4333-8333-333333333333';
    const ADMIN = '44444444-4444-4444-8444-444444444444';
    tenant.recipients = [
      { user_id: OWNER, in_app: true, email: false },
      { user_id: ADMIN, in_app: true, email: true },
    ];
    sf.fetch.mockResolvedValue({ ok: false, error: 'timeout' });
    const calls = emptyCalls();
    await expect(
      deliverQueuedWebhook(
        makeDb([{ id: 'd', url: 'https://hooks.example.test/x?token=secret', secret: 's4' }], calls, true),
        '22222222-2222-4222-8222-222222222222',
        { endpointId: 'd', event: 'message.received', payload: '{}' },
        10
      )
    ).rejects.toThrow('Webhook delivery failed');

    expect(tenant.contexts).toEqual([
      { ctx: { accountId: '22222222-2222-4222-8222-222222222222', role: 'owner' }, db: 'worker-prisma' },
    ]);
    expect(tenant.sql.some((sql) => /FROM account_memberships\s+WHERE [\s\S]*role IN \('owner','admin'\)/.test(sql))).toBe(true);
    // The preference lookup is for the webhook_disabled event.
    const lookup = tenant.sql.findIndex((sql) => sql.includes('LEFT JOIN notification_preferences'));
    expect(tenant.params[lookup]).toContain('webhook_disabled');
    const inserts = tenant.sql.flatMap((sql, i) => (sql.includes('INSERT INTO notifications(') ? [i] : []));
    expect(inserts).toHaveLength(2);
    const values = tenant.params[inserts[0]].map(String);
    expect(values).toContain('webhook_disabled');
    // The host names the endpoint; the path and query (which may carry a token) never appear.
    expect(values.some((v) => v.includes('hooks.example.test') && v.includes('switched off'))).toBe(true);
    expect(values.some((v) => v.includes('24 hours'))).toBe(true);
    expect(values.some((v) => v.includes('token=secret'))).toBe(false);
    expect(values).toContain('/settings?tab=api');
    // One notice per disable: the dedupe key carries the disable time.
    expect(values).toContain('webhook-disabled:d:1762770000');
    // The admin who opted into email gets a digest entry; the owner does not.
    const emails = tenant.sql.flatMap((sql, i) => (sql.includes('INSERT INTO notification_email_queue') ? [i] : []));
    expect(emails).toHaveLength(1);
    expect(tenant.params[emails[0]]).toEqual(expect.arrayContaining([ADMIN, 'webhook_disabled']));
  });

  it('still throws for retry when the notice cannot be written', async () => {
    sf.fetch.mockResolvedValue({ ok: false, error: 'timeout' });
    const db = makeDb([{ id: 'e', url: 'https://e.test/hook', secret: 's5' }], emptyCalls(), true);
    tenant.fail = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      deliverQueuedWebhook(db, 'acct-1', { endpointId: 'e', event: 'message.received', payload: '{}' })
    ).rejects.toThrow('Webhook delivery failed');
    // Ids only in the log line: no URL or payload.
    expect(errors.mock.calls.flat().join(' ')).not.toContain('e.test');
    errors.mockRestore();
  });

  it('skips an endpoint that is no longer active without sending or logging', async () => {
    const calls = emptyCalls();
    await deliverQueuedWebhook(makeDb([], calls), 'acct-1', { endpointId: 'z', event: 'message.received', payload: '{}' });
    expect(sf.fetch).not.toHaveBeenCalled();
    expect(calls.rpcs).toHaveLength(0);
  });
});

describe('failure policy', () => {
  it('cannot disable an endpoint within one event: retries outlast a short outage and the disable needs a day', () => {
    // The queue's backoff over every retry of one event (2 s, 4 s, ... capped at 5 min).
    let spanMs = 0;
    for (let attempts = 1; attempts < WEBHOOK_DELIVERY_MAX_ATTEMPTS; attempts++)
      spanMs += retryDecision({ attempts, maxAttempts: WEBHOOK_DELIVERY_MAX_ATTEMPTS, uncertain: false }).delayMs;
    expect(spanMs).toBeGreaterThan(10 * 60_000);
    expect(spanMs).toBeLessThan(DISABLE_AFTER_FAILING_MINUTES * 60_000);
    expect(DISABLE_AFTER_FAILING_MINUTES).toBeGreaterThanOrEqual(24 * 60);
    expect(MIN_FAILURES_BEFORE_DISABLE).toBeGreaterThan(WEBHOOK_DELIVERY_MAX_ATTEMPTS);
  });

  it('turns any transport error into a short code the log accepts', () => {
    expect(errorCode('ECONNRESET: socket hang up')).toBe('econnreset_socket_hang_up');
    expect(errorCode(undefined)).toBe('unreachable');
    expect(errorCode('x'.repeat(200))).toHaveLength(64);
  });
});

describe('dispatchWebhookEvent', () => {
  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();
    await dispatchWebhookEvent(makeDb([], calls), 'acct-1', 'message.received', {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });
  it('persists one delivery job per subscriber, with the longer retry budget, without dispatching HTTP in the caller', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();
    await dispatchWebhookEvent(
      makeDb(
        [
          { id: 'a', url: 'https://a.test', secret: 's1' },
          { id: 'b', url: 'https://b.test', secret: 's2' },
        ],
        calls
      ),
      'acct-1',
      'message.received',
      { x: 1 }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const jobs = vi.mocked(enqueueJob).mock.calls;
    expect(jobs).toHaveLength(2);
    expect(jobs[0][0]).toBe('webhook.delivery');
    expect(jobs[0][2]).toMatchObject({ tenantId: 'acct-1', maxAttempts: WEBHOOK_DELIVERY_MAX_ATTEMPTS });
    const payload = JSON.parse(jobs[0][1].payload as string);
    expect(payload).toMatchObject({
      event: 'message.received',
      account_id: 'acct-1',
      data: { x: 1 },
    });
    expect(JSON.parse(jobs[1][1].payload as string).id).toBe(payload.id);
  });
  it('propagates queue persistence failure so durable processing can retry', async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error('Queue unavailable'));
    await expect(
      dispatchWebhookEvent(
        makeDb([{ id: 'a', url: 'https://a.test', secret: 's1' }], emptyCalls()),
        'acct-1',
        'message.received',
        {}
      )
    ).rejects.toThrow('Queue unavailable');
  });
});

describe('dispatchWebhookEvent channels (Stage 2)', () => {
  const CONV = '33333333-3333-4333-8333-333333333333';
  // Endpoints as stored: an existing one (default {whatsapp}), an Instagram-only one and one with both.
  const endpoints = [
    { id: 'wa', url: 'https://wa.test', secret: 's', channels: ['whatsapp'] },
    { id: 'ig', url: 'https://ig.test', secret: 's', channels: ['instagram'] },
    { id: 'both', url: 'https://both.test', secret: 's', channels: ['whatsapp', 'instagram'] },
  ];
  function channelDb(conversation: { channel?: string | null } | null | Error) {
    const reads: string[] = [];
    const from = (table: string) => {
      reads.push(table);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        contains: () => Promise.resolve({ data: endpoints, error: null }),
        maybeSingle: () => Promise.resolve(conversation instanceof Error
          ? { data: null, error: { message: 'down' } }
          : { data: conversation, error: null }),
      };
      return b;
    };
    return { db: { from, rpc: vi.fn() } as unknown as DataClient, reads };
  }
  const delivered = () => vi.mocked(enqueueJob).mock.calls.map((call) => (call[1] as { endpointId: string }).endpointId);
  const envelope = () => JSON.parse((vi.mocked(enqueueJob).mock.calls[0][1] as { payload: string }).payload);

  it('never sends an Instagram event to an endpoint that did not opt into Instagram', async () => {
    const { db, reads } = channelDb(null);
    await dispatchWebhookEvent(db, 'acct-1', 'message.received', { conversation_id: CONV }, { channel: 'instagram' });
    expect(delivered()).toEqual(['ig', 'both']);
    expect(envelope()).toMatchObject({ event: 'message.received', channel: 'instagram' });
    // The caller named the channel: no conversation lookup.
    expect(reads).toEqual(['webhook_endpoints']);
  });

  it('keeps WhatsApp events on WhatsApp endpoints, reading the channel from the conversation', async () => {
    const { db, reads } = channelDb({ channel: 'whatsapp' });
    await dispatchWebhookEvent(db, 'acct-1', 'message.status_updated', { conversation_id: CONV, status: 'read' });
    expect(delivered()).toEqual(['wa', 'both']);
    expect(envelope().channel).toBe('whatsapp');
    expect(reads).toEqual(['webhook_endpoints', 'conversations']);
  });

  it('routes an event about an Instagram conversation (flow.completed) by its stored channel', async () => {
    const { db } = channelDb({ channel: 'instagram' });
    await dispatchWebhookEvent(db, 'acct-1', 'flow.completed', { conversation_id: CONV, flow_run_id: 'r' });
    expect(delivered()).toEqual(['ig', 'both']);
  });

  it('treats a legacy null channel and an event without a conversation as WhatsApp', async () => {
    await dispatchWebhookEvent(channelDb({ channel: null }).db, 'acct-1', 'conversation.created', { conversation_id: CONV });
    expect(delivered()).toEqual(['wa', 'both']);
    vi.mocked(enqueueJob).mockClear();
    const { db, reads } = channelDb(null);
    await dispatchWebhookEvent(db, 'acct-1', 'flow.completed', { conversation_id: null });
    expect(delivered()).toEqual(['wa', 'both']);
    expect(reads).toEqual(['webhook_endpoints']);
  });

  it('sends WhatsApp-only events to WhatsApp endpoints and business events to every endpoint', async () => {
    await dispatchWebhookEvent(channelDb(null).db, 'acct-1', 'broadcast.completed', { broadcast_id: 'b' }, { channel: 'instagram' });
    expect(delivered()).toEqual(['wa', 'both']);
    vi.mocked(enqueueJob).mockClear();
    await dispatchWebhookEvent(channelDb(null).db, 'acct-1', 'order.paid', { order_id: 'o', conversation_id: CONV });
    expect(delivered()).toEqual(['wa', 'ig', 'both']);
    expect(envelope()).not.toHaveProperty('channel');
  });

  it('fails closed when the conversation channel cannot be read', async () => {
    await expect(dispatchWebhookEvent(channelDb(new Error('down')).db, 'acct-1', 'message.received', { conversation_id: CONV }))
      .rejects.toThrow('Webhook channel lookup failed');
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
