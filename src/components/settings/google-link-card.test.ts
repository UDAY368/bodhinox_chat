import { expect, it, vi } from 'vitest';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/client', () => ({ authFetch, createAuthClient: vi.fn() }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
import { loadGoogleStatus } from './google-link-card';

const google = { configured: true, linked: { email: 'x@gmail.com', linkedAt: '2026-01-01' } };
const reply = (mfa: Response) =>
  authFetch.mockImplementation(async (url: string) => (url === '/api/auth/google' ? new Response(JSON.stringify(google)) : mfa));

it('marks an account created through Google as having no password', async () => {
  reply(new Response(JSON.stringify({ enabled: true, passwordSet: false })));
  await expect(loadGoogleStatus()).resolves.toEqual({ ...google, passwordSet: false });
});

it('keeps the password form when the user has a password or it is unknown', async () => {
  reply(new Response(JSON.stringify({ enabled: false, passwordSet: true })));
  await expect(loadGoogleStatus()).resolves.toMatchObject({ passwordSet: true });
  reply(new Response('{}', { status: 500 }));
  await expect(loadGoogleStatus()).resolves.toMatchObject({ passwordSet: true });
});
