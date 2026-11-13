import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  member: null as string | null,
  workspace: null as string | null,
  saved: [] as unknown[],
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => (h.cookie ? { value: h.cookie } : undefined) }) }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ accountId: 'tenant-a', userId: 'user-a', role: 'agent' }),
  toErrorResponse: () => Response.json({ error: 'Denied' }, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'Slow down' }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));
vi.mock('@/lib/settings/member-preferences', () => ({
  getMemberPreferences: async () => ({ language: h.member }),
  saveMemberLanguage: async (ctx: unknown, language: string | null) => { h.saved.push([ctx, language]); h.member = language; return { language }; },
}));
vi.mock('@/lib/settings/workspace-settings', () => ({ getWorkspaceSettings: async () => ({ name: 'A', default_language: h.workspace }) }));

import { GET, PUT } from './route';

const put = (body: unknown) => new Request('http://x/api/account/locale', { method: 'PUT', body: JSON.stringify(body) });

beforeEach(() => {
  h.cookie = undefined;
  h.member = null;
  h.workspace = null;
  h.saved = [];
  delete process.env.NEXT_PUBLIC_APP_LOCALE;
});

it('uses the member’s language, else the workspace default, and mirrors it into the cookie', async () => {
  h.workspace = 'ko';
  let res = await GET();
  expect(await res.json()).toMatchObject({ language: null, workspace_language: 'ko', effective: 'ko', changed: true });
  expect(res.headers.get('set-cookie')).toMatch(/bodhinox_locale=ko;.*HttpOnly/i);
  h.member = 'pt';
  h.cookie = 'pt';
  res = await GET();
  expect(await res.json()).toMatchObject({ effective: 'pt', changed: false });
});

it('stores only the session member’s own choice', async () => {
  const res = await PUT(put({ language: 'es' }));
  expect(res.status).toBe(200);
  expect(h.saved).toEqual([[{ accountId: 'tenant-a', userId: 'user-a', role: 'agent' }, 'es']]);
  expect((await res.json()).effective).toBe('es');
});

it('rejects unknown languages and extra fields', async () => {
  for (const body of [{ language: 'fr' }, { language: 'es', user_id: 'other' }, {}, null])
    expect((await PUT(put(body))).status, JSON.stringify(body)).toBe(400);
  expect(h.saved).toEqual([]);
});
