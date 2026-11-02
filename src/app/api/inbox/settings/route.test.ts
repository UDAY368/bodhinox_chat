import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({ role: 'admin', load: vi.fn(), save: vi.fn() }));

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
vi.mock('@/lib/inbox/inbox-settings', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/inbox-settings')>()),
  loadInboxSettings: h.load,
  saveInboxSettings: h.save,
}));

import { GET, PUT } from './route';

const settings = {
  timezone: 'UTC', working_hours: {}, away_message_enabled: false, away_message: null,
  auto_resolve_after_hours: null, sla_first_response_minutes: 30,
};
const put = (body: unknown) => PUT(new Request('http://x/api/inbox/settings', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'admin';
  h.load.mockResolvedValue(settings);
  h.save.mockImplementation(async (_tenant: unknown, value: unknown) => value);
});

describe('GET /api/inbox/settings', () => {
  it.each(['viewer', 'agent', 'admin'])('lets a %s read as themselves', async (role) => {
    h.role = role;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ settings });
    expect(h.load).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role });
  });
});

describe('PUT /api/inbox/settings', () => {
  it.each(['agent', 'viewer'])('refuses %s', async (role) => {
    h.role = role;
    expect((await put(settings)).status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });
  it('rejects an invalid body with its field code', async () => {
    const res = await put({ ...settings, timezone: 'Nowhere/Land' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_timezone' });
    expect(h.save).not.toHaveBeenCalled();
  });
  it('saves the parsed settings as the admin', async () => {
    const res = await put({ ...settings, sla_first_response_minutes: 15 });
    expect(res.status).toBe(200);
    expect(h.save).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'admin' }, { ...settings, sla_first_response_minutes: 15 });
  });
});
