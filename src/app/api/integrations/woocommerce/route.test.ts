import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/errors';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  listWooStores: vi.fn(),
  createWooStore: vi.fn(),
  updateWooStoreConsentKey: vi.fn(),
  deleteWooStore: vi.fn(),
  stopWooStore: vi.fn(async () => 0),
  rateLimitOk: true,
  rateKeys: [] as string[],
  listCommerceRules: vi.fn(),
  saveCommerceRule: vi.fn(),
  deleteCommerceRule: vi.fn(),
  processWooWebhook: vi.fn(),
  tenants: [] as unknown[],
}));

vi.mock('@/lib/auth/account', async () => {
  const { toErrorResponse } = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account');
  return { requireRole: h.requireRole, getCurrentAccount: h.getCurrentAccount, toErrorResponse };
});
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (tenant: unknown, op: (tx: unknown) => unknown, db?: unknown) => {
    h.tenants.push(db ? { tenant, db } : tenant);
    return op(db ? { tx: true, db } : { tx: true });
  },
}));
vi.mock('@/lib/db/prisma', () => ({ getWorkerPrisma: () => 'worker' }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: (key: string) => {
    h.rateKeys.push(key);
    return { success: h.rateLimitOk };
  },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/integrations/woocommerce/stores', async () => {
  const actual = await vi.importActual<typeof import('@/lib/integrations/woocommerce/stores')>('@/lib/integrations/woocommerce/stores');
  return {
    WooStoreInputError: actual.WooStoreInputError,
    listWooStores: h.listWooStores,
    createWooStore: h.createWooStore,
    updateWooStoreConsentKey: h.updateWooStoreConsentKey,
    deleteWooStore: h.deleteWooStore,
    stopWooStore: h.stopWooStore,
  };
});
vi.mock('@/lib/integrations/commerce-rules', async () => {
  const actual = await vi.importActual<typeof import('@/lib/integrations/commerce-rules')>('@/lib/integrations/commerce-rules');
  return { ...actual, listCommerceRules: h.listCommerceRules, saveCommerceRule: h.saveCommerceRule, deleteCommerceRule: h.deleteCommerceRule };
});
vi.mock('@/lib/integrations/woocommerce/process', () => ({ processWooWebhook: h.processWooWebhook }));

import { DELETE, GET, PATCH, POST } from './route';
import * as rulesRoute from '../commerce-rules/route';
import { POST as webhookPOST } from './webhook/[storeId]/route';
import { WooStoreInputError } from '@/lib/integrations/woocommerce/stores';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const STORE = '22222222-2222-4222-8222-222222222222';
const admin = { accountId: ACCOUNT, userId: 'u-1', role: 'admin', db: {}, account: { id: ACCOUNT, name: 'A' } };
const store = { id: STORE, store_url: 'https://shop.example.com', consent_meta_key: null, connected_at: '2026-11-02T00:00:00.000Z' };
const json = (url: string, method: string, body: unknown) =>
  new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  h.tenants = [];
  h.rateKeys = [];
  h.rateLimitOk = true;
  process.env.APP_URL = 'https://app.example.com';
  h.requireRole.mockResolvedValue(admin);
  h.getCurrentAccount.mockResolvedValue({ ...admin, role: 'viewer' });
  h.listWooStores.mockResolvedValue([store]);
  h.createWooStore.mockResolvedValue({ store, webhookSecret: 'shown-once' });
});

