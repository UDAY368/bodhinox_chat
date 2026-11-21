import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import { sessionLinkTx, type LinkedSession } from './shop-session-link';

beforeAll(() => {
  process.env.APP_URL ??= 'https://app.example.test';
  process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);
});

/** A transaction whose shop_storefronts read answers `handle` (null = no published, open shop). */
const tx = (handle: string | null) => ({ $queryRaw: vi.fn(async () => (handle ? [{ handle }] : [])) }) as unknown as TenantTransaction & { $queryRaw: ReturnType<typeof vi.fn> };
const shop: LinkedSession = { id: '00000000-0000-4000-8000-000000000001', token_epoch: 1, purpose: 'shop', is_quote: false, created_by: null };
const TOKEN = '[A-Za-z0-9_-]{43}';

describe('buyer links back into a storefront session', () => {
  it('opens the themed shop for a plain shop session of an open, published shop', async () => {
    expect(await sessionLinkTx(tx('ayur'), 'acc', shop, 'checkout')).toMatch(new RegExp(`/s/ayur/checkout/${TOKEN}$`));
    expect(await sessionLinkTx(tx('ayur'), 'acc', shop, 'done')).toMatch(new RegExp(`/s/ayur/checkout/${TOKEN}/done$`));
  });

  it('keeps /shop/<token> when the shop is not open to everyone, and for staff links, quotes and order sessions', async () => {
    expect(await sessionLinkTx(tx(null), 'acc', shop, 'done')).toMatch(new RegExp(`/shop/${TOKEN}/done$`));
    for (const session of [{ ...shop, created_by: '00000000-0000-4000-8000-000000000002' }, { ...shop, is_quote: true }, { ...shop, purpose: 'order' }]) {
      const t = tx('ayur');
      expect(await sessionLinkTx(t, 'acc', session, 'checkout')).toMatch(new RegExp(`/shop/${TOKEN}$`));
      expect(t.$queryRaw).not.toHaveBeenCalled();
    }
  });
});
