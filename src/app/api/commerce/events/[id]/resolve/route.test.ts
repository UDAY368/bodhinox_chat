import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const EVENT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', resolve: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/commerce/event-attention', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/event-attention')>()),
  resolveCommerceEvent: h.resolve,
}));

import { AttentionError } from '@/lib/commerce/event-attention';
import { POST } from './route';

const post = (body: unknown) => POST(
  new Request(`http://localhost/api/commerce/events/${EVENT}/resolve`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }),
  { params: Promise.resolve({ id: EVENT }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.resolve.mockResolvedValue({ id: EVENT, status: 'sent' });
});

describe('POST /api/commerce/events/[id]/resolve', () => {
  it.each(['sent', 'not_sent'])('records %s as the caller', async (resolution) => {
    const res = await post({ resolution });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: { id: EVENT, status: 'sent' } });
    expect(h.resolve).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, EVENT, resolution);
  });

  it.each([{}, { resolution: 'resend' }, { resolution: true }, 'not json', [1]])('rejects a bad body %#', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('resolution');
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each(['agent', 'viewer'])('refuses %s', async (role) => {
    h.role = role;
    expect((await post({ resolution: 'sent' })).status).toBe(403);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each([['not_found', 404], ['not_open', 409]] as const)('maps %s to %i', async (code, status) => {
    h.resolve.mockRejectedValueOnce(new AttentionError(code, status));
    const res = await post({ resolution: 'sent' });
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });
});
