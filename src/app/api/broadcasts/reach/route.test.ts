import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'agent',
  originRefused: false,
  limited: false,
  calls: [] as unknown[][],
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ accountId: 'acct', userId: 'u-1', role: h.role }),
  assertMutation: async () => { if (h.originRefused) throw Object.assign(new Error('Cross-site request refused'), { status: 403 }); },
}));
vi.mock('@/lib/auth/account', () => ({
  toErrorResponse: (e: { status?: number }) => new Response(null, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: !h.limited }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock('@/lib/broadcasts/create-campaign', () => ({
  CAMPAIGN_LIMITS: { bodyBytes: 1024 },
  campaignReach: async (...args: unknown[]) => { h.calls.push(args); return { count: 42, timeZone: 'Asia/Kolkata' }; },
}));

import { POST } from './route';

const audience = { audience: { type: 'all', skipRecentDays: 7 } };
const post = (body: string = JSON.stringify(audience)) => POST(new Request('http://localhost/api/broadcasts/reach', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
}));

describe('POST /api/broadcasts/reach (the one campaign reach count)', () => {
  beforeEach(() => { h.role = 'agent'; h.originRefused = false; h.limited = false; h.calls = []; });

  it('answers only the count and time zone, counted in the caller tenant', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ count: 42, timeZone: 'Asia/Kolkata' });
    expect(h.calls).toEqual([[{ accountId: 'acct', userId: 'u-1', role: 'agent' }, audience]]);
  });

  it('refuses a viewer, a cross-site request and a rate-limited caller before counting', async () => {
    h.role = 'viewer';
    expect((await post()).status).toBe(403);
    h.role = 'agent'; h.originRefused = true;
    expect((await post()).status).toBe(403);
    h.originRefused = false; h.limited = true;
    expect((await post()).status).toBe(429);
    expect(h.calls).toEqual([]);
  });

  it('refuses an oversized or malformed body', async () => {
    expect((await post('x'.repeat(2048))).status).toBe(413);
    expect((await post('{not json')).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
