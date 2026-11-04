import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  configured: true,
  limited: new Set<string>(),
  limitKeys: [] as string[],
  tenant: true,
  duplicate: false,
  fail: false,
  receipts: [] as Record<string, unknown>[],
  jobs: [] as unknown[][],
}));

vi.mock('@/lib/meetings/config', () => ({
  zoomConfig: () => (h.configured ? { clientId: 'id', clientSecret: 'cs', webhookSecretToken: 'whsec' } : null),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string) => {
    h.limitKeys.push(key);
    const limited = [...h.limited].some((prefix) => key.startsWith(prefix));
    return { success: !limited, remaining: 0, reset: Date.now() + 1000, limit: 1 };
  },
  rateLimitResponse: () => new Response('limited', { status: 429 }),
}));
vi.mock('@/lib/commerce/webhook-receipts', () => ({
  claimWebhookReceipt: async (_tx: unknown, input: Record<string, unknown>) => {
    h.receipts.push(input);
    return { id: 'r1', duplicate: h.duplicate };
  },
}));
vi.mock('@/lib/db/prisma', () => ({
  getWorkerPrisma: () => ({
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      if (h.fail) throw new Error('db down');
      return work({
        $queryRaw: async () => (h.tenant ? [{ account_id: '11111111-1111-4111-8111-111111111111', connection_id: '22222222-2222-4222-8222-222222222222' }] : []),
        $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => { h.jobs.push(values); return 1; },
      });
    },
  }),
}));

import { POST } from './route';

const ts = () => String(Math.floor(Date.now() / 1000));
function request(body: unknown, opts: { secret?: string; raw?: string; timestamp?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const timestamp = opts.timestamp ?? ts();
  const signature = `v0=${createHmac('sha256', opts.secret ?? 'whsec').update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return new Request('http://x/api/integrations/zoom/webhook', {
    method: 'POST', body: raw, headers: { 'x-zm-request-timestamp': timestamp, 'x-zm-signature': signature, 'content-type': 'application/json' },
  });
}
const joined = {
  event: 'meeting.participant_joined', event_ts: 1762000000000,
  payload: { account_id: 'ZAcct1', object: { id: 123456789, host_id: 'H1',
    participant: { id: 'U9', user_name: 'Asha', email: 'asha@example.com', participant_uuid: 'p-1', join_time: '2026-11-09T10:02:00Z' } } },
};

beforeEach(() => {
  h.configured = true; h.limited = new Set(); h.limitKeys = []; h.tenant = true; h.duplicate = false; h.fail = false; h.receipts = []; h.jobs = [];
});

describe('POST /api/integrations/zoom/webhook', () => {
  it('answers 503 and touches nothing when the deployment has no Zoom config', async () => {
    h.configured = false;
    const res = await POST(request(joined));
    expect(res.status).toBe(503);
    expect(h.limitKeys).toEqual([]);
    expect(h.receipts).toEqual([]);
  });

  it('never spends a rate limit on an unsigned or oversized request', async () => {
    h.limited.add('zoomWebhook:global');
    expect((await POST(request(joined, { secret: 'wrong' }))).status).toBe(401);
    expect((await POST(request(null, { raw: 'x'.repeat(70 * 1024) }))).status).toBe(413);
    expect(h.limitKeys).toEqual([]);
  });

  it('applies the global limit to verified deliveries only', async () => {
    h.limited.add('zoomWebhook:global');
    const res = await POST(request(joined));
    expect(res.status).toBe(429);
    expect(h.limitKeys).toEqual(['zoomWebhook:global']);
    expect(h.receipts).toEqual([]);
  });

  it('refuses a bad signature or a stale timestamp with 401 before parsing', async () => {
    expect((await POST(request(joined, { secret: 'wrong' }))).status).toBe(401);
    expect((await POST(request(joined, { timestamp: String(Math.floor(Date.now() / 1000) - 301) }))).status).toBe(401);
    expect((await POST(request(null, { raw: 'not json', secret: 'wrong' }))).status).toBe(401);
    expect(h.receipts).toEqual([]);
  });

  it('caps the body at 64 KB', async () => {
    const res = await POST(request(null, { raw: JSON.stringify({ event: 'meeting.started', pad: 'x'.repeat(70 * 1024) }) }));
    expect(res.status).toBe(413);
  });

  it('answers endpoint.url_validation with the HMAC of the plain token', async () => {
    const res = await POST(request({ event: 'endpoint.url_validation', payload: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: createHmac('sha256', 'whsec').update('qgg8vlvZRS6UYooatFL8Aw').digest('hex'),
    });
    expect(h.receipts).toEqual([]);
  });

  it('records a verified event once with a minimised job payload, then applies the per-account limit', async () => {
    const res = await POST(request(joined));
    expect(await res.json()).toEqual({ status: 'queued' });
    expect(h.limitKeys).toEqual(['zoomWebhook:global', 'zoomWebhook:account:ZAcct1']);
    expect(h.receipts[0]).toMatchObject({ provider: 'zoom' });
    expect(h.receipts[0].receiptId).toMatch(/^[0-9a-f]{64}$/);
    const [type, tenant, payload, dedupe] = h.jobs[0];
    expect([type, tenant]).toEqual(['meetings.zoom_event', ACCOUNT]);
    expect(dedupe).toBe(`zoom-event:${h.receipts[0].receiptId}`);
    const job = JSON.parse(payload as string);
    expect(job).toMatchObject({ event: 'meeting.participant_joined', meetingId: '123456789', zoomAccountId: 'ZAcct1', connectionId: CONNECTION });
    expect(payload).not.toContain('Asha');
    expect(payload).not.toContain('asha@example.com');
  });

  it('acknowledges a duplicate, an unknown Zoom account or an unsubscribed event without queuing', async () => {
    h.duplicate = true;
    expect(await (await POST(request(joined))).json()).toEqual({ status: 'duplicate' });
    h.duplicate = false; h.tenant = false;
    expect(await (await POST(request(joined))).json()).toEqual({ status: 'ignored' });
    h.tenant = true;
    expect(await (await POST(request({ ...joined, event: 'meeting.created' }))).json()).toEqual({ status: 'ignored' });
    expect(h.jobs).toEqual([]);
  });

  it('applies the per-Zoom-account limit after verification', async () => {
    h.limited.add('zoomWebhook:account:');
    expect((await POST(request(joined))).status).toBe(429);
    expect(h.receipts).toEqual([]);
  });

  it('answers 500 when the delivery cannot be recorded, so Zoom retries', async () => {
    h.fail = true;
    expect((await POST(request(joined))).status).toBe(500);
  });
});
