import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', get: vi.fn(), save: vi.fn() }));

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
vi.mock('@/lib/commerce/notice-templates', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/notice-templates')>()),
  getNoticeTemplates: h.get,
  saveNoticeTemplate: h.save,
}));

import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://localhost/api/commerce/notice-templates', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.get.mockResolvedValue({ settings: [], options: [] });
  h.save.mockResolvedValue({ settings: [], options: [] });
});

describe('/api/commerce/notice-templates', () => {
  it('lets agents read, never cached', async () => {
    h.role = 'agent';
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(h.get).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' });
  });

  it('refuses viewers reading and agents writing', async () => {
    h.role = 'viewer';
    expect((await GET()).status).toBe(403);
    h.role = 'agent';
    expect((await put({ kind: 'delivered', template_name: 'a', language: 'en' })).status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('saves a parsed setting as the admin and refuses a bad body before any write', async () => {
    expect((await put({ kind: 'repeat_purchase', template_name: 'offer', language: 'en' })).status).toBe(200);
    expect(h.save).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' },
      { kind: 'repeat_purchase', template: { name: 'offer', language: 'en' } });
    const bad = await put({ kind: 'product_follow_up', template_name: 'x', language: 'en' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid' });
    expect(h.save).toHaveBeenCalledTimes(1);
  });
});
