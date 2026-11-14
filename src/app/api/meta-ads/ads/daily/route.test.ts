import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const h = vi.hoisted(() => ({ enabled: true, sessions: 0, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'viewer', sessionId: 's' };
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null) }));
vi.mock('@/lib/meta-ads/daily', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/daily')>()),
  adDailySeries: async (...args: unknown[]) => { h.calls.push(args); return { currency: 'INR', points: [] }; },
}));

import { GET } from './route';
import { dailyWindow } from '@/lib/meta-ads/daily';

const get = (qs = '') => GET(new Request(`http://x/api/meta-ads/ads/daily${qs}`));

beforeEach(() => Object.assign(h, { enabled: true, sessions: 0, calls: [] }));

it('answers 503 before reading anything while disabled', async () => {
  h.enabled = false;
  expect((await get('?level=ad&id=123')).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('reads one object of the caller workspace for any member', async () => {
  const res = await get('?level=ad&id=120201234567');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ currency: 'INR', points: [] });
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0][0]).toMatchObject({ accountId: ACCOUNT });
  expect(h.calls[0].slice(1)).toEqual(['ad', '120201234567']);
});

it('rejects a bad level or a non-numeric id without reading', async () => {
  expect((await get('?level=account&id=1')).status).toBe(400);
  expect((await get("?level=ad&id=1'or'1")).status).toBe(400);
  expect((await get('?level=campaign')).status).toBe(400);
  expect(h.calls).toEqual([]);
});

it('covers the last 14 days, oldest first, ending today', () => {
  const days = dailyWindow(Date.parse('2026-11-13T12:00:00Z'));
  expect(days).toHaveLength(14);
  expect(days[0]).toBe('2026-10-31');
  expect(days[13]).toBe('2026-11-13');
});
