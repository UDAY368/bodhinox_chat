import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' };
const ID = '55555555-5555-4555-8555-555555555555';
const REQ = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  visible: true,
  reconcile: vi.fn(),
  cancel: vi.fn(),
  send: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) => Response.json({ error: 'x' }, { status: (e as { status?: number })?.status ?? 500 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/jobs/dispatch', () => ({ UncertainDispatchError: class UncertainDispatchError extends Error {} }));
vi.mock('@/lib/payments/links', async (orig) => {
  const real = await orig<typeof import('@/lib/payments/links')>();
  return {
    ...real,
    getPaymentLink: async (_tx: unknown, accountId: string, id: string) =>
      h.visible && accountId === ctx.accountId && id === ID ? { id: ID, status: 'created', short_url: 'https://rzp.io/l/abc' } : null,
    reconcilePaymentLink: h.reconcile,
    cancelPaymentLinkRecord: h.cancel,
    sendPaymentLinkMessage: h.send,
  };
});
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: true }), rateLimitResponse: () => Response.json({}, { status: 429 }) }));

import { PaymentLinkError } from '@/lib/payments/links';
import { GET, POST } from './route';

const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const act = (body: unknown, id = ID) => POST(new Request(`http://localhost/api/payments/links/${id}`, { method: 'POST', body: JSON.stringify(body) }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  h.visible = true;
  h.requireRole.mockResolvedValue(ctx);
});

it('shows one link to agents; anything not visible is 404', async () => {
  const res = await GET(new Request('http://localhost/x'), params());
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith('agent');
  expect(await res.json()).toMatchObject({ link: { id: ID } });
  expect((await GET(new Request('http://localhost/x'), params('nope'))).status).toBe(404);
  h.visible = false;
  expect((await GET(new Request('http://localhost/x'), params())).status).toBe(404);
});

it('refuses viewers before any action', async () => {
  h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }));
  expect((await act({ action: 'reconcile' })).status).toBe(403);
  expect(h.reconcile).not.toHaveBeenCalled();
});

it('only acts on a link the caller can see', async () => {
  h.visible = false;
  expect((await act({ action: 'cancel' })).status).toBe(404);
  expect(h.cancel).not.toHaveBeenCalled();
});

it('reconciles and cancels through the library', async () => {
  h.reconcile.mockResolvedValueOnce({ link: { id: ID, status: 'paid' }, changed: true });
  expect(await (await act({ action: 'reconcile' })).json()).toEqual({ link: { id: ID, status: 'paid' }, changed: true });
  expect(h.reconcile).toHaveBeenCalledWith(ctx.accountId, ID);
  h.cancel.mockResolvedValueOnce({ id: ID, status: 'cancelled' });
  expect(await (await act({ action: 'cancel' })).json()).toEqual({ link: { id: ID, status: 'cancelled' } });
});

it('turns library refusals into their status and code', async () => {
  h.reconcile.mockRejectedValueOnce(new PaymentLinkError('busy'));
  const busy = await act({ action: 'reconcile' });
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ code: 'busy' });
  h.cancel.mockRejectedValueOnce(new PaymentLinkError('not_cancellable'));
  expect((await act({ action: 'cancel' })).status).toBe(409);
  h.reconcile.mockRejectedValueOnce(new PaymentLinkError('provider_unreachable'));
  expect((await act({ action: 'reconcile' })).status).toBe(502);
});

it('re-sends a link with a request id, once per id', async () => {
  expect((await act({ action: 'send' })).status).toBe(400);
  h.send.mockResolvedValueOnce({ whatsappMessageId: 'w', messageId: 'm' });
  const res = await act({ action: 'send', message: 'Pay', client_request_id: REQ });
  expect(res.status).toBe(200);
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ linkId: ID, message: 'Pay', intentKey: `payment-link:${ID}:send:${REQ}` }));
  h.send.mockRejectedValueOnce(new PaymentLinkError('window_closed'));
  const refused = await act({ action: 'send', client_request_id: REQ });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ send: { status: 'refused', code: 'window_closed' } });
});

it('rejects unknown actions and bad bodies', async () => {
  expect((await act({ action: 'mark_paid' })).status).toBe(400);
  expect((await POST(new Request('http://localhost/x', { method: 'POST', body: '[' }), params())).status).toBe(400);
});
