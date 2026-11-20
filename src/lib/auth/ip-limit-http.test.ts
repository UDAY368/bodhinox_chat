import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// An in-memory stand-in for the durable limiter (auth_rate_limits), with the same 429 refusal.
const counts = vi.hoisted(() => new Map<string, number>());
vi.mock('./service', async () => {
  const { AuthError, UnauthorizedError } = await import('./errors');
  return {
    enforceAuthRateLimit: vi.fn(async (action: string, identity: string, maximum = 10) => {
      const key = `${action}:${identity}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (counts.get(key)! > maximum) throw new AuthError('Too many attempts. Try again later.', 429, 'rate_limited');
    }),
    signup: vi.fn(),
    requestEmail: vi.fn(),
    login: vi.fn(async () => { throw new UnauthorizedError('Invalid email or password'); }),
  };
});
import { cookieNames } from './cookies';
import { randomToken } from './csrf';
import { AUTH_IP_LIMITS, handleAuthPost } from './http';

const origin = 'https://ip-limit.test.invalid';
function request(action: string, body: object, ip: string): Request {
  const csrf = randomToken();
  return new Request(`${origin}/api/auth/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin,
      cookie: `${cookieNames().csrf}=${csrf}`,
      'x-csrf-token': csrf,
      // The leftmost hop is client-controlled and changes every time; only the edge's hop counts.
      'x-forwarded-for': `${randomToken().slice(0, 8)}, ${ip}`,
    },
    body: JSON.stringify(body),
  });
}
const bodies: Record<string, (n: number) => object> = {
  signup: (n) => ({ email: `person${n}@example.invalid`, password: 'Abcdef1!', fullName: 'Person' }),
  login: (n) => ({ email: `person${n}@example.invalid`, password: 'wrong' }),
  'reset-request': (n) => ({ email: `person${n}@example.invalid` }),
};

beforeEach(() => vi.stubEnv('APP_URL', origin));
afterEach(() => {
  vi.unstubAllEnvs();
  counts.clear();
});
describe('per-IP auth limits', () => {
  it.each(['signup', 'login', 'reset-request'])(
    '%s: many different emails from one IP are limited with the generic 429; another IP is independent',
    async (action) => {
      const { maximum } = AUTH_IP_LIMITS[action];
      const allowed = action === 'login' ? 401 : 200;
      for (let n = 0; n < maximum; n++)
        expect((await handleAuthPost(request(action, bodies[action](n), '198.51.100.7'), action)).status).toBe(allowed);
      const limited = await handleAuthPost(request(action, bodies[action](maximum), '198.51.100.7'), action);
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toEqual({ message: 'Too many attempts. Try again later.', code: 'rate_limited' });
      expect((await handleAuthPost(request(action, bodies[action](0), '203.0.113.9'), action)).status).toBe(allowed);
    }
  );
  it('login over the browser and the token client share one per-IP budget', () => {
    expect(AUTH_IP_LIMITS['token-login']).toEqual(AUTH_IP_LIMITS.login);
  });
});
