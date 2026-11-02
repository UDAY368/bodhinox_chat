import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const h = vi.hoisted(() => ({ role: 'agent', limited: false, send: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { send: { limit: 60, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/commerce/catalog-send', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/catalog-send')>()),
  sendCommerceMessage: h.send,
}));

import { CommerceSendError } from '@/lib/commerce/catalog-send';
import { UncertainDispatchError } from '@/lib/jobs/dispatch';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { POST } from './route';

const post = (body: unknown) => POST(new Request('http://localhost/api/whatsapp/send-product', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
}));
const product = { conversation_id: CONVERSATION, kind: 'product', product_id: PRODUCT, client_request_id: REQUEST_ID };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.limited = false;
  h.send.mockResolvedValue({ whatsappMessageId: 'wamid.1', messageId: 'm1' });
});

it('sends as the agent through one outbound intent per client request', async () => {
  const res = await post(product);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ success: true, message_id: 'm1', whatsapp_message_id: 'wamid.1' });
  expect(h.send).toHaveBeenCalledWith({
    accountId: ACCOUNT, userId: USER, role: 'agent', sender: 'agent', conversationId: CONVERSATION,
    message: { kind: 'product', product: { id: PRODUCT }, body: undefined, footer: undefined },
    intentKey: `commerce:inbox:${CONVERSATION}:${REQUEST_ID}`,
  });
});

it('refuses viewers, bad bodies and rate-limited callers without sending', async () => {
  h.role = 'viewer';
  expect((await post(product)).status).toBe(403);
  h.role = 'agent';
  expect((await post({ ...product, conversation_id: 'x' })).status).toBe(400);
  expect((await post({ ...product, kind: 'text' })).status).toBe(400);
  h.limited = true;
  expect((await post(product)).status).toBe(429);
  expect(h.send).not.toHaveBeenCalled();
});

it('maps refusals, unknown outcomes and Meta rejections', async () => {
  h.send.mockRejectedValueOnce(new CommerceSendError('window_closed'));
  const closed = await post(product);
  expect(closed.status).toBe(409);
  expect(await closed.json()).toMatchObject({ code: 'window_closed' });

  h.send.mockRejectedValueOnce(new UncertainDispatchError());
  const uncertain = await post(product);
  expect(uncertain.status).toBe(409);
  expect((await uncertain.json()).code).toBeUndefined();

  h.send.mockRejectedValueOnce(new MetaApiError('Recipient phone +91... not allowed', { httpStatus: 400 }));
  const rejected = await post(product);
  expect(rejected.status).toBe(502);
  expect(JSON.stringify(await rejected.json())).not.toContain('+91');
});
