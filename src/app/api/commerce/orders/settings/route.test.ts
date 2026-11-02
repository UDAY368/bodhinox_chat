import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', getOrderSettings: vi.fn(), saveOrderSettings: vi.fn() }));

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
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/commerce/orders', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/orders')>()),
  getOrderSettings: h.getOrderSettings,
  saveOrderSettings: h.saveOrderSettings,
}));

import { DEFAULT_ORDER_SETTINGS } from '@/lib/commerce/orders';
import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://localhost/s', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.getOrderSettings.mockResolvedValue(DEFAULT_ORDER_SETTINGS);
  h.saveOrderSettings.mockImplementation(async (_ctx, s) => s);
});

describe('order settings route', () => {
  it('shows the setting to agents but not viewers', async () => {
    h.role = 'agent';
    expect(await (await GET()).json()).toEqual({ settings: DEFAULT_ORDER_SETTINGS });
    h.role = 'viewer';
    expect((await GET()).status).toBe(403);
  });

  it('saves a text confirmation for admins and drops template fields', async () => {
    const res = await put({ confirmation_mode: 'text', confirmation_text: ' Thanks {{customer_name}} ', template_name: 'x', variable_map: { 1: 'order_id' } });
    expect(res.status).toBe(200);
    expect(h.saveOrderSettings.mock.calls[0][1]).toEqual({
      confirmation_mode: 'text', confirmation_text: 'Thanks {{customer_name}}', template_name: null, template_language: null, variable_map: {},
    });
  });

  it('saves a template confirmation with its variable map', async () => {
    await put({ confirmation_mode: 'template', template_name: 'order_ack', template_language: 'en_US', variable_map: { 1: 'customer_name', 2: 'order_total' } });
    expect(h.saveOrderSettings.mock.calls[0][1]).toMatchObject({
      template_name: 'order_ack', template_language: 'en_US', variable_map: { 1: 'customer_name', 2: 'order_total' },
    });
  });

  it.each([
    [{ confirmation_mode: 'sms' }],
    [{ confirmation_mode: 'text', confirmation_text: '  ' }],
    [{ confirmation_mode: 'text', confirmation_text: 'x'.repeat(1025) }],
    [{ confirmation_mode: 'template', template_name: 'order_ack' }],
    [{ confirmation_mode: 'template', template_name: 'order_ack', template_language: 'en', variable_map: { 0: 'order_id' } }],
    [{ confirmation_mode: 'template', template_name: 'order_ack', template_language: 'en', variable_map: { 1: 'Order Id!' } }],
  ])('rejects %j', async (body) => {
    expect((await put(body)).status).toBe(400);
    expect(h.saveOrderSettings).not.toHaveBeenCalled();
  });

  it('refuses agents', async () => {
    h.role = 'agent';
    expect((await put({ confirmation_mode: 'off' })).status).toBe(403);
    expect(h.saveOrderSettings).not.toHaveBeenCalled();
  });
});
