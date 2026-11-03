import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', resolve: vi.fn() }));

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
vi.mock('@/lib/meta-ads/capi', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/capi')>()),
  resolveConversionEvent: h.resolve,
}));

import { CapiError } from '@/lib/meta-ads/capi';
import { POST } from './route';

const ENV = { META_ADS_ENABLED: 'true', META_APP_ID: '123', META_APP_SECRET_PRIMARY: 'test-only', META_ADS_LOGIN_CONFIG_ID: '456' };
const saved = { ...process.env };
const post = (body: unknown) => POST(
  new Request(`http://localhost/api/meta-ads/conversions/${EVENT}/resolve`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
  { params: Promise.resolve({ id: EVENT }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, ENV);
  h.role = 'admin';
  h.resolve.mockResolvedValue({ id: EVENT, status: 'unknown', resolution: 'confirmed_sent' });
});
afterEach(() => {
  process.env = { ...saved };
});

describe('POST /api/meta-ads/conversions/[id]/resolve', () => {
  it.each(['confirmed_sent', 'confirmed_not_sent'])('records %s as the caller', async (resolution) => {
    const res = await post({ resolution });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await res.json()).event).toMatchObject({ id: EVENT });
    expect(h.resolve).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, EVENT, resolution);
  });

  it('answers 503 before anything else while the feature is off', async () => {
    process.env.META_ADS_ENABLED = 'false';
    const res = await post({ resolution: 'confirmed_sent' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('meta_ads_not_enabled');
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each([{}, { resolution: 'resend' }, { resolution: 'sent' }, 'not json', [1]])('rejects a bad body %#', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('resolution');
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each(['agent', 'viewer'])('refuses %s', async (role) => {
    h.role = role;
    expect((await post({ resolution: 'confirmed_sent' })).status).toBe(403);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each([['not_found', 404], ['not_open', 409]] as const)('maps %s to %i', async (code, status) => {
    h.resolve.mockRejectedValueOnce(new CapiError(code, status));
    const res = await post({ resolution: 'confirmed_sent' });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });
});
