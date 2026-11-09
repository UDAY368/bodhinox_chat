import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ platformIntegrationHealth: vi.fn(async () => []), platformJobBacklog: vi.fn(async () => []),
  platformFailedJobs: vi.fn(async () => []), platformRequeueJob: vi.fn() }));
vi.mock('./db', () => db);

import { loadIntegrationHealth, loadPlatformHealth } from './health';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-05T00:00:00Z');
const at = (days: number) => new Date(NOW + days * 86_400_000);

/** A tenant transaction that answers each query by its table and records the SQL text. */
function fakeTx(rows: Record<string, Record<string, unknown>[]>) {
  const sql: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sql.push(text);
      const table = /FROM (\w+)/.exec(text)?.[1] ?? '';
      return rows[table] ?? [];
    }),
  };
  return { tx, sql };
}

beforeEach(() => vi.clearAllMocks());

describe('tenant integration health', () => {
  it('reads no token, secret, key id or customer column', async () => {
    const { tx, sql } = fakeTx({});
    await loadIntegrationHealth(tx as never, ACCOUNT, NOW);
    expect(sql).toHaveLength(8);
    const selected = sql.map((s) => s.slice(0, s.indexOf(' FROM '))).join('\n');
    for (const forbidden of ['_enc', 'key_id', 'secret', 'verify_token', 'api_email', 'api_password', 'phone_number_id', 'webhook_token', 'scopes', '*'])
      expect(selected).not.toContain(forbidden);
    // The only token reference is the "has a token" comparison.
    expect(selected.match(/access_token[^,\n]*/g)).toEqual(["access_token <> '' AS has_token"]);
    expect(sql.every((s) => s.includes('WHERE account_id=?::uuid'))).toBe(true);
  });

  it('derives a state, last success, error code and fix link per connection', async () => {
    const { tx } = fakeTx({
      whatsapp_config: [
        { id: 'w1', display_name: 'Main', status: 'connected', quality_rating: 'GREEN', health_checked_at: at(-1), health_error: null, health_error_at: null, has_token: true },
        { id: 'w2', display_name: null, status: 'connected', quality_rating: 'GREEN', health_checked_at: at(-2), health_error: 'token', health_error_at: at(-1), has_token: true },
        { id: 'w3', display_name: 'Old', status: 'disconnected', quality_rating: null, health_checked_at: null, health_error: null, health_error_at: null, has_token: false },
        { id: 'w4', display_name: 'Red', status: 'connected', quality_rating: 'RED', health_checked_at: at(-1), health_error: null, health_error_at: null, has_token: true },
      ],
      instagram_accounts: [
        { id: 'i1', username: 'shop', status: 'active', last_webhook_at: at(-1), last_error_code: null, token_expires_at: at(30) },
        { id: 'i2', username: 'soon', status: 'active', last_webhook_at: null, last_error_code: null, token_expires_at: at(3) },
        { id: 'i3', username: 'bad', status: 'token_invalid', last_webhook_at: null, last_error_code: 'oauth_expired', token_expires_at: null },
      ],
      meta_ad_connections: [{ id: 'm1', ad_account_name: 'Ads', status: 'pending', insights_synced_at: null, last_error_code: null, token_expires_at: null }],
      shopify_stores: [{ id: 's1', shop_domain: 'acme.myshopify.com', installed_at: at(-9) }],
      meeting_connections: [{ id: 'z1', provider: 'zoom', status: 'active', connected_at: at(-9), last_error_code: 'refresh_failed' }],
      payment_providers: [{ id: 'p1', mode: 'live', connected_at: at(-9) }],
    });
    const rows = await loadIntegrationHealth(tx as never, ACCOUNT, NOW);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.w1).toMatchObject({ kind: 'whatsapp', state: 'ok', lastErrorCode: null, href: '/settings?tab=whatsapp' });
    expect(by.w2).toMatchObject({ state: 'attention', lastErrorCode: 'token' });
    expect(by.w3.state).toBe('disconnected');
    expect(by.w4.state).toBe('attention');
    expect(by.i1.state).toBe('ok');
    expect(by.i2).toMatchObject({ state: 'attention', tokenExpiresAt: at(3).toISOString() });
    expect(by.i3).toMatchObject({ state: 'attention', lastErrorCode: 'oauth_expired', href: '/settings?tab=instagram' });
    expect(by.m1).toMatchObject({ kind: 'meta_ads', state: 'attention', href: '/settings?tab=ads' });
    expect(by.s1).toMatchObject({ kind: 'shopify', state: 'ok', label: 'acme.myshopify.com', href: '/settings?tab=connections' });
    expect(by.z1).toMatchObject({ kind: 'meetings', state: 'attention', lastErrorCode: 'refresh_failed' });
    expect(by.p1).toMatchObject({ kind: 'razorpay', label: 'live', href: '/settings?tab=payments' });
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(['href', 'id', 'kind', 'label', 'lastErrorCode', 'lastSuccessAt', 'state', 'status', 'tokenExpiresAt']);
  });
});

describe('platform health', () => {
  it('checks the shared Razorpay key only while SaaS billing is configured', async () => {
    expect((await loadPlatformHealth({})).sharedKeyCheck).toBe(false);
    expect(db.platformIntegrationHealth).toHaveBeenLastCalledWith(null);
    // One key alone is not "configured".
    await loadPlatformHealth({ BILLING_RAZORPAY_KEY_ID: 'rzp_live_platform' });
    expect(db.platformIntegrationHealth).toHaveBeenLastCalledWith(null);
    const full = { BILLING_RAZORPAY_KEY_ID: 'rzp_live_platform', BILLING_RAZORPAY_KEY_SECRET: 's', BILLING_RAZORPAY_WEBHOOK_SECRET: 'w' };
    expect((await loadPlatformHealth(full)).sharedKeyCheck).toBe(true);
    expect(db.platformIntegrationHealth).toHaveBeenLastCalledWith('rzp_live_platform');
    expect(db.platformJobBacklog).toHaveBeenCalledTimes(3);
  });
});
