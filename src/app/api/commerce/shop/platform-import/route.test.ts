import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const STORE = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', limited: false, csrfOk: true, platformStatus: vi.fn(), queuePlatformImport: vi.fn(), cancelPlatformImport: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
  assertMutation: async () => { if (!h.csrfOk) { const { ForbiddenError } = await import('@/lib/auth/errors'); throw new ForbiddenError('csrf'); } },
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => {} }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: () => ({ success: !h.limited }), rateLimitResponse: () => Response.json({}, { status: 429 }) }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/commerce/catalogue/platform-import-job', () => ({
  platformStatus: h.platformStatus, queuePlatformImport: h.queuePlatformImport, cancelPlatformImport: h.cancelPlatformImport,
}));

import { GET, POST } from './route';
import { POST as CANCEL } from './[id]/cancel/route';

const post = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { role: 'admin', limited: false, csrfOk: true });
  h.platformStatus.mockResolvedValue({ shopify: { connected: false }, woocommerce: { stores: [] }, imports: [] });
  h.queuePlatformImport.mockResolvedValue({ import_id: 'job' });
  h.cancelPlatformImport.mockResolvedValue(true);
});

describe('platform import routes', () => {
  it('keep agents and viewers out of every one', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await GET(new Request('http://localhost/x'))).status).toBe(403);
      expect((await POST(post({ platform: 'shopify' }))).status).toBe(403);
      expect((await CANCEL(post({}), ctx(STORE))).status).toBe(403);
    }
    expect(h.queuePlatformImport).not.toHaveBeenCalled();
    expect(h.cancelPlatformImport).not.toHaveBeenCalled();
  });

  it('queue Shopify and WooCommerce imports with fixed shapes only, answering 202', async () => {
    expect((await POST(post({ platform: 'shopify', shop: 'evil.example' }))).status).toBe(202);
    expect(h.queuePlatformImport).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: ACCOUNT, userId: USER }), { platform: 'shopify' });
    const woo = await POST(post({ platform: 'woocommerce', store_id: STORE, consumer_key: ' ck_abcdefgh ', consumer_secret: 'cs_abcdefgh', url: 'http://169.254.169.254' }));
    expect(woo.status).toBe(202);
    expect(await woo.json()).toEqual({ import_id: 'job' });
    expect(h.queuePlatformImport).toHaveBeenLastCalledWith(expect.anything(), { platform: 'woocommerce', storeId: STORE, consumerKey: 'ck_abcdefgh', consumerSecret: 'cs_abcdefgh' });
  });

  it('refuse a bad body before anything is queued, and a failed CSRF check', async () => {
    for (const body of [null, { platform: 'magento' }, { platform: 'woocommerce', store_id: 'x', consumer_key: 'a', consumer_secret: 'b' },
      { platform: 'woocommerce', store_id: STORE, consumer_key: 1, consumer_secret: 'b' }]) {
      expect((await POST(post(body))).status).toBe(400);
    }
    h.csrfOk = false;
    expect((await POST(post({ platform: 'shopify' }))).status).toBe(403);
    expect((await CANCEL(post({}), ctx(STORE))).status).toBe(403);
    expect(h.queuePlatformImport).not.toHaveBeenCalled();
  });

  it('cancel answers 404 for an unknown or finished import and 429 when limited', async () => {
    h.cancelPlatformImport.mockResolvedValue(false);
    expect((await CANCEL(post({}), ctx(STORE))).status).toBe(404);
    expect((await CANCEL(post({}), ctx('not-an-id'))).status).toBe(404);
    h.limited = true;
    expect((await POST(post({ platform: 'shopify' }))).status).toBe(429);
  });
});
