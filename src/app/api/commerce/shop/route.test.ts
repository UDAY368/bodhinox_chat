import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '33333333-3333-4333-8333-333333333333';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  role: 'admin', limited: false, permitted: true, csrfOk: true,
  listShopProducts: vi.fn(), upsertProduct: vi.fn(), getShopProduct: vi.fn(), publishProduct: vi.fn(), upsertVariant: vi.fn(),
  importFromMeta: vi.fn(), adjustStock: vi.fn(), requirePermission: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
  assertMutation: async () => { if (!h.csrfOk) { const { ForbiddenError } = await import('@/lib/auth/errors'); throw new ForbiddenError('csrf'); } },
}));
vi.mock('@/lib/auth/permissions', () => ({
  requirePermission: async (...args: unknown[]) => {
    h.requirePermission(...args);
    if (!h.permitted) { const { ForbiddenError } = await import('@/lib/auth/errors'); throw new ForbiddenError('restricted'); }
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/commerce/catalogue/products', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/catalogue/products')>()),
  listShopProducts: h.listShopProducts, upsertProduct: h.upsertProduct, getShopProduct: h.getShopProduct,
  publishProduct: h.publishProduct, upsertVariant: h.upsertVariant, importFromMeta: h.importFromMeta,
}));
vi.mock('@/lib/commerce/catalogue/inventory', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/catalogue/inventory')>()),
  adjustStock: h.adjustStock,
}));

import { CatalogueError } from '@/lib/commerce/catalogue/products';
import { GET, POST } from './products/route';
import { GET as GET_ONE, PATCH } from './products/[id]/route';
import { POST as PUBLISH } from './products/[id]/publish/route';
import { PATCH as PATCH_VARIANT } from './products/[id]/variants/[variantId]/route';
import { POST as IMPORT } from './import/route';
import { POST as ADJUST } from '../inventory/[variantId]/adjust/route';

const req = (body?: unknown, method = 'POST', url = 'http://localhost/x') =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const params = { params: Promise.resolve({ id: PRODUCT }) };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { role: 'admin', limited: false, permitted: true, csrfOk: true });
  h.listShopProducts.mockResolvedValue({ products: [], total: 0 });
  h.upsertProduct.mockResolvedValue({ id: PRODUCT });
  h.getShopProduct.mockResolvedValue({ id: PRODUCT });
  h.publishProduct.mockResolvedValue({ id: PRODUCT, status: 'published' });
  h.upsertVariant.mockResolvedValue({ id: PRODUCT });
  h.importFromMeta.mockResolvedValue({ created: [], skipped: [] });
  h.adjustStock.mockResolvedValue({ variantId: VARIANT, onHand: 5, reserved: 0 });
});

describe('catalogue routes', () => {
  it('lets agents read and keeps viewers out (viewers read none of the new tables)', async () => {
    h.role = 'agent';
    const res = await GET(req(undefined, 'GET', 'http://localhost/x?q=ash&stock=low'));
    expect(res.status).toBe(200);
    expect(h.listShopProducts).toHaveBeenCalledWith({ tx: true }, ACCOUNT, expect.objectContaining({ q: 'ash', stock: 'low' }));
    expect((await GET_ONE(req(undefined, 'GET'), params)).status).toBe(200);
    h.role = 'viewer';
    expect((await GET(req(undefined, 'GET'))).status).toBe(403);
    expect(h.listShopProducts).toHaveBeenCalledTimes(1);
  });

  it('keeps every write to admins, with the CSRF proof and the rate limit', async () => {
    h.role = 'agent';
    expect((await POST(req({ name: 'Ash' }))).status).toBe(403);
    expect((await PATCH(req({ name: 'Ash' }, 'PATCH'), params)).status).toBe(403);
    expect((await PUBLISH(req({}), params)).status).toBe(403);
    expect((await IMPORT(req({ meta_product_ids: [] }))).status).toBe(403);
    expect(h.upsertProduct).not.toHaveBeenCalled();
    h.role = 'admin';
    h.csrfOk = false;
    expect((await POST(req({ name: 'Ash' }))).status).toBe(403);
    h.csrfOk = true;
    h.limited = true;
    expect((await POST(req({ name: 'Ash' }))).status).toBe(429);
    h.limited = false;
    const res = await POST(req({ name: 'Ash' }));
    expect(res.status).toBe(201);
    expect(h.upsertProduct).toHaveBeenCalledWith({ tx: true }, ACCOUNT, USER, null, { name: 'Ash' });
  });

  it('returns refusals as codes with the field, never the input', async () => {
    h.upsertVariant.mockRejectedValue(new CatalogueError('sku_taken', 'sku'));
    const res = await PATCH_VARIANT(req({ sku: 'DUP' }, 'PATCH'), { params: Promise.resolve({ id: PRODUCT, variantId: VARIANT }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'sku_taken', field: 'sku' });
    expect(JSON.stringify(body)).not.toContain('DUP');
    h.publishProduct.mockRejectedValue(new CatalogueError('needs_priced_variant'));
    expect((await PUBLISH(req({}), params)).status).toBe(409);
    h.getShopProduct.mockRejectedValue(new Error('boom: secret detail'));
    const failed = await GET_ONE(req(undefined, 'GET'), params);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('secret');
  });

  it('adjusts stock only for admins holding commerce.inventory', async () => {
    const body = { kind: 'receipt', delta: 5, expected_on_hand: 0 };
    const ctx = { params: Promise.resolve({ variantId: VARIANT }) };
    h.role = 'agent';
    expect((await ADJUST(req(body), ctx)).status).toBe(403);
    h.role = 'admin';
    h.permitted = false;
    expect((await ADJUST(req(body), ctx)).status).toBe(403);
    expect(h.adjustStock).not.toHaveBeenCalled();
    h.permitted = true;
    expect((await ADJUST(req({ ...body, delta: -5 }), ctx)).status).toBe(400);
    const res = await ADJUST(req(body), ctx);
    expect(res.status).toBe(200);
    expect(h.requirePermission).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, role: 'admin' }), 'commerce.inventory');
    expect(h.adjustStock).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, userId: USER }),
      { variantId: VARIANT, kind: 'receipt', delta: 5, reason: null, expectedOnHand: 0 });
    h.adjustStock.mockRejectedValue(new CatalogueError('stock_changed'));
    expect(await (await ADJUST(req(body), ctx)).json()).toMatchObject({ code: 'stock_changed' });
  });
});
