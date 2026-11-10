import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  withTenant: vi.fn(),
  channels: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@/lib/auth/session', () => ({ resolveSession: mocks.session }));
vi.mock('@/lib/channels/workspace', () => ({ getWorkspaceChannels: mocks.channels }));
vi.mock('@/lib/db/tenant', () => ({ withTenant: mocks.withTenant }));

import { conversationChannelById, resolveInboxRedirect } from './channel-inbox';

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const CONV = '11111111-1111-4111-8111-111111111111';
const tx = { $queryRaw: mocks.query };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ accountId: ACCOUNT, userId: USER, role: 'agent' });
  mocks.withTenant.mockImplementation(async (_ctx: unknown, run: (t: typeof tx) => unknown) => run(tx));
  mocks.channels.mockResolvedValue({ enabled: ['whatsapp'] });
  mocks.query.mockResolvedValue([]);
});

describe('resolveInboxRedirect', () => {
  it('reads the channels under the member\'s own tenant', async () => {
    expect(await resolveInboxRedirect('all', { filter: 'unread' })).toBe('/whatsapp/inbox?filter=unread');
    expect(mocks.withTenant).toHaveBeenCalledWith({ accountId: ACCOUNT, userId: USER, role: 'agent' }, expect.any(Function));
    expect(mocks.channels).toHaveBeenCalledWith(tx, ACCOUNT);
    // No ?c=: no conversation lookup.
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('keeps the All view while both channels are enabled', async () => {
    mocks.channels.mockResolvedValue({ enabled: ['whatsapp', 'instagram'] });
    expect(await resolveInboxRedirect('all', {})).toBeNull();
  });

  it('opens an old ?c= link in its conversation\'s channel inbox', async () => {
    mocks.channels.mockResolvedValue({ enabled: ['instagram'] });
    mocks.query.mockResolvedValue([{ channel: 'instagram' }]);
    expect(await resolveInboxRedirect('all', { c: CONV })).toBe(`/instagram/inbox?c=${CONV}`);
    mocks.channels.mockResolvedValue({ enabled: ['whatsapp', 'instagram'] });
    expect(await resolveInboxRedirect('whatsapp', { c: CONV })).toBe(`/instagram/inbox?c=${CONV}`);
  });

  it('counts a conversation with no channel as WhatsApp', async () => {
    mocks.channels.mockResolvedValue({ enabled: ['whatsapp', 'instagram'] });
    mocks.query.mockResolvedValue([{ channel: null }]);
    expect(await resolveInboxRedirect('instagram', { c: CONV })).toBe(`/whatsapp/inbox?c=${CONV}`);
    expect(await resolveInboxRedirect('whatsapp', { c: CONV })).toBeNull();
  });

  it('renders the page without a session, or when anything fails', async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect(await resolveInboxRedirect('all', {})).toBeNull();
    expect(mocks.withTenant).not.toHaveBeenCalled();
    mocks.channels.mockRejectedValueOnce(new Error('database down'));
    expect(await resolveInboxRedirect('all', {})).toBeNull();
    mocks.session.mockRejectedValueOnce(new Error('auth down'));
    expect(await resolveInboxRedirect('whatsapp', { c: CONV })).toBeNull();
  });
});

describe('conversationChannelById', () => {
  it('filters by the account and never queries for a non-uuid id', async () => {
    expect(await conversationChannelById(tx as never, ACCOUNT, 'not-a-uuid')).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
    mocks.query.mockResolvedValueOnce([]);
    expect(await conversationChannelById(tx as never, ACCOUNT, CONV)).toBeNull();
    const sql = mocks.query.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join('?')).toMatch(/WHERE id=\?::uuid AND account_id=\?::uuid/);
    expect(sql.values).toEqual([CONV, ACCOUNT]);
  });
});
