import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db/prisma', () => ({ getAuthPrisma: vi.fn() }));
const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  requireSession: vi.fn(),
  resolveSession: vi.fn(),
  assertMutation: vi.fn(),
}));
vi.mock('@/lib/auth/service', () => ({
  enforceAuthRateLimit: mocks.rateLimit,
  SESSION_LIFETIME_MS: 1000,
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: mocks.requireSession,
  resolveSession: mocks.resolveSession,
  assertMutation: mocks.assertMutation,
}));
import { GET as status, DELETE as unlink } from './route';
import { GET as start, POST as linkStart } from './start/route';
import { GET as callback, POST as mfa } from './callback/route';
import { googleCookieNames, resetGoogleCaches, sealCookie } from '@/lib/auth/google-oidc';
import { UnauthorizedError } from '@/lib/auth/errors';

const discovery = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};
beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://crm.test');
  vi.stubEnv('GOOGLE_CLIENT_ID', 'cid');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'secret');
  resetGoogleCaches();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.resolveSession.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(discovery)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Google routes without configuration', () => {
  it('report unconfigured and answer 503 on start and callback', async () => {
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
    expect(await (await status(new Request('https://crm.test/api/auth/google'))).json()).toEqual({ configured: false, linked: null });
    expect((await start(new Request('https://crm.test/api/auth/google/start'))).status).toBe(503);
    expect((await callback(new Request('https://crm.test/api/auth/google/callback?state=a&code=b'))).status).toBe(503);
    expect((await mfa(new Request('https://crm.test/api/auth/google/callback', { method: 'POST' }))).status).toBe(503);
    expect((await linkStart(new Request('https://crm.test/api/auth/google/start', { method: 'POST' }))).status).toBe(503);
  });
});

describe('sign-in start', () => {
  it('redirects to Google and sets a short-lived httpOnly flow cookie', async () => {
    const response = await start(new Request('https://crm.test/api/auth/google/start?next=/inbox'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain(`${googleCookieNames().flow}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
  });
  it('sends the person back to login when Google discovery is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const response = await start(new Request('https://crm.test/api/auth/google/start'));
    expect(response.headers.get('location')).toBe('https://crm.test/login?error=google_unavailable');
  });
});

describe('callback', () => {
  it('rejects a callback without the flow cookie (login CSRF) and clears state', async () => {
    const response = await callback(new Request('https://crm.test/api/auth/google/callback?state=a&code=b'));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://crm.test/login?error=google_failed');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a mismatched state and returns link flows to settings', async () => {
    const sealed = sealCookie('flow', { state: 'right', nonce: 'n', verifier: 'v', mode: 'link', next: '/settings', invite: null, userId: 'u', sessionId: 's' }, 600, { clientId: 'cid', clientSecret: 'secret' });
    const response = await callback(
      new Request('https://crm.test/api/auth/google/callback?state=wrong&code=b', {
        headers: { cookie: `${googleCookieNames().flow}=${sealed}` },
      })
    );
    expect(response.headers.get('location')).toBe('https://crm.test/settings?tab=security&google=google_failed');
  });
});

describe('MFA completion', () => {
  it('requires the same-origin pre-auth CSRF token', async () => {
    const response = await mfa(
      new Request('https://crm.test/api/auth/google/callback', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ mfaCode: '123456' }),
      })
    );
    expect(response.status).toBe(403);
  });
  it('rejects a missing or expired pending-MFA cookie', async () => {
    const response = await mfa(
      new Request('https://crm.test/api/auth/google/callback', {
        method: 'POST',
        headers: { origin: 'https://crm.test', 'content-type': 'application/json', cookie: 'bnx_csrf=tok', 'x-csrf-token': 'tok' },
        body: JSON.stringify({ mfaCode: '123456' }),
      })
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('google_expired');
  });
});

describe('linking', () => {
  it('requires a session and a valid mutation before starting or unlinking', async () => {
    mocks.requireSession.mockRejectedValue(new UnauthorizedError());
    expect((await linkStart(new Request('https://crm.test/api/auth/google/start', { method: 'POST' }))).status).toBe(401);
    expect((await unlink(new Request('https://crm.test/api/auth/google', { method: 'DELETE' }))).status).toBe(401);
    mocks.requireSession.mockResolvedValue({ userId: 'u', sessionId: 's', accountId: 'a' });
    mocks.assertMutation.mockRejectedValue(new UnauthorizedError());
    expect((await linkStart(new Request('https://crm.test/api/auth/google/start', { method: 'POST' }))).status).toBe(401);
  });
});
