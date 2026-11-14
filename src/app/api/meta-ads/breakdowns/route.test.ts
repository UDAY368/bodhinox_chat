import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ enabled: true, sessions: 0, calls: [] as unknown[][] }));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: 'viewer', sessionId: 's' };
  },
}));
vi.mock('@/lib/meta-ads/config', () => ({ metaAdsConfig: () => (h.enabled ? { appId: '1' } : null), metaAdsManageEnabled: () => true }));
vi.mock('@/lib/meta-ads/reports', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/reports')>()),
  getBreakdowns: async (...args: unknown[]) => { h.calls.push(['breakdowns', args[1]]); return { currency: 'INR', rows: [] }; },
  getStoredAdPreview: async (...args: unknown[]) => { h.calls.push(['preview', args[1], args[2]]); return { src: null }; },
  chatQuality: async (...args: unknown[]) => { h.calls.push(['quality', args[1]]); return []; },
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as BREAKDOWNS } from './route';
import { GET as PREVIEW } from '../preview/route';
import { GET as QUALITY } from '../quality/route';

const get = (handler: (r: Request) => Promise<Response>, path: string) => handler(new Request(`http://x/api/meta-ads/${path}`));
const range = 'from=2026-11-01&to=2026-11-07';

beforeEach(() => {
  Object.assign(h, { enabled: true, sessions: 0, calls: [] });
  __resetRateLimitForTests();
});

it('answers 503 before any session work while disabled', async () => {
  h.enabled = false;
  expect((await get(BREAKDOWNS, `breakdowns?${range}&breakdown=region`)).status).toBe(503);
  expect((await get(PREVIEW, 'preview?adId=1')).status).toBe(503);
  expect((await get(QUALITY, `quality?${range}`)).status).toBe(503);
  expect(h.sessions).toBe(0);
});

it('any member reads splits, previews and chat quality with checked ids', async () => {
  expect((await get(BREAKDOWNS, `breakdowns?${range}&breakdown=age_gender&adAccountId=123&objectId=456`)).status).toBe(200);
  expect(h.calls[0]).toEqual(['breakdowns', { from: '2026-11-01', to: '2026-11-07', breakdown: 'age_gender', adAccountId: '123', objectId: '456' }]);
  expect((await get(PREVIEW, 'preview?adId=789&format=INSTAGRAM_STORY')).status).toBe(200);
  expect(h.calls[1]).toEqual(['preview', '789', 'INSTAGRAM_STORY']);
  expect(await (await get(QUALITY, `quality?${range}`)).json()).toEqual({ rows: [] });
});

it('refuses bad input before calling Meta', async () => {
  for (const q of [`${range}&breakdown=income`, `${range}&breakdown=region&objectId=act_1`, 'from=2026-01-01&to=2026-11-07&breakdown=region', 'from=2026-11-07&to=2026-11-01&breakdown=region'])
    expect((await get(BREAKDOWNS, `breakdowns?${q}`)).status).toBe(400);
  expect((await get(PREVIEW, 'preview?adId=../x')).status).toBe(400);
  expect((await get(PREVIEW, 'preview?adId=1&format=DESKTOP_FEED')).status).toBe(400);
  expect((await get(QUALITY, 'quality?from=x&to=y')).status).toBe(400);
  expect(h.calls).toEqual([]);
});
