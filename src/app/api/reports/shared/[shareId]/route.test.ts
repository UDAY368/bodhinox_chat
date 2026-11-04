import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const SHARE = '44444444-4444-4444-8444-444444444444';
const RUN = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  session: null as null | { userId: string; accountId: string; role: string },
  opened: [] as unknown[],
  fetched: [] as string[],
  fail: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({ resolveSession: async () => h.session }));
vi.mock('@/lib/analytics/report-shares', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/report-shares')>()),
  openShare: async (session: unknown, id: string) => {
    if (h.fail) throw h.fail;
    h.opened.push({ session, id });
    return { objectKey: `${ACCOUNT}/reports/${RUN}.pdf`, filename: 'campaign_summary_2026-10-01_2026-10-07.pdf', format: 'pdf' };
  },
}));
vi.mock('@/lib/analytics/report-storage', async (original) => ({
  reportContentType: (await original<typeof import('@/lib/analytics/report-storage')>()).reportContentType,
  getReportFile: async (_account: string, key: string) => {
    h.fetched.push(key);
    return new Blob(['%PDF-1.7']).stream();
  },
}));

import { ShareError } from '@/lib/analytics/report-shares';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const get = (id = SHARE, headers: Record<string, string> = {}) =>
  GET(new Request(`http://app.test/api/reports/shared/${id}`, { headers }), { params: Promise.resolve({ shareId: id }) });
const navigate = { 'sec-fetch-mode': 'navigate' };

beforeEach(() => {
  h.session = { userId: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT, role: 'viewer' };
  h.opened = [];
  h.fetched = [];
  h.fail = null;
  __resetRateLimitForTests();
});

it('sends a signed-out visitor to sign in and back to the share page, opening nothing', async () => {
  h.session = null;
  const res = await get(SHARE, navigate);
  expect(res.status).toBe(303);
  const target = new URL(res.headers.get('location')!);
  expect(target.pathname).toBe('/login');
  expect(target.searchParams.get('next')).toBe(`/reports/shared/${SHARE}`);
  expect(h.opened).toEqual([]);
  // A malformed id is never echoed into the return path.
  const bad = await get('..%2F..%2Fsettings', navigate);
  expect(new URL(bad.headers.get('location')!).searchParams.get('next')).toBeNull();
});

it('answers a fetch without a session with 401, so the client refreshes its token instead of saving the sign-in page', async () => {
  h.session = null;
  for (const headers of [{}, { 'sec-fetch-mode': 'cors' }] as Record<string, string>[]) {
    const res = await get(SHARE, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  }
  expect(h.opened).toEqual([]);
});

it('streams the file privately for the live session after the audited open', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="campaign_summary_2026-10-01_2026-10-07.pdf"');
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(h.opened).toEqual([{ session: h.session, id: SHARE }]);
  // Read from the caller's own workspace only.
  expect(h.fetched).toEqual([`${ACCOUNT}/reports/${RUN}.pdf`]);
});

it('answers the same 404 for every refusal without touching storage', async () => {
  h.fail = new ShareError('not_found', 404);
  const res = await get();
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect((await get('nope')).status).toBe(404);
  expect(h.fetched).toEqual([]);
});

it('rate limits opens per member', async () => {
  for (let i = 0; i < 30; i++) await get();
  expect((await get()).status).toBe(429);
});
