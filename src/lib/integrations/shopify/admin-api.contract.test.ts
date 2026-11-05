import { describe, expect, it } from 'vitest';
import { fixtureFetch, loadProviderFixture } from '@/test/fixtures/providers';
import { registerWebhooks, revokeAccess, SHOPIFY_EVENT_TOPICS } from './admin-api';
import { exchangeCode, ShopifyOAuthError } from './oauth';

// Outbound contract for Shopify OAuth and the Admin API (design 1.4, P2):
// docs-derived responses replayed through the real client.
const fx = (name: string) => loadProviderFixture('shopify', name);
const SHOP = 'fixture-shop.myshopify.com';
const config = { apiKey: 'fixture-key', apiSecret: 'test-only-secret', scopes: ['read_orders'] };
const asFetch = (f: ReturnType<typeof fixtureFetch>) => f as unknown as typeof globalThis.fetch;

describe('[CAP-01] Shopify OAuth and Admin API contract (docs-derived)', () => {
  it('exchanges the code at the documented endpoint and reads the token and scopes', async () => {
    const f = fixtureFetch([fx('oauth-access-token')]);
    expect(await exchangeCode({ config, shop: SHOP, code: 'fixturecode123', fetchImpl: asFetch(f) }))
      .toEqual({ accessToken: '<redacted>', scopes: ['read_orders', 'read_checkouts', 'read_customers', 'read_fulfillments'] });
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `https://${SHOP}/admin/oauth/access_token`,
      body: { client_id: 'fixture-key', client_secret: 'test-only-secret', code: 'fixturecode123' } });
  });

  it('refuses a rejected code', async () => {
    await expect(exchangeCode({ config, shop: SHOP, code: 'used', fetchImpl: asFetch(fixtureFetch([fx('oauth-access-token-invalid')])) }))
      .rejects.toBeInstanceOf(ShopifyOAuthError);
  });

  it('registers every topic as documented, counting an already-taken subscription as done', async () => {
    const f = fixtureFetch([fx('admin-webhook-create'), fx('admin-webhook-taken'), ...SHOPIFY_EVENT_TOPICS.slice(2).map(() => fx('admin-webhook-create'))]);
    const address = 'https://app.example.com/api/integrations/shopify/webhooks';
    expect(await registerWebhooks({ shop: SHOP, accessToken: 'test-only-token', address, fetchImpl: asFetch(f) })).toEqual({ failed: [] });
    expect(f.calls).toHaveLength(SHOPIFY_EVENT_TOPICS.length);
    f.calls.forEach((call, i) => {
      expect(call).toMatchObject({ method: 'POST', url: `https://${SHOP}/admin/api/2025-10/webhooks.json`, body: { webhook: { topic: SHOPIFY_EVENT_TOPICS[i], address, format: 'json' } } });
      expect(call.headers['x-shopify-access-token']).toBe('test-only-token');
    });
  });

  it('reports topics Shopify refuses, and treats 401 on revoke as already revoked', async () => {
    const refused = fixtureFetch([fx('admin-unauthorized')]);
    expect((await registerWebhooks({ shop: SHOP, accessToken: 'x', address: 'https://app.example.com/h', fetchImpl: asFetch(refused) })).failed).toEqual([...SHOPIFY_EVENT_TOPICS]);
    const revoke = fixtureFetch([fx('admin-revoke')]);
    expect(await revokeAccess({ shop: SHOP, accessToken: 'x', fetchImpl: asFetch(revoke) })).toBe(true);
    expect(revoke.calls[0]).toMatchObject({ method: 'DELETE', url: `https://${SHOP}/admin/api_permissions/current.json` });
    expect(await revokeAccess({ shop: SHOP, accessToken: 'x', fetchImpl: asFetch(fixtureFetch([fx('admin-unauthorized')])) })).toBe(true);
  });
});
