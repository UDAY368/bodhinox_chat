// Phase 14 review (api-ui F1): after the 15-minute access cookie expires the
// console refreshes the session on the client instead of answering 404.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>(), configured: true }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => (h.cookies.has(name) ? { name, value: h.cookies.get(name) } : undefined) }) }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); }, useRouter: () => ({}) }));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/db/prisma', () => ({ platformDatabaseConfigured: () => h.configured }));
vi.mock('@/lib/platform/auth', () => ({ getPlatformPageAccess: async () => null }));

import { cookieNames } from '@/lib/auth/cookies';
import PlatformLayout from './layout';
import { PlatformSessionRefresh } from './_components/platform-session-refresh';

beforeEach(() => { h.cookies = new Map(); h.configured = true; });

describe('platform layout without a usable access cookie', () => {
  it('refreshes on the client when only the refresh cookie is left', async () => {
    h.cookies.set(cookieNames().refresh, 'r');
    const element = await PlatformLayout({ children: null });
    expect((element as { type: unknown }).type).toBe(PlatformSessionRefresh);
  });

  it('stays a 404 when signed out, when the access cookie is there (not an admin), or when the console is off', async () => {
    await expect(PlatformLayout({ children: null })).rejects.toThrow('NEXT_NOT_FOUND');
    h.cookies.set(cookieNames().refresh, 'r');
    h.cookies.set(cookieNames().access, 'a');
    await expect(PlatformLayout({ children: null })).rejects.toThrow('NEXT_NOT_FOUND');
    h.cookies.delete(cookieNames().access);
    h.configured = false;
    await expect(PlatformLayout({ children: null })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
