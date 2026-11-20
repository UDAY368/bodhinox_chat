import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ contacts: vi.fn(), global: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: 'viewer', sessionId: 's' }) }));
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
vi.mock('@/lib/search/contacts', async (original) => ({ ...(await original<object>()), searchContacts: h.contacts }));
vi.mock('@/lib/search/global', async (original) => ({ ...(await original<object>()), globalSearch: h.global }));

import { GET as contactSearch } from '../contacts/search/route';
import { GET as search } from './route';

const get = (path: string) => new Request(`http://localhost${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  h.contacts.mockResolvedValue({ contacts: [], nextCursor: null });
  h.global.mockResolvedValue({ contacts: [], orders: [], products: [], bookings: [] });
});

it('searches contacts for any member, private and uncached, with the limit capped', async () => {
  const res = await contactSearch(get('/api/contacts/search?q=%2B91%2098765&limit=500&channel=whatsapp'));
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(h.contacts).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' },
    { q: '+91 98765', cursor: null, limit: 50, channel: 'whatsapp' });
});

it('refuses bad contact search parameters with 400', async () => {
  h.contacts.mockImplementation(async (_ctx, input: { cursor: string | null }) => {
    const { decodeCursor } = await import('@/lib/search/normalise');
    if (input.cursor) decodeCursor(input.cursor);
    return { contacts: [], nextCursor: null };
  });
  for (const query of ['channel=sms', 'limit=0', 'limit=abc', `q=${'x'.repeat(101)}`, 'cursor=garbage'])
    expect((await contactSearch(get(`/api/contacts/search?${query}`))).status).toBe(400);
});

it('runs the global search with the caller tenant', async () => {
  const res = await search(get('/api/search?q=asha&limit=20'));
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(h.global).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'viewer' }, { q: 'asha', limit: 8 });
  expect((await search(get('/api/search?limit=-1'))).status).toBe(400);
});
