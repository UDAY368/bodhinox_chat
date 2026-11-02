import { beforeEach, expect, it, vi } from 'vitest';
import { gstinCheckChar } from '@/lib/billing/gst';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const h = vi.hoisted(() => ({
  requireRole: vi.fn(), assertMutation: vi.fn(), requirePermission: vi.fn(), stored: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: { status?: number }) => Response.json({ error: 'denied' }, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: ctx.userId }), assertMutation: h.assertMutation }));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: h.requirePermission }));
vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (scope: { accountId: string; role: string }, op: (tx: unknown) => unknown) => {
    // The live session's tenant identity and role reach the database.
    expect(scope).toMatchObject({ accountId: ctx.accountId, role: 'admin' });
    return op({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes('INSERT INTO billing_profiles')) {
          const [, legal_name, gstin, address_line1, address_line2, city, state_code, postal_code, country, email] = values;
          h.stored = { legal_name, gstin, address_line1, address_line2, city, state_code, postal_code, country, email };
        }
        return h.stored ? [h.stored] : [];
      },
    });
  },
}));

import { GET, PUT } from './route';

const GSTIN = `27AAPFU0939F1Z${gstinCheckChar('27AAPFU0939F1Z')}`;
const put = (body: unknown) => PUT(new Request('http://localhost/api/billing/profile', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  h.stored = null;
  h.requireRole.mockReset().mockResolvedValue(ctx);
  h.assertMutation.mockReset().mockResolvedValue(undefined);
  h.requirePermission.mockReset().mockResolvedValue(undefined);
});

it('saves a valid GST profile and reads it back', async () => {
  expect(await (await GET()).json()).toEqual({ profile: null });
  const res = await put({ legal_name: 'Acme LLP', gstin: GSTIN, address_line1: '1 Link Rd', city: 'Mumbai', postal_code: '400001', email: 'ap@acme.example' });
  expect(res.status).toBe(200);
  expect((await res.json()).profile).toMatchObject({ legalName: 'Acme LLP', gstin: GSTIN, stateCode: '27', country: 'IN' });
  expect((await (await GET()).json()).profile.gstin).toBe(GSTIN);
});

it('rejects an invalid GSTIN with a stable code and never writes', async () => {
  const wrong = GSTIN.slice(0, 14) + (GSTIN[14] === 'A' ? 'B' : 'A');
  const res = await put({ legal_name: 'Acme LLP', gstin: wrong, address_line1: '1 Link Rd', city: 'Mumbai', postal_code: '400001', email: 'ap@acme.example' });
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('invalid_gstin');
  expect(h.stored).toBeNull();
  expect((await put([])).status).toBe(400);
});

it("needs origin/CSRF proof and the 'settings.billing' permission to write", async () => {
  const body = { legal_name: 'Acme LLP', address_line1: '1 Link Rd', city: 'Mumbai', state_code: '27', postal_code: '400001', email: 'ap@acme.example' };
  h.assertMutation.mockRejectedValue(Object.assign(new Error('csrf'), { status: 403 }));
  expect((await put(body)).status).toBe(403);
  h.assertMutation.mockResolvedValue(undefined);
  h.requirePermission.mockRejectedValue(Object.assign(new Error('restricted'), { status: 403 }));
  expect((await put(body)).status).toBe(403);
  expect(h.requirePermission).toHaveBeenCalledWith(expect.objectContaining({ accountId: ctx.accountId, role: 'admin' }), 'settings.billing');
  expect(h.stored).toBeNull();
  // Reading stays with the admin role.
  expect((await GET()).status).toBe(200);
});

it('is admin only', async () => {
  h.requireRole.mockRejectedValue(Object.assign(new Error('role'), { status: 403 }));
  expect((await GET()).status).toBe(403);
  expect((await put({})).status).toBe(403);
  expect(h.requireRole).toHaveBeenCalledWith('admin');
});
