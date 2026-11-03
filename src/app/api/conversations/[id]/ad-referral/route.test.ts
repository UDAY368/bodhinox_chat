import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'viewer', lookup: vi.fn(), session: true }));

vi.mock('@/lib/auth/session', async () => {
  const { UnauthorizedError } = await import('@/lib/auth/errors');
  return {
    requireSession: async () => {
      if (!h.session) throw new UnauthorizedError();
      return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
    },
  };
});
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
vi.mock('@/lib/meta-ads/conversation-referral', async (original) => ({
  ...(await original<typeof import('@/lib/meta-ads/conversation-referral')>()),
  conversationAdReferral: h.lookup,
}));

import { ConversationNotFoundError } from '@/lib/meta-ads/conversation-referral';
import { GET } from './route';

const get = (id = CONVERSATION) => GET(new Request(`http://localhost/api/conversations/${id}/ad-referral`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'viewer';
  h.session = true;
});

describe('GET /api/conversations/[id]/ad-referral', () => {
  it('returns only the headline, source URL, source type and time to any member, no-store', async () => {
    h.lookup.mockResolvedValue({ headline: 'Sale', sourceUrl: 'https://fb.me/x', sourceType: 'ad', createdAt: '2026-11-01T00:00:00.000Z', ctwaClid: 'leak' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body).toEqual({ referral: { headline: 'Sale', source_url: 'https://fb.me/x', source_type: 'ad', created_at: '2026-11-01T00:00:00.000Z' } });
    expect(JSON.stringify(body)).not.toContain('leak');
    expect(h.lookup).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' }, CONVERSATION);
  });

  it('answers null for a conversation that did not start from an ad', async () => {
    h.lookup.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ referral: null });
  });

  it('answers 404 for a conversation the caller cannot see', async () => {
    h.lookup.mockRejectedValue(new ConversationNotFoundError());
    const res = await get();
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('not_found');
  });

  it('refuses a request without a live session before any read', async () => {
    h.session = false;
    expect((await get()).status).toBe(401);
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
