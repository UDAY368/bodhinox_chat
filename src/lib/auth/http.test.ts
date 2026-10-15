import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/db/prisma', () => ({ getAuthPrisma: vi.fn() }));
import { assertTokenClient } from './http';
import { cookieNames, setSessionCookies } from './cookies';
import { NextResponse } from 'next/server';
afterEach(() => vi.unstubAllEnvs());
describe('explicit client modes and cookie attributes', () => {
  it('permits native HTTPS requests but rejects browser, plaintext and cookie modes', () => {
    process.env.APP_URL = 'https://crm.test';
    expect(() =>
      assertTokenClient(new Request('https://crm.test/api/auth/token-login'))
    ).not.toThrow();
    for (const headers of [
      { cookie: 'bnx_access=jwt' },
      { origin: 'https://crm.test' },
      { 'sec-fetch-site': 'same-origin' },
    ] as Record<string, string>[])
      expect(() =>
        assertTokenClient(
          new Request('https://crm.test/api/auth/token-login', { headers })
        )
      ).toThrow();
    expect(() =>
      assertTokenClient(new Request('http://crm.test/api/auth/token-login'))
    ).toThrow();
  });
  it('marks production credentials Secure HttpOnly host-only and CSRF browser-readable', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = NextResponse.json({ ok: true });
    setSessionCookies(response, {
      accessToken: 'access',
      refreshToken: 'refresh',
      csrfToken: 'csrf',
      expiresAt: new Date(Date.now() + 60000),
    });
    for (const name of [cookieNames().access, cookieNames().refresh]) {
      const cookie = response.cookies.get(name)!;
      expect(name).toMatch(/^__Host-/);
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.secure).toBe(true);
      expect(cookie.path).toBe('/');
      expect(cookie.domain).toBeUndefined();
      expect(cookie.sameSite).toBe('lax');
    }
    expect(response.cookies.get(cookieNames().csrf)?.httpOnly).toBe(false);
  });
});
