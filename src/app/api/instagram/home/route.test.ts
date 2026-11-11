// GET /api/instagram/home: 503 while Instagram is off (before any session or
// database work), 401 signed out, any member may read, and the summary runs as
// the caller's own workspace.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ signedIn: true, role: 'viewer', sessions: 0, contexts: [] as unknown[] }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => {
    h.sessions++;
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: h.role, sessionId: 's' };
  },
}));
vi.mock('@/lib/instagram/home-summary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/instagram/home-summary')>()),
  instagramHomeSummary: async (context: unknown) => { h.contexts.push(context); return { since: 'x', defaults: [], nextMoves: [] }; },
}));

import { GET } from './route';

const request = () => new Request('https://app.example.test/api/instagram/home');
const env = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 's',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'v', APP_URL: 'https://app.example.test',
};

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  h.signedIn = true; h.role = 'viewer'; h.sessions = 0; h.contexts = [];
});

describe('GET /api/instagram/home', () => {
  it('answers 503 instagram_not_enabled before any session work while Instagram is off', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(h.sessions).toBe(0);
  });

  it('refuses a signed-out caller', async () => {
    h.signedIn = false;
    expect((await GET(request())).status).toBe(401);
    expect(h.contexts).toHaveLength(0);
  });

  it('lets a viewer read, privately, as their own workspace', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await response.json()).summary.since).toBe('x');
    expect(h.contexts).toEqual([{ accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'viewer' }]);
  });
});
