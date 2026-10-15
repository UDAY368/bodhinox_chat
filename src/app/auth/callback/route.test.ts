import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  recovery: vi.fn(),
  emailChange: vi.fn(),
}));
vi.mock('@/lib/auth/service', () => ({
  verifyEmailToken: mocks.verify,
  isRecoveryTokenValid: mocks.recovery,
  confirmEmailChange: mocks.emailChange,
}));
import { GET } from './route';
const token = 'a'.repeat(43);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue(undefined);
  mocks.recovery.mockResolvedValue(true);
});
describe('one-time email callback', () => {
  it('verifies an email without issuing a login session', async () => {
    const response = await GET(
      new Request(
        `https://crm.test/auth/callback?token=${token}&purpose=verify&next=%2Fjoin%2Finvite`
      )
    );
    expect(mocks.verify).toHaveBeenCalledWith(token);
    expect(response.headers.get('location')).toBe(
      '/login?verified=1&next=%2Fjoin%2Finvite'
    );
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('places reset proof in an HttpOnly cookie, then removes the secret from the URL', async () => {
    const response = await GET(
      new Request(`https://crm.test/auth/callback?token=${token}&purpose=reset`)
    );
    expect(response.headers.get('location')).toBe('/reset-password');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('rejects expired reset links and unsafe destinations', async () => {
    mocks.recovery.mockResolvedValue(false);
    expect(
      (
        await GET(
          new Request(
            `https://crm.test/auth/callback?token=${token}&purpose=reset`
          )
        )
      ).headers.get('location')
    ).toContain('link_invalid');
    const response = await GET(
      new Request(
        `https://crm.test/auth/callback?token=${token}&purpose=verify&next=%2F%2Fevil.test`
      )
    );
    expect(response.headers.get('location')).toBe(
      '/login?verified=1&next=%2Fdashboard'
    );
  });
  it('confirms a new email and clears every browser credential', async () => {
    const response = await GET(
      new Request(
        `https://crm.test/auth/callback?token=${token}&purpose=change_email`
      )
    );
    expect(mocks.emailChange).toHaveBeenCalledWith(token);
    expect(response.headers.get('location')).toBe('/login?email_changed=1');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
