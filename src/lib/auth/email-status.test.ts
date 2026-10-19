import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('./session', () => ({ requireSession: vi.fn(), assertMutation: vi.fn() }));
vi.mock('./service', () => ({ enforceAuthRateLimit: vi.fn() }));
vi.mock('./email', () => ({ checkAuthEmailTransport: vi.fn(), sendAuthEmail: vi.fn() }));
import { requireSession, assertMutation } from './session';
import { checkAuthEmailTransport, sendAuthEmail } from './email';
import { UnauthorizedError } from './errors';
import { handleAuthGet, handleAuthPost } from './http';

afterEach(() => vi.resetAllMocks());
describe('owner-only email diagnostics', () => {
  it('sends a test only to the authenticated owner after mutation authorization', async () => {
    vi.mocked(requireSession).mockResolvedValue({ role: 'owner', userId: 'owner', user: { email: 'owner@example.invalid' } } as Awaited<ReturnType<typeof requireSession>>);
    const request = (body: object) => new Request('https://test.invalid/api/auth/email-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handleAuthPost(request({}), 'email-test')).status).toBe(200);
    expect(assertMutation).toHaveBeenCalled();
    expect(sendAuthEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.invalid' }));
    vi.mocked(sendAuthEmail).mockClear();
    expect((await handleAuthPost(request({ to: 'other@example.invalid' }), 'email-test')).status).toBe(400);
    expect(sendAuthEmail).not.toHaveBeenCalled();
  });
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
