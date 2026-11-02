import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NUMBER = '33333333-3333-4333-8333-333333333333';
const CATALOG = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  role: 'admin', limited: false,
  listCatalogs: vi.fn(), listMetaCatalogs: vi.fn(), connectCatalog: vi.fn(), getCatalog: vi.fn(),
  updateCatalogSettings: vi.fn(), deleteCatalog: vi.fn(), requestCatalogSync: vi.fn(), listProducts: vi.fn(),
}));

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
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/commerce/catalog', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/catalog')>()),
  listCatalogs: h.listCatalogs, listMetaCatalogs: h.listMetaCatalogs, connectCatalog: h.connectCatalog, getCatalog: h.getCatalog,
  updateCatalogSettings: h.updateCatalogSettings, deleteCatalog: h.deleteCatalog, requestCatalogSync: h.requestCatalogSync,
  listProducts: h.listProducts,
}));

import { CatalogError } from '@/lib/commerce/catalog';
import { GET, POST } from './route';
import { DELETE, GET as GET_ONE, PATCH } from './[id]/route';
import { POST as SYNC } from './[id]/sync/route';
import { GET as PRODUCTS } from '../products/route';

const ctx = { accountId: ACCOUNT, userId: USER, role: 'admin' };
const params = { params: Promise.resolve({ id: CATALOG }) };
const json = (body: unknown, method = 'POST') => new Request('http://localhost/x', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.limited = false;
  h.listCatalogs.mockResolvedValue([{ id: CATALOG }]);
  h.listMetaCatalogs.mockResolvedValue([{ id: '123', name: 'Shop', linked: false }]);
  h.connectCatalog.mockResolvedValue({ id: CATALOG });
  h.getCatalog.mockResolvedValue({ id: CATALOG });
  h.updateCatalogSettings.mockResolvedValue({ id: CATALOG, is_cart_enabled: false });
  h.deleteCatalog.mockResolvedValue(true);
  h.requestCatalogSync.mockResolvedValue(undefined);
  h.listProducts.mockResolvedValue({ products: [], total: 0 });
});

describe('GET /api/commerce/catalogs', () => {
  it('lists linked catalogues for any member', async () => {
    h.role = 'viewer';
    const res = await GET(new Request('http://localhost/api/commerce/catalogs'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ catalogs: [{ id: CATALOG }] });
    expect(h.listCatalogs).toHaveBeenCalledWith({ tx: true }, ACCOUNT);
  });

  it("lists a number's Meta catalogues for admins only", async () => {
    const res = await GET(new Request(`http://localhost/api/commerce/catalogs?whatsapp_config_id=${NUMBER}`));
    expect(await res.json()).toEqual({ available: [{ id: '123', name: 'Shop', linked: false }] });
    expect(h.listMetaCatalogs).toHaveBeenCalledWith(ctx, NUMBER);
    h.role = 'agent';
    expect((await GET(new Request(`http://localhost/api/commerce/catalogs?whatsapp_config_id=${NUMBER}`))).status).toBe(403);
    expect(h.listMetaCatalogs).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/commerce/catalogs', () => {
  it('connects for admins with a validated body', async () => {
    const res = await POST(json({ whatsapp_config_id: NUMBER, catalog_id: '123', is_cart_enabled: false }));
    expect(res.status).toBe(201);
    expect(h.connectCatalog).toHaveBeenCalledWith(ctx, { whatsappConfigId: NUMBER, catalogId: '123', isCartEnabled: false, isCatalogVisible: true });
  });

  it('refuses agents, bad bodies and rate-limited callers before Meta', async () => {
    h.role = 'agent';
    expect((await POST(json({ whatsapp_config_id: NUMBER, catalog_id: '123' }))).status).toBe(403);
    h.role = 'admin';
    const bad = await POST(json({ whatsapp_config_id: NUMBER, catalog_id: 'abc' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_input' });
    h.limited = true;
    expect((await POST(json({ whatsapp_config_id: NUMBER, catalog_id: '123' }))).status).toBe(429);
    expect(h.connectCatalog).not.toHaveBeenCalled();
  });

  it('passes refusals through with their status and code', async () => {
    h.connectCatalog.mockRejectedValueOnce(new CatalogError('catalog_not_in_waba'));
    const res = await POST(json({ whatsapp_config_id: NUMBER, catalog_id: '123' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'catalog_not_in_waba' });
    h.connectCatalog.mockRejectedValueOnce(new CatalogError('meta_error'));
    expect((await POST(json({ whatsapp_config_id: NUMBER, catalog_id: '123' }))).status).toBe(502);
    h.connectCatalog.mockRejectedValueOnce(new Error('db exploded with secret'));
    const generic = await POST(json({ whatsapp_config_id: NUMBER, catalog_id: '123' }));
    expect(generic.status).toBe(500);
    expect(JSON.stringify(await generic.json())).not.toContain('secret');
  });
});

describe('/api/commerce/catalogs/[id]', () => {
  it('reads one for members and 404s a missing one', async () => {
    h.role = 'viewer';
    expect((await GET_ONE(new Request('http://localhost/x'), params)).status).toBe(200);
    h.getCatalog.mockResolvedValueOnce(null);
    expect((await GET_ONE(new Request('http://localhost/x'), params)).status).toBe(404);
  });

  it('changes switches and unlinks for admins only', async () => {
    const res = await PATCH(json({ is_cart_enabled: false }, 'PATCH'), params);
    expect(res.status).toBe(200);
    expect(h.updateCatalogSettings).toHaveBeenCalledWith(ctx, CATALOG, { isCartEnabled: false });
    expect((await PATCH(json({}, 'PATCH'), params)).status).toBe(400);
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)).status).toBe(200);
    h.deleteCatalog.mockResolvedValueOnce(false);
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)).status).toBe(404);
    h.role = 'agent';
    expect((await PATCH(json({ is_cart_enabled: true }, 'PATCH'), params)).status).toBe(403);
    expect((await DELETE(new Request('http://localhost/x', { method: 'DELETE' }), params)).status).toBe(403);
  });
});

describe('POST /api/commerce/catalogs/[id]/sync', () => {
  it('queues a sync for admins and answers 202', async () => {
    const res = await SYNC(new Request('http://localhost/x', { method: 'POST' }), params);
    expect(res.status).toBe(202);
    expect(h.requestCatalogSync).toHaveBeenCalledWith(ctx, CATALOG);
    h.requestCatalogSync.mockRejectedValueOnce(new CatalogError('not_found'));
    expect((await SYNC(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(404);
    h.role = 'agent';
    expect((await SYNC(new Request('http://localhost/x', { method: 'POST' }), params)).status).toBe(403);
  });
});

describe('GET /api/commerce/products', () => {
  it('lists products for any member with parsed filters', async () => {
    h.role = 'viewer';
    const res = await PRODUCTS(new Request(`http://localhost/api/commerce/products?q=shoe&availability=out_of_stock&conversation_id=${NUMBER}&limit=10`));
    expect(res.status).toBe(200);
    expect(h.listProducts).toHaveBeenCalledWith({ tx: true }, ACCOUNT, expect.objectContaining({
      q: 'shoe', availability: 'out_of_stock', conversationId: NUMBER, limit: 10, includeHidden: false,
    }));
  });
});
