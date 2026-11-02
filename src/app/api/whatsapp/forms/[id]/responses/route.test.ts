import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FORM = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'viewer', listResponses: vi.fn() }));

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
vi.mock('@/lib/whatsapp/forms/service', async (original) => ({
  ...(await original<typeof import('@/lib/whatsapp/forms/service')>()),
  listResponses: h.listResponses,
}));

import { FormServiceError } from '@/lib/whatsapp/forms/service';
import { GET } from './route';

const get = (query = '') => GET(new Request(`http://localhost/r${query}`), { params: Promise.resolve({ id: FORM }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'viewer';
  h.listResponses.mockResolvedValue({ responses: [], next_cursor: null });
});

it('lists responses to any member, like the inbox, passing cursor and limit', async () => {
  const res = await get('?cursor=abc&limit=20');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ responses: [], next_cursor: null });
  expect(h.listResponses).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' }, FORM, { cursor: 'abc', limit: 20 });
});

it('maps a bad cursor to 400 and another account to 404', async () => {
  h.listResponses.mockRejectedValueOnce(new FormServiceError(400, 'bad cursor'));
  expect((await get('?cursor=zz')).status).toBe(400);
  h.listResponses.mockRejectedValueOnce(new FormServiceError(404, 'nope'));
  expect((await get()).status).toBe(404);
});
