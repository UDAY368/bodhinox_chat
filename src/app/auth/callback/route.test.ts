import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verifyValid: vi.fn(),
  recovery: vi.fn(),
  emailChange: vi.fn(),
}));
vi.mock('@/lib/auth/service', () => ({
  isVerifyTokenValid: mocks.verifyValid,
  isRecoveryTokenValid: mocks.recovery,
  confirmEmailChange: mocks.emailChange,
}));
import { GET } from './route';
const token = 'a'.repeat(43);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyValid.mockResolvedValue(true);
  mocks.recovery.mockResolvedValue(true);
});
describe('one-time email callback', () => {
  it('sends a verify link to the password step with the token in an HttpOnly cookie, not a session', async () => {
    const response = await GET(
      new Request(
        `https://crm.test/auth/callback?token=${token}&purpose=verify&next=%2Fjoin%2Finvite`
      )
    );
    expect(mocks.verifyValid).toHaveBeenCalledWith(token);
    expect(response.headers.get('location')).toBe(
      '/verify-email?next=%2Fjoin%2Finvite'
    );
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`bnx_verify=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('bnx_access');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('refuses a spent or expired verify link without setting a cookie', async () => {
    mocks.verifyValid.mockResolvedValue(false);
    const response = await GET(
      new Request(`https://crm.test/auth/callback?token=${token}&purpose=verify`)
    );
    expect(response.headers.get('location')).toBe('/login?error=link_invalid');
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
      '/verify-email?next=%2Fdashboard'
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
