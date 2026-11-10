import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./service', () => ({
  enforceAuthRateLimit: vi.fn(),
  verifyEmailToken: vi.fn(),
  isVerifyTokenValid: vi.fn(),
}));
import { enforceAuthRateLimit, isVerifyTokenValid, verifyEmailToken } from './service';
import { cookieNames } from './cookies';
import { hashToken, randomToken } from './csrf';
import { AuthError } from './errors';
import { handleAuthGet, handleAuthPost } from './http';

const origin = 'https://verify.test.invalid';
const linkToken = 'b'.repeat(43);
function post(body: object, withLink = true): Request {
  const csrf = randomToken();
  const cookies = [`${cookieNames().csrf}=${csrf}`];
  if (withLink) cookies.push(`${cookieNames().verify}=${linkToken}`);
  return new Request(`${origin}/api/auth/verify-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin,
      cookie: cookies.join('; '),
      'x-csrf-token': csrf,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.stubEnv('APP_URL', origin));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('verify-email (link plus signup password)', () => {
  it('verifies with the link cookie and the typed password, then clears the cookie', async () => {
    const response = await handleAuthPost(post({ password: 'Abcdef1!' }), 'verify-email');
    expect(response.status).toBe(200);
    expect(verifyEmailToken).toHaveBeenCalledWith(linkToken, 'Abcdef1!');
    // Guesses are capped per link.
    expect(enforceAuthRateLimit).toHaveBeenCalledWith('verify-token', hashToken(linkToken));
    expect(response.headers.get('set-cookie')).toContain(`${cookieNames().verify}=;`);
  });
  it('refuses without the link cookie', async () => {
    const response = await handleAuthPost(post({ password: 'Abcdef1!' }, false), 'verify-email');
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('link_invalid');
    expect(verifyEmailToken).not.toHaveBeenCalled();
  });
  it('refuses a cross-site request (no pre-auth CSRF token)', async () => {
    const request = new Request(`${origin}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'https://evil.invalid', cookie: `${cookieNames().verify}=${linkToken}` },
      body: JSON.stringify({ password: 'x' }),
    });
    expect((await handleAuthPost(request, 'verify-email')).status).toBe(403);
    expect(verifyEmailToken).not.toHaveBeenCalled();
  });
  it('passes a wrong password through as password_mismatch and keeps the cookie for another try', async () => {
    vi.mocked(verifyEmailToken).mockRejectedValue(
      new AuthError('Enter the password you chose', 400, 'password_mismatch')
    );
    const response = await handleAuthPost(post({ password: 'wrong' }), 'verify-email');
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('password_mismatch');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('reports whether the link in the cookie can still be used', async () => {
    vi.mocked(isVerifyTokenValid).mockResolvedValue(true);
    const request = new Request(`${origin}/api/auth/verify-status`, {
      headers: { cookie: `${cookieNames().verify}=${linkToken}` },
    });
    expect(await (await handleAuthGet(request, 'verify-status')).json()).toEqual({ valid: true });
    expect(isVerifyTokenValid).toHaveBeenCalledWith(linkToken);
    const none = await handleAuthGet(new Request(`${origin}/api/auth/verify-status`), 'verify-status');
    expect(await none.json()).toEqual({ valid: false });
  });
});
