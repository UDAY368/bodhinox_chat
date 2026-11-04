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

import {
  dispatchWebhookEvent,
  deliverQueuedWebhook,
  MAX_CONSECUTIVE_FAILURES,
} from './deliver';
import { enqueueJob } from '@/lib/jobs/queue';
vi.mock('@/lib/jobs/queue', () => ({
  enqueueJob: vi.fn(async () => 'queued-job'),
}));
import { isDeliverableUrl } from './ssrf';
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

function makeDb(rows: Row[], calls: Calls) {
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
    return Promise.resolve({ data: null, error: null });
  };
  return { from, rpc } as unknown as DataClient;
}

const emptyCalls = (): Calls => ({ updates: [], rpcs: [] });

beforeEach(() => {
  vi.mocked(enqueueJob).mockClear();
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
  sf.fetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs through safeFetch and resets failure_count on success', async () => {
    const fetchMock = sf.fetch.mockResolvedValue({ ok: true, status: 200, contentType: '', body: '' });
    const calls = emptyCalls();

    await deliverQueuedWebhook(
      makeDb([{ id: 'a', url: 'https://a.test/hook', secret: 's1' }], calls),
      'acct-1',
      {
        endpointId: 'a',
        event: 'message.received',
        payload: JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          data: { x: 1 },
        }),
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.method).toBe('POST');
    // Judged on the status alone: a 200 with a large or slow body is a success.
    expect(fetchMock.mock.calls[0][2]).toEqual({ timeoutMs: 5000, discardBody: true });
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(
      /^t=\d+,v1=[0-9a-f]{64}$/
    );
    // Payload carries a dedupe id.
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);
    expect(calls.updates[0]).toMatchObject({
      id: 'a',
      payload: { failure_count: 0 },
    });
    expect(calls.rpcs).toHaveLength(0);
  });

  it.each([
    ['a 500 reply', { ok: true, status: 500, contentType: '', body: '' }],
    ['a redirect (never followed)', { ok: true, status: 302, contentType: '', body: '' }],
    ['a blocked address at connect time', { ok: false, error: 'blocked' }],
    ['a timeout', { ok: false, error: 'timeout' }],
  ])('records an atomic failure (RPC) on %s', async (_label, result) => {
    sf.fetch.mockResolvedValue(result);
    const calls = emptyCalls();

    await expect(
      deliverQueuedWebhook(
        makeDb([{ id: 'b', url: 'https://b.test/hook', secret: 's2' }], calls),
        'acct-1',
        { endpointId: 'b', event: 'message.received', payload: '{}' }
      )
    ).rejects.toThrow('Webhook delivery failed');

    expect(calls.rpcs[0]).toEqual({
      name: 'record_webhook_failure',
      args: { endpoint_id: 'b', max_failures: MAX_CONSECUTIVE_FAILURES },
    });
    expect(calls.updates).toHaveLength(0);
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = sf.fetch;
    const calls = emptyCalls();

    await expect(
      deliverQueuedWebhook(
        makeDb(
          [{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }],
          calls
        ),
        'acct-1',
        { endpointId: 'c', event: 'message.received', payload: '{}' }
      )
    ).rejects.toThrow('Webhook target unavailable');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs[0].name).toBe('record_webhook_failure');
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();
    await dispatchWebhookEvent(
      makeDb([], calls),
      'acct-1',
      'message.received',
      {}
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });
  it('persists one delivery job per subscriber without dispatching HTTP in the caller', async () => {
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
    expect(jobs[0][2]).toMatchObject({ tenantId: 'acct-1' });
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
        makeDb(
          [{ id: 'a', url: 'https://a.test', secret: 's1' }],
          emptyCalls()
        ),
        'acct-1',
        'message.received',
        {}
      )
    ).rejects.toThrow('Queue unavailable');
  });
});
