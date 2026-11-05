import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' };
const CONV = '33333333-3333-4333-8333-333333333333';
const REQ = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  create: vi.fn(),
  list: vi.fn(async () => [] as unknown[]),
  send: vi.fn(),
  limited: new Set<string>(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) => Response.json({ error: 'Forbidden' }, { status: (e as { status?: number })?.status ?? 500 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/jobs/dispatch', () => ({ UncertainDispatchError: class UncertainDispatchError extends Error {} }));
vi.mock('@/lib/payments/links', async (orig) => {
  const real = await orig<typeof import('@/lib/payments/links')>();
  return { ...real, createPaymentLinkRecord: h.create, listPaymentLinks: h.list, sendPaymentLinkMessage: h.send };
});
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (key: string) => ({ success: ![...h.limited].some((k) => key.startsWith(k)) }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { requestPaymentReference } from '@/lib/payments/links';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { GET, POST } from './route';

const link = (status = 'created') => ({ id: '55555555-5555-4555-8555-555555555555', status, short_url: status === 'created' ? 'https://rzp.io/l/abc' : null, amount_minor: 49950, currency: 'INR' });
const post = (body: unknown) => POST(new Request('http://localhost/api/payments/links', { method: 'POST', body: JSON.stringify(body) }));
const valid = { amount: '499.50', currency: 'inr', client_request_id: REQ };

beforeEach(() => {
  vi.clearAllMocks();
  h.limited.clear();
  h.requireRole.mockResolvedValue(ctx);
  h.create.mockResolvedValue({ link: link(), outcome: 'created' });
});

it('creates a link for agents and above, keyed by the request id', async () => {
  const res = await post({ ...valid, description: 'Order 7', conversation_id: CONV, expire_minutes: 60 });
  expect(res.status).toBe(201);
  expect(h.requireRole).toHaveBeenCalledWith('agent');
  const input = h.create.mock.calls[0][0];
  expect(input).toMatchObject({
    accountId: ctx.accountId, actor: { kind: 'agent', userId: ctx.userId, role: 'agent' }, amountMinor: 49950, currency: 'INR',
    description: 'Order 7', conversationId: CONV, referenceId: requestPaymentReference(ctx.accountId, ctx.userId, REQ),
  });
  expect(input.expireBy.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
  expect(await res.json()).toMatchObject({ link: { id: link().id }, outcome: 'created', send: null });
});

it('refuses viewers', async () => {
  h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }));
  expect((await post(valid)).status).toBe(403);
  expect(h.create).not.toHaveBeenCalled();
});

it('returns the stored link for a replayed request id with 200', async () => {
  h.create.mockResolvedValueOnce({ link: link(), outcome: 'existing' });
  expect((await post(valid)).status).toBe(200);
});

it('checks input before anything reaches Razorpay', async () => {
  for (const body of [
    { ...valid, client_request_id: undefined },
    { ...valid, amount: '12.345' },
    { ...valid, amount: '-5' },
    { ...valid, amount: undefined },
    { ...valid, expire_minutes: 5 },
    { ...valid, description: 'x'.repeat(2049) },
    { ...valid, send: true },
    { ...valid, conversation_id: CONV, send: true, message: 'x'.repeat(901) },
  ]) {
    expect((await post(body)).status).toBe(400);
  }
  expect((await post({ ...valid, conversation_id: 'nope' })).status).toBe(404);
  expect(h.create).not.toHaveBeenCalled();
});

it('is rate limited per agent and per workspace', async () => {
  h.limited.add('paymentLink:');
  expect((await post(valid)).status).toBe(429);
  h.limited.clear();
  h.limited.add('paymentLinkAccount:');
  expect((await post(valid)).status).toBe(429);
  expect(h.create).not.toHaveBeenCalled();
});

it('reports a provider refusal as 502 with the failed link', async () => {
  h.create.mockResolvedValueOnce({ link: link('failed'), outcome: 'rejected', reason: 'invalid_request' });
  const res = await post(valid);
  expect(res.status).toBe(502);
  expect(await res.json()).toMatchObject({ code: 'provider_rejected', link: { status: 'failed' } });
});

it('sends the created link into the conversation once per request id', async () => {
  h.send.mockResolvedValueOnce({ whatsappMessageId: 'wamid.1', messageId: 'm1' });
  const res = await post({ ...valid, conversation_id: CONV, send: true, message: 'Pay here' });
  expect(h.send).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, role: 'agent', linkId: link().id, message: 'Pay here', intentKey: `payment-link:${link().id}:send:${REQ}`, manual: true });
  expect(await res.json()).toMatchObject({ send: { status: 'sent', message_id: 'm1' } });

  h.send.mockRejectedValueOnce(new UncertainDispatchError());
  expect(await (await post({ ...valid, conversation_id: CONV, send: true })).json()).toMatchObject({ send: { status: 'uncertain' } });
});

it('does not send a link whose create outcome is still unknown', async () => {
  h.create.mockResolvedValueOnce({ link: link('unknown'), outcome: 'unknown' });
  const res = await post({ ...valid, conversation_id: CONV, send: true });
  expect(res.status).toBe(201);
  expect(h.send).not.toHaveBeenCalled();
  expect(await res.json()).toMatchObject({ outcome: 'unknown', send: null });
});

it('lists links for agents with validated filters', async () => {
  h.list.mockResolvedValueOnce([link()]);
  const res = await GET(new Request(`http://localhost/api/payments/links?status=paid&conversation_id=${CONV}&limit=10`));
  expect(res.status).toBe(200);
  expect(h.list).toHaveBeenCalledWith({}, ctx.accountId, expect.objectContaining({ status: 'paid', conversationId: CONV, limit: 10 }));
  expect((await GET(new Request('http://localhost/api/payments/links?status=bogus'))).status).toBe(400);
  expect((await GET(new Request('http://localhost/api/payments/links?order_id=x'))).status).toBe(400);
  expect((await GET(new Request('http://localhost/api/payments/links?before=nope'))).status).toBe(400);
});
