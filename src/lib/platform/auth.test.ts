import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  session: null as null | { userId: string; sessionId: string; accountId: string; role: string; user: { email: string } },
  factor: true,
  verifiedAt: null as Date | null,
  mutationChecked: 0,
  mutationOk: true,
  configured: true,
}));

vi.mock('@/lib/auth/session', async () => {
  const { UnauthorizedError } = await import('@/lib/auth/errors');
  return {
    requireSession: async () => {
      if (!h.session) throw new UnauthorizedError();
      return h.session;
    },
    resolveSession: async () => h.session,
    assertMutation: async () => {
      h.mutationChecked += 1;
      if (!h.mutationOk) throw new UnauthorizedError();
    },
  };
});
vi.mock('@/lib/db/prisma', () => ({
  platformDatabaseConfigured: () => h.configured,
  getAuthPrisma: () => ({ $queryRaw: async () => [{ factor: h.factor, mfa_verified_at: h.verifiedAt }] }),
}));

import { getPlatformPageAccess, mfaDecision, platformMfaMaxAgeMs, requirePlatformAdmin } from './auth';

const request = () => new Request('https://app.test/api/platform/tenants', { method: 'POST' });
const hours = (n: number) => new Date(Date.now() - n * 3_600_000);

beforeEach(() => {
  process.env.PLATFORM_ADMIN_EMAILS = 'ops@bodhinox.test';
  delete process.env.PLATFORM_ADMIN_MFA_MAX_AGE;
  h.session = { userId: 'u1', sessionId: 's1', accountId: 'a1', role: 'owner', user: { email: 'Ops@Bodhinox.test' } };
  h.factor = true;
  h.verifiedAt = hours(1);
  h.mutationChecked = 0;
  h.mutationOk = true;
  h.configured = true;
});

describe('requirePlatformAdmin', () => {
  it('admits an allowlisted admin with a verified factor and a recent MFA check', async () => {
    await expect(requirePlatformAdmin(request())).resolves.toEqual({ userId: 'u1', sessionId: 's1', email: 'ops@bodhinox.test' });
    expect(h.mutationChecked).toBe(0);
  });

  it('answers 404 for the console when PLATFORM_DATABASE_URL is unset, even for an admin', async () => {
    h.configured = false;
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 404 });
    // The worker-role routes (prices, rate cards) do not need the console database.
    await expect(requirePlatformAdmin(request(), { console: false })).resolves.toMatchObject({ email: 'ops@bodhinox.test' });
  });

  it('hides the console (404) from non-admins; a signed-out or expired session gets 401 so the client refreshes it', async () => {
    h.session = null;
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 401 });
    h.configured = false;
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 404 });
    h.configured = true;
    await expect(requirePlatformAdmin(request(), { console: false })).rejects.toMatchObject({ status: 401 });
    h.session = { userId: 'u2', sessionId: 's2', accountId: 'a1', role: 'owner', user: { email: 'owner@customer.test' } };
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 404 });
    await expect(requirePlatformAdmin(request(), { console: false })).rejects.toMatchObject({ status: 403 });
    process.env.PLATFORM_ADMIN_EMAILS = '';
    h.session = { userId: 'u1', sessionId: 's1', accountId: 'a1', role: 'owner', user: { email: 'ops@bodhinox.test' } };
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 404 });
  });

  it('requires a verified MFA factor, then a recent step-up', async () => {
    h.factor = false;
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 403, code: 'mfa_enrollment_required' });
    h.factor = true;
    h.verifiedAt = null;
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ status: 403, code: 'mfa_step_up_required' });
    h.verifiedAt = hours(13);
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ code: 'mfa_step_up_required' });
    process.env.PLATFORM_ADMIN_MFA_MAX_AGE = '30m';
    h.verifiedAt = hours(1);
    await expect(requirePlatformAdmin(request())).rejects.toMatchObject({ code: 'mfa_step_up_required' });
  });

  it('checks origin/CSRF for mutations, after the admin and MFA checks', async () => {
    h.mutationOk = false;
    await expect(requirePlatformAdmin(request(), { mutation: true })).rejects.toMatchObject({ status: 401 });
    expect(h.mutationChecked).toBe(1);
    h.verifiedAt = null;
    h.mutationChecked = 0;
    await expect(requirePlatformAdmin(request(), { mutation: true })).rejects.toMatchObject({ code: 'mfa_step_up_required' });
    expect(h.mutationChecked).toBe(0);
  });

  it('rate limits mutations per admin', async () => {
    h.session = { userId: `u-${Date.now()}`, sessionId: 's', accountId: 'a1', role: 'owner', user: { email: 'ops@bodhinox.test' } };
    for (let i = 0; i < 30; i++) await requirePlatformAdmin(request(), { mutation: true });
    await expect(requirePlatformAdmin(request(), { mutation: true })).rejects.toMatchObject({ status: 429 });
  });
});

describe('MFA age', () => {
  it('parses PLATFORM_ADMIN_MFA_MAX_AGE in minutes or hours, defaulting to 12 h, at most 24 h', () => {
    expect(platformMfaMaxAgeMs({})).toBe(12 * 3_600_000);
    expect(platformMfaMaxAgeMs({ PLATFORM_ADMIN_MFA_MAX_AGE: '90m' })).toBe(90 * 60_000);
    expect(platformMfaMaxAgeMs({ PLATFORM_ADMIN_MFA_MAX_AGE: '2h' })).toBe(2 * 3_600_000);
    expect(platformMfaMaxAgeMs({ PLATFORM_ADMIN_MFA_MAX_AGE: '4' })).toBe(4 * 3_600_000);
    expect(platformMfaMaxAgeMs({ PLATFORM_ADMIN_MFA_MAX_AGE: '48h' })).toBe(12 * 3_600_000);
    expect(platformMfaMaxAgeMs({ PLATFORM_ADMIN_MFA_MAX_AGE: 'soon' })).toBe(12 * 3_600_000);
  });

  it('rejects a verification time in the future', () => {
    expect(mfaDecision({ factor: true, verifiedAt: new Date(Date.now() + 3_600_000) })).toBe('step_up');
  });
});

describe('getPlatformPageAccess', () => {
  it('is null (render 404) unless configured and allowlisted; reports step-up for an admin', async () => {
    expect(await getPlatformPageAccess()).toEqual({ kind: 'ok', admin: { userId: 'u1', sessionId: 's1', email: 'ops@bodhinox.test' } });
    h.verifiedAt = hours(20);
    expect(await getPlatformPageAccess()).toEqual({ kind: 'step_up' });
    h.configured = false;
    expect(await getPlatformPageAccess()).toBeNull();
    h.configured = true;
    h.session = null;
    expect(await getPlatformPageAccess()).toBeNull();
  });
});
