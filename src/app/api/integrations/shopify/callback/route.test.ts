import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  previous: null as { shop: string; accessToken: string } | null,
  loadFails: false,
  saveError: null as Error | null,
  revokeAccess: vi.fn(),
  registerWebhooks: vi.fn(async () => ({ failed: [] as string[] })),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'state-cookie' }) }) }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: '11111111-1111-4111-8111-111111111111', userId: 'u1', role: 'admin' }),
}));
vi.mock('@/lib/auth/csrf', () => ({ appOrigin: () => 'https://app.example.test' }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/integrations/shopify/config', () => ({
  shopifyConfig: () => ({ apiKey: 'k', apiSecret: 's', scopes: ['read_orders'] }),
  scopesSatisfied: () => true,
}));
vi.mock('@/lib/integrations/shopify/admin-api', () => ({
  revokeAccess: async (input: { shop: string }) => {
    h.calls.push(`revoke:${input.shop}`);
    h.revokeAccess(input);
    return true;
  },
  registerWebhooks: h.registerWebhooks,
}));
vi.mock('@/lib/integrations/shopify/oauth', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/shopify/oauth')>()),
  verifyCallback: () => ({ shop: 'new-shop.myshopify.com', code: 'code' }),
  exchangeCode: async () => ({ accessToken: 'shpat_new', scopes: ['read_orders'] }),
}));
vi.mock('@/lib/integrations/shopify/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/integrations/shopify/store')>()),
  loadShopifyToken: async () => {
    if (h.loadFails) throw new Error('db down');
    return h.previous;
  },
  saveShopifyStore: async () => {
    h.calls.push('save');
    if (h.saveError) throw h.saveError;
    return {};
  },
}));

import { ShopifyStoreError } from '@/lib/integrations/shopify/store';
import { GET } from './route';

const run = async () => {
  const res = await GET(new Request('https://app.example.test/api/integrations/shopify/callback?shop=new-shop.myshopify.com'));
  return new URL(res.headers.get('location')!).searchParams.get('shopify');
};
const OLD = { shop: 'old-shop.myshopify.com', accessToken: 'shpat_old' };

beforeEach(() => {
  vi.clearAllMocks();
  h.calls = [];
  h.previous = null;
  h.loadFails = false;
  h.saveError = null;
});

describe('Shopify OAuth callback store replacement', () => {
  it('uninstalls the replaced store only after the new store is saved', async () => {
    h.previous = OLD;
    expect(await run()).toBe('connected');
    expect(h.calls).toEqual(['save', 'revoke:old-shop.myshopify.com']);
  });

  it('keeps the working store installed when the new store is connected elsewhere, and revokes the new token', async () => {
    h.previous = OLD;
    h.saveError = new ShopifyStoreError('connected_elsewhere');
    expect(await run()).toBe('connected_elsewhere');
    expect(h.calls).toEqual(['save', 'revoke:new-shop.myshopify.com']);
    expect(h.revokeAccess).toHaveBeenCalledWith({ shop: 'new-shop.myshopify.com', accessToken: 'shpat_new' });
  });

  it('revokes the unsaved token of a new shop on any save failure and keeps the previous store', async () => {
    h.previous = OLD;
    h.saveError = new Error('unique violation');
    expect(await run()).toBe('save_failed');
    expect(h.calls).toEqual(['save', 'revoke:new-shop.myshopify.com']);
  });

  it('never revokes when a reconnect of the same shop fails to save, or when the current store cannot be read', async () => {
    h.previous = { shop: 'new-shop.myshopify.com', accessToken: 'shpat_current' };
    h.saveError = new Error('db error');
    expect(await run()).toBe('save_failed');
    expect(h.revokeAccess).not.toHaveBeenCalled();

    h.calls = [];
    h.loadFails = true;
    expect(await run()).toBe('save_failed');
    expect(h.calls).toEqual([]);
  });

  it('does not revoke anything on a successful reconnect of the same shop', async () => {
    h.previous = { shop: 'new-shop.myshopify.com', accessToken: 'shpat_current' };
    expect(await run()).toBe('connected');
    expect(h.revokeAccess).not.toHaveBeenCalled();
  });
});
