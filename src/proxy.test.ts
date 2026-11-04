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
  it('protects the staff appointments page', async () => {
    const response = await proxy(new NextRequest('https://crm.test/appointments?tab=services'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });
  it('sends a signed-out visitor of a shared report to sign-in and back', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const response = await proxy(new NextRequest(`https://crm.test/reports/shared/${id}`));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe(`/reports/shared/${id}`);
  });
});
describe('public booking exemption', () => {
  const post = (cookie?: string) =>
    proxy(
      new NextRequest('https://crm.test/api/public/booking/clinic', {
        method: 'POST',
        headers: cookie ? { cookie } : {},
      })
    );
  it('passes an anonymous POST to the route', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('passes a POST with a live staff session and no CSRF header to the route', async () => {
    mocks.resolve.mockResolvedValue({ userId: 'user' });
    mocks.mutation.mockRejectedValue(new ForbiddenError('Invalid CSRF token'));
    const response = await post('bnx_access=jwt');
    expect(response.status).toBe(200);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it('passes a POST with an expired session cookie to the route', async () => {
    const response = await post('bnx_refresh=opaque');
    expect(response.status).toBe(200);
  });
  it('leaves the public pages and the manage API unauthenticated', async () => {
    for (const path of ['/book/clinic', '/my-booking/abc', '/api/public/booking/manage/abc'])
      expect((await proxy(new NextRequest(`https://crm.test${path}`))).status, path).toBe(200);
  });
  it('does not exempt a look-alike prefix', async () => {
    const response = await proxy(
      new NextRequest('https://crm.test/api/public/bookingx', {
        method: 'POST',
        headers: { cookie: 'bnx_refresh=opaque' },
      })
    );
    expect(response.status).toBe(401);
  });
});
