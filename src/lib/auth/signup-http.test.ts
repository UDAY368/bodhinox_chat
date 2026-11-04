import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./service', () => ({ enforceAuthRateLimit: vi.fn(), signup: vi.fn() }));
import { signup } from './service';
import { cookieNames } from './cookies';
import { randomToken } from './csrf';
import { AuthError } from './errors';
import { handleAuthPost } from './http';

const origin = 'https://signup.test.invalid';
function request(body: object): Request {
  const csrf = randomToken();
  return new Request(`${origin}/api/auth/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      origin,
      cookie: `${cookieNames().csrf}=${csrf}`,
      'x-csrf-token': csrf,
    },
    body: JSON.stringify(body),
  });
}
const base = { email: 'new@example.invalid', password: 'Abcdef1!', fullName: 'New person' };

beforeEach(() => vi.stubEnv('APP_URL', origin));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('signup request schema', () => {
  it('passes a well-formed invitation token through to signup', async () => {
    const invite = randomToken();
    expect((await handleAuthPost(request({ ...base, invite }), 'signup')).status).toBe(200);
    expect(signup).toHaveBeenCalledWith(expect.objectContaining({ invite }));
  });
  it('accepts a signup without an invitation', async () => {
    expect((await handleAuthPost(request(base), 'signup')).status).toBe(200);
    expect(vi.mocked(signup).mock.calls[0][0]).not.toHaveProperty('invite');
  });
  it.each(['short', `${'a'.repeat(43)}!`, 'a'.repeat(44)])(
    'leaves a malformed invitation token %s to signup, which answers it as an unusable link',
    async (invite) => {
      expect((await handleAuthPost(request({ ...base, invite }), 'signup')).status).toBe(200);
      expect(signup).toHaveBeenCalledWith(expect.objectContaining({ invite }));
    }
  );
  it.each([42, 'a'.repeat(257)])('rejects a non-string or oversized invitation %s', async (invite) => {
    expect((await handleAuthPost(request({ ...base, invite }), 'signup')).status).toBe(400);
    expect(signup).not.toHaveBeenCalled();
  });
  it('returns the unavailable-invitation refusal as a 410 with its code', async () => {
    vi.mocked(signup).mockRejectedValue(
      new AuthError('This invitation link is no longer valid.', 410, 'invite_unavailable')
    );
    const response = await handleAuthPost(request({ ...base, invite: randomToken() }), 'signup');
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe('invite_unavailable');
  });
});
