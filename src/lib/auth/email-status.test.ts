import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./session', () => ({ requireSession: vi.fn() }));
vi.mock('./service', () => ({ enforceAuthRateLimit: vi.fn() }));
vi.mock('./email', () => ({ checkAuthEmailTransport: vi.fn() }));
import { requireSession } from './session';
import { checkAuthEmailTransport } from './email';
import { UnauthorizedError } from './errors';
import { handleAuthGet } from './http';

afterEach(() => vi.resetAllMocks());
describe('owner-only email diagnostics', () => {
  it.each(['agent', 'admin', 'viewer'])('rejects %s without connecting to mail', async role => {
    vi.mocked(requireSession).mockResolvedValue({ role } as Awaited<ReturnType<typeof requireSession>>);
    expect((await handleAuthGet(new Request('https://test.invalid/api/auth/email-status'), 'email-status')).status).toBe(403);
    expect(checkAuthEmailTransport).not.toHaveBeenCalled();
  });
  it('rejects signed-out callers', async () => {
    vi.mocked(requireSession).mockRejectedValue(new UnauthorizedError());
    expect((await handleAuthGet(new Request('https://test.invalid/api/auth/email-status'), 'email-status')).status).toBe(401);
    expect(checkAuthEmailTransport).not.toHaveBeenCalled();
  });
  it('returns a credential-free connection result for the owner', async () => {
    vi.mocked(requireSession).mockResolvedValue({ role: 'owner', userId: 'test-owner' } as Awaited<ReturnType<typeof requireSession>>);
    vi.mocked(checkAuthEmailTransport).mockResolvedValue({ configured: true, connected: true });
    const response = await handleAuthGet(new Request('https://test.invalid/api/auth/email-status'), 'email-status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, connected: true });
  });
});
