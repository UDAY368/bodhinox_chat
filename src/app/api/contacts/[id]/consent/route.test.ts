import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), set: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}));
vi.mock('@/lib/contacts/whatsapp-consent', () => ({ setWhatsAppConsent: mocks.set }));

import { POST } from './route';

const CONTACT = '3f2b6c1e-8a4d-4b7e-9c2a-1d5e6f7a8b9c';
const ctx = { accountId: 'account-1', userId: 'user-1', role: 'agent' };
const call = (id: string, body: unknown) =>
  POST(new Request(`http://localhost/api/contacts/${id}/consent`, { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

describe('POST /api/contacts/[id]/consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue(ctx);
  });

  it('records the state for the signed-in member and workspace', async () => {
    mocks.set.mockResolvedValue({ changed: true, contact: { opted_in_at: 'x', opt_in_source: 'agent', opted_out_at: null, opt_out_source: null } });
    const res = await call(CONTACT, { state: 'opted_in' });
    expect(res.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.set).toHaveBeenCalledWith({ accountId: 'account-1', userId: 'user-1', role: 'agent' }, CONTACT, 'opted_in');
  });

  it('refuses a bad state or id without writing', async () => {
    expect((await call(CONTACT, { state: 'maybe' })).status).toBe(400);
    expect((await call(CONTACT, {})).status).toBe(400);
    expect((await call('not-a-uuid', { state: 'opted_out' })).status).toBe(400);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('accepts cleared, which removes an opt-out only', async () => {
    mocks.set.mockResolvedValue({ changed: true, contact: {} });
    expect((await call(CONTACT, { state: 'cleared' })).status).toBe(200);
    expect(mocks.set).toHaveBeenCalledWith(expect.anything(), CONTACT, 'cleared');
  });

  it("answers 404 for a contact outside the workspace", async () => {
    mocks.set.mockResolvedValue(null);
    expect((await call(CONTACT, { state: 'opted_out' })).status).toBe(404);
  });

  it('stops at the role check', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    expect((await call(CONTACT, { state: 'opted_out' })).status).toBe(403);
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