describe('/api/integrations/woocommerce', () => {
  it('requires admin for every method', async () => {
    h.requireRole.mockRejectedValue(new ForbiddenError('Insufficient workspace role'));
    expect((await GET()).status).toBe(403);
    expect((await POST(json('http://localhost/api/integrations/woocommerce', 'POST', { storeUrl: 'https://s.example' }))).status).toBe(403);
    expect((await PATCH(json('http://localhost/api/integrations/woocommerce', 'PATCH', { id: STORE }))).status).toBe(403);
    expect((await DELETE(new Request(`http://localhost/api/integrations/woocommerce?id=${STORE}`, { method: 'DELETE' }))).status).toBe(403);
    expect(h.requireRole).toHaveBeenCalledWith('admin');
    expect(h.createWooStore).not.toHaveBeenCalled();
    expect(h.deleteWooStore).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    h.requireRole.mockRejectedValue(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
  });

  it('lists stores with their delivery url and never a secret', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.stores[0]).toEqual({ ...store, delivery_url: `https://app.example.com/api/integrations/woocommerce/webhook/${STORE}` });
    expect(JSON.stringify(body)).not.toMatch(/secret/i);
    expect(h.tenants[0]).toEqual({ accountId: ACCOUNT, userId: 'u-1', role: 'admin' });
  });

  it('returns the secret once on create and maps input errors', async () => {
    const res = await POST(json('http://localhost/api/integrations/woocommerce', 'POST', { storeUrl: 'https://shop.example.com', consentMetaKey: '_wa' }));
    expect(res.status).toBe(201);
    expect((await res.json()).webhookSecret).toBe('shown-once');
    expect(h.createWooStore).toHaveBeenCalledWith({ tx: true }, ACCOUNT, { storeUrl: 'https://shop.example.com', consentMetaKey: '_wa' });
    h.createWooStore.mockRejectedValueOnce(new WooStoreInputError('store_exists'));
    const dup = await POST(json('http://localhost/api/integrations/woocommerce', 'POST', { storeUrl: 'https://shop.example.com' }));
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('store_exists');
  });

  it('disconnects as the admin, then stops the store queued sends as the worker', async () => {
    h.deleteWooStore.mockResolvedValue(true);
    const res = await DELETE(new Request(`http://localhost/api/integrations/woocommerce?id=${STORE}`, { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(h.deleteWooStore).toHaveBeenCalledWith({ tx: true }, ACCOUNT, STORE);
    expect(h.stopWooStore).toHaveBeenCalledWith({ tx: true, db: 'worker' }, ACCOUNT, STORE);
    expect(h.tenants).toEqual([
      { accountId: ACCOUNT, userId: 'u-1', role: 'admin' },
      { tenant: { accountId: ACCOUNT, role: 'owner' }, db: 'worker' },
    ]);
    expect(h.deleteWooStore.mock.invocationCallOrder[0]).toBeLessThan(h.stopWooStore.mock.invocationCallOrder[0]);
  });

  it('still finishes an interrupted cleanup on a retried delete, but never for a malformed id', async () => {
    h.deleteWooStore.mockResolvedValue(false);
    expect((await DELETE(new Request(`http://localhost/api/integrations/woocommerce?id=${STORE}`, { method: 'DELETE' }))).status).toBe(404);
    expect(h.stopWooStore).toHaveBeenCalledTimes(1);
    expect((await DELETE(new Request('http://localhost/api/integrations/woocommerce?id=nope', { method: 'DELETE' }))).status).toBe(404);
    expect(h.stopWooStore).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed cleanup instead of reporting the disconnect done', async () => {
    h.deleteWooStore.mockResolvedValue(true);
    h.stopWooStore.mockRejectedValueOnce(new Error('db down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await DELETE(new Request(`http://localhost/api/integrations/woocommerce?id=${STORE}`, { method: 'DELETE' }))).status).toBe(500);
    log.mockRestore();
  });

  it('404s deleting or patching a store of another account', async () => {
    h.deleteWooStore.mockResolvedValue(false);
    h.updateWooStoreConsentKey.mockResolvedValue(null);
    expect((await DELETE(new Request(`http://localhost/api/integrations/woocommerce?id=${STORE}`, { method: 'DELETE' }))).status).toBe(404);
    expect((await PATCH(json('http://localhost/api/integrations/woocommerce', 'PATCH', { id: STORE, consentMetaKey: null }))).status).toBe(404);
  });
});

describe('/api/integrations/commerce-rules', () => {
  const rule = { source: 'woocommerce', event: 'order_paid', enabled: true, templateName: 'order_update', templateLanguage: 'en',
    whatsappConfigId: null, delayMinutes: 0, variableMap: { 1: 'order_number' } };

  it('lets any member read but only admins save or delete', async () => {
    h.listCommerceRules.mockResolvedValue([]);
    expect((await rulesRoute.GET(new Request('http://localhost/api/integrations/commerce-rules?source=woocommerce'))).status).toBe(200);
    h.requireRole.mockRejectedValue(new ForbiddenError('Insufficient workspace role'));
    expect((await rulesRoute.PUT(json('http://localhost/api/integrations/commerce-rules', 'PUT', rule))).status).toBe(403);
    expect((await rulesRoute.DELETE(new Request('http://localhost/api/integrations/commerce-rules?source=woocommerce&event=order_paid', { method: 'DELETE' }))).status).toBe(403);
    expect(h.saveCommerceRule).not.toHaveBeenCalled();
    expect(h.deleteCommerceRule).not.toHaveBeenCalled();
  });

  it('validates input with translatable codes', async () => {
    const bad = async (over: Record<string, unknown>) =>
      (await (await rulesRoute.PUT(json('http://localhost/api/integrations/commerce-rules', 'PUT', { ...rule, ...over }))).json()).code;
    expect(await bad({ source: 'magento' })).toBe('source_invalid');
    expect(await bad({ event: 'checkout_abandoned' })).toBe('event_invalid');
    expect(await bad({ templateName: 'Bad Name' })).toBe('template_invalid');
    expect(await bad({ delayMinutes: 10081 })).toBe('delay_invalid');
    expect(await bad({ variableMap: { 21: 'x' } })).toBe('variables_invalid');
    expect(await bad({ whatsappConfigId: 'nope' })).toBe('number_invalid');
    expect((await rulesRoute.GET(new Request('http://localhost/api/integrations/commerce-rules?source=x'))).status).toBe(400);
    expect(h.saveCommerceRule).not.toHaveBeenCalled();
  });

  it('saves a valid rule in the admin tenant', async () => {
    h.saveCommerceRule.mockResolvedValue({ id: 'r1' });
    const res = await rulesRoute.PUT(json('http://localhost/api/integrations/commerce-rules', 'PUT', rule));
    expect(res.status).toBe(200);
    expect(h.saveCommerceRule).toHaveBeenCalledWith({ tx: true }, ACCOUNT, expect.objectContaining({ event: 'order_paid', variableMap: { 1: 'order_number' } }));
  });
});

describe('POST /api/integrations/woocommerce/webhook/[storeId]', () => {
  const call = (body: string, headers: Record<string, string> = {}) =>
    webhookPOST(new Request(`http://localhost/api/integrations/woocommerce/webhook/${STORE}`, { method: 'POST', body, headers }),
      { params: Promise.resolve({ storeId: STORE }) });

  it('passes the raw body through and returns the processor status', async () => {
    h.processWooWebhook.mockResolvedValue({ status: 401, body: { error: 'Invalid signature' } });
    const res = await call('{"id":1}', { 'x-wc-webhook-topic': 'order.created' });
    expect(res.status).toBe(401);
    expect(h.processWooWebhook).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE, rawBody: '{"id":1}' }));
  });

  it('rate-limits per store before reading the body or touching the database', async () => {
    h.rateLimitOk = false;
    const res = await call('{"id":1}', { 'x-wc-webhook-signature': 'x' });
    expect(res.status).toBe(429);
    expect(h.rateKeys).toEqual([`wooWebhook:${STORE}`]);
    expect(h.processWooWebhook).not.toHaveBeenCalled();
  });

  it('404s a store id that is not a uuid without rate-limit bookkeeping or processing', async () => {
    const res = await webhookPOST(new Request('http://localhost/api/integrations/woocommerce/webhook/x', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ storeId: '../x' }) });
    expect(res.status).toBe(404);
    expect(h.rateKeys).toEqual([]);
    expect(h.processWooWebhook).not.toHaveBeenCalled();
  });

  it('refuses oversized bodies without processing', async () => {
    const res = await call('x'.repeat(1024 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(h.processWooWebhook).not.toHaveBeenCalled();
  });

  it('answers 503 (not 200) when recording fails, so nothing is acknowledged that was not stored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.processWooWebhook.mockRejectedValue(new Error('db down'));
    expect((await call('{}')).status).toBe(503);
    log.mockRestore();
  });
});
