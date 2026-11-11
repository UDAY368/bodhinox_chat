// Stage 5 (5G): the workspace's Instagram AI goals through PUT /api/ai/settings
// (admin with ai.settings; the proxy checks Origin + CSRF before the route,
// see goals.integration.test.ts) and parseSettingsPatch.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requirePermission: vi.fn(),
  writeAiSettings: vi.fn(),
}));
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: h.requireRole,
  toErrorResponse: (e: Error & { status?: number }) => new Response(null, { status: e.status ?? 500 }),
}));
vi.mock('@/lib/auth/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/permissions')>()), requirePermission: h.requirePermission,
}));
vi.mock('@/lib/db/tenant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant')>()), withTenant: async (_c: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()), checkRateLimit: vi.fn(() => ({ success: true })),
}));
vi.mock('./settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settings')>()),
  writeAiSettings: h.writeAiSettings, aiConfigured: vi.fn(async () => true),
}));

import { PUT } from '@/app/api/ai/settings/route';
import { DEFAULT_AI_SETTINGS, parseSettingsPatch } from './settings';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const put = (body: unknown) => PUT(new Request('https://crm.test/api/ai/settings', { method: 'PUT', body: JSON.stringify(body) }));
const goals = [{ type: 'share_link', url: 'https://shop.example/a', label: 'Shop', extra: 'dropped' }, { type: 'capture_lead', fields: ['email'], on_refusal: 'handoff' }];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue(ctx);
  h.requirePermission.mockResolvedValue(undefined);
  h.writeAiSettings.mockImplementation(async (_tx: unknown, _c: unknown, patch: object) => ({ ...DEFAULT_AI_SETTINGS, ...patch }));
});

describe('instagram_goals in the AI settings', () => {
  it('default is no goals (today behaviour)', () => {
    expect(DEFAULT_AI_SETTINGS.instagram_goals).toEqual([]);
  });
  it('keeps only the known fields of each goal', () => {
    expect(parseSettingsPatch({ instagram_goals: goals })).toEqual({ instagram_goals: [
      { type: 'share_link', url: 'https://shop.example/a', label: 'Shop' }, { type: 'capture_lead', fields: ['email'], on_refusal: 'handoff' },
    ] });
    expect(parseSettingsPatch({ instagram_goals: [] })).toEqual({ instagram_goals: [] });
  });
  it.each([
    [{ instagram_goals: [{ type: 'share_link', url: 'ftp://x' }] }],
    [{ instagram_goals: [{ type: 'grow_followers' }, { type: 'grow_followers' }] }],
    [{ instagram_goals: 'all' }],
  ])('refuses an invalid list %#', (body) => {
    expect(parseSettingsPatch(body)).toBeNull();
  });
  it('PUT saves them for an admin and refuses below admin or an invalid list', async () => {
    expect((await put({ instagram_goals: goals })).status).toBe(200);
    expect(h.writeAiSettings).toHaveBeenCalledTimes(1);
    expect((await put({ instagram_goals: [{ type: 'nope' }] })).status).toBe(400);
    h.requireRole.mockRejectedValueOnce(Object.assign(new Error('role'), { status: 403 }));
    expect((await put({ instagram_goals: goals })).status).toBe(403);
    expect(h.writeAiSettings).toHaveBeenCalledTimes(1);
  });
});
