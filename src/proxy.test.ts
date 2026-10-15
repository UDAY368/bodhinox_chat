import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readdirSync } from 'node:fs';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  enrollment: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({
  resolveSession: mocks.resolve,
  resolveEnrollmentSession: mocks.enrollment,
  assertMutation: mocks.mutation,
}));
import { proxy } from './proxy';
import { ForbiddenError } from '@/lib/auth/errors';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue(null);
  mocks.enrollment.mockResolvedValue(null);
  mocks.mutation.mockResolvedValue(undefined);
});
describe('proxy cookie protections', () => {
  it('redirects unauthenticated dashboard routes', async () => {
    for (const directory of readdirSync('src/app/(dashboard)', {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory())) {
      const response = await proxy(
        new NextRequest(`https://crm.test/${directory.name}`)
      );
      expect(response.status, directory.name).toBe(307);
      expect(response.headers.get('location')).toContain('/login');
    }
  });
  it('allows a refresh-cookie shell without rotating tokens in a GET', async () => {
    const response = await proxy(
      new NextRequest('https://crm.test/dashboard', {
        headers: { cookie: 'bnx_refresh=opaque' },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('denies cookie mutations before route work without CSRF', async () => {
    mocks.resolve.mockResolvedValue({ userId: 'user' });
    mocks.mutation.mockRejectedValue(new ForbiddenError('Invalid CSRF token'));
    const response = await proxy(
      new NextRequest('https://crm.test/api/contacts', {
        method: 'POST',
        headers: { cookie: 'bnx_access=jwt' },
      })
    );
    expect(response.status).toBe(403);
    expect(mocks.mutation).toHaveBeenCalled();
  });
  it('returns 401 for expired access so the browser can safely refresh', async () => {
    const response = await proxy(
      new NextRequest('https://crm.test/api/contacts', {
        method: 'POST',
        headers: { cookie: 'bnx_refresh=opaque' },
      })
    );
    expect(response.status).toBe(401);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
