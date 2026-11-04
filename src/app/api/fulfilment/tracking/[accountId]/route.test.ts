import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SHIPMENT = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'a'.repeat(43);
const h = vi.hoisted(() => ({
  limited: ((key: string) => key === '') as (key: string) => boolean,
  rateKeys: [] as string[],
  matches: vi.fn(async () => true),
  shipments: [] as { id: string }[],
  claim: vi.fn(async () => ({ id: 'r1', duplicate: false })),
  enqueue: vi.fn(async () => undefined),
  withTenant: vi.fn(),
  order: [] as string[],
  disabled: false,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string) => {
    h.order.push('rate');
    h.rateKeys.push(key);
    return { success: !h.limited(key), remaining: 0, reset: Date.now() + 60_000, limit: 1 };
  },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/fulfilment/connection', () => ({
  courierWebhookTokenMatches: async (...args: unknown[]) => { h.order.push('token'); return (h.matches as (...a: unknown[]) => Promise<boolean>)(...args); },
}));
vi.mock('@/lib/fulfilment/shiprocket-client', () => ({ shiprocketDisabled: () => h.disabled }));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => ({ worker: true }) }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => Promise<unknown>, db: unknown) => {
    h.order.push('db');
    h.withTenant(ctx, db);
    return fn({ $queryRaw: async () => h.shipments });
  },
}));
vi.mock('@/lib/commerce/webhook-receipts', () => ({ claimWebhookReceipt: h.claim }));
vi.mock('@/lib/fulfilment/tracking-job', async (original) => ({
  ...(await original<typeof import('@/lib/fulfilment/tracking-job')>()),
  enqueueShipmentTrack: h.enqueue,
}));

import { POST } from './route';

const push = { awb: 'AWB12345', shipment_status_id: 7, current_timestamp: '23 05 2023 11:43:52', customer_name: 'Asha', customer_phone: '9999999999' };
const call = (body: unknown, headers: Record<string, string> = { 'x-api-key': TOKEN }, account = ACCOUNT) =>
  POST(new Request('http://localhost/x', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    { params: Promise.resolve({ accountId: account }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.limited = () => false;
  h.rateKeys = [];
  h.disabled = false;
  h.matches.mockResolvedValue(true);
  h.shipments = [{ id: SHIPMENT }];
  h.claim.mockResolvedValue({ id: 'r1', duplicate: false });
  h.order = [];
});

describe('POST /api/fulfilment/tracking/[accountId]', () => {
  it('records a minimised receipt and queues one coalesced re-fetch for the shipment found by AWB', async () => {
    const res = await call(push);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(h.withTenant).toHaveBeenCalledWith({ accountId: ACCOUNT }, { worker: true });
    expect(h.claim).toHaveBeenCalledWith(expect.anything(), {
      provider: 'shiprocket', receiptId: expect.stringMatching(new RegExp(`^${ACCOUNT}:[0-9a-f]{64}$`)),
      payload: { awb: 'AWB12345', code: '7', ts: '23 05 2023 11:43:52' },
    });
    expect(JSON.stringify(h.claim.mock.calls)).not.toMatch(/Asha|9999/);
    expect(h.enqueue).toHaveBeenCalledWith(expect.anything(), ACCOUNT, SHIPMENT);
  });

  it('a duplicate delivery queues nothing more', async () => {
    h.claim.mockResolvedValueOnce({ id: 'r1', duplicate: true });
    expect((await call(push)).status).toBe(200);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('wrong token, missing token, not connected and a bad account id are the same 401, with no work', async () => {
    h.matches.mockResolvedValue(false);
    expect((await call(push)).status).toBe(401);
    expect((await call(push, {})).status).toBe(401);
    expect((await call(push, { 'x-api-key': 'short' })).status).toBe(401);
    expect((await call(push, { 'x-api-key': TOKEN }, 'not-a-uuid')).status).toBe(401);
    expect(h.withTenant).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('rate-limits per account after the token check and before any database work', async () => {
    h.limited = (key) => key.startsWith('shipmentTracking:');
    expect((await call(push)).status).toBe(429);
    expect(h.order).toEqual(['token', 'rate']);
    expect(h.rateKeys).toEqual([`shipmentTracking:${ACCOUNT}`]);
  });

  it('a wrong token never spends the workspace budget; failures are charged to the caller IP, which is then blocked', async () => {
    h.matches.mockResolvedValue(false);
    const attacker = { 'x-api-key': TOKEN, 'x-forwarded-for': '203.0.113.9' };
    expect((await call(push, attacker)).status).toBe(401);
    expect((await call(push, { 'x-api-key': 'short', 'x-forwarded-for': '203.0.113.9' })).status).toBe(401);
    expect(h.rateKeys).toEqual(['shipmentTrackingAuthFail:203.0.113.9', 'shipmentTrackingAuthFail:203.0.113.9']);

    // Its failure budget spent: 429, and later attempts stop before the token lookup.
    h.limited = (key) => key.startsWith('shipmentTrackingAuthFail:');
    expect((await call(push, attacker)).status).toBe(429);
    h.order = [];
    expect((await call(push, attacker)).status).toBe(429);
    expect(h.order).toEqual([]);

    // Shiprocket, from another address with the right token, is still served.
    h.limited = () => false;
    h.matches.mockResolvedValue(true);
    h.rateKeys = [];
    expect((await call(push, { 'x-api-key': TOKEN, 'x-forwarded-for': '198.51.100.7' })).status).toBe(200);
    expect(h.rateKeys).toEqual([`shipmentTracking:${ACCOUNT}`]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('with a valid token, an unknown AWB (or another workspace’s) is acknowledged and ignored', async () => {
    h.shipments = [];
    expect((await call(push)).status).toBe(200);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('with a valid token, an unreadable or oversized body is acknowledged and ignored', async () => {
    for (const body of ['not json', JSON.stringify({ awb: 'bad awb!' }), JSON.stringify({ ...push, pad: 'x'.repeat(70 * 1024) })])
      expect((await call(body)).status).toBe(200);
    expect(h.withTenant).not.toHaveBeenCalled();
  });

  it('the kill switch acknowledges without queuing', async () => {
    h.disabled = true;
    expect((await call(push)).status).toBe(200);
    expect(h.withTenant).not.toHaveBeenCalled();
  });

  it('a failure to record answers 500 so the push can be retried', async () => {
    h.claim.mockRejectedValueOnce(new Error('db down'));
    expect((await call(push)).status).toBe(500);
  });
});
