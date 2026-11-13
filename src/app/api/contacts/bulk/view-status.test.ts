// Stage 5 (5E): the contacts page's channel-filtered list and Instagram status column.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SEGMENT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'viewer', scope: vi.fn(), status: vi.fn() }));

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
}));
vi.mock('@/lib/data/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/data/server')>()),
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
vi.mock('@/lib/contacts/bulk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/contacts/bulk')>()),
  scopeContacts: h.scope,
  contactChannelStatus: h.status,
}));

import { AudienceFilterError } from '@/lib/audience/filter';
import { GET as VIEW } from './view/route';
import { GET as STATUS } from './status/route';

const tenant = { accountId: ACCOUNT, userId: USER, role: 'viewer' };

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'viewer';
  h.scope.mockResolvedValue({ contacts: [], total: 0 });
  h.status.mockResolvedValue({});
});

describe('contacts bulk view', () => {
  it('lists the scope for any member of the session workspace, with bounded paging', async () => {
    const res = await VIEW(new Request(`http://localhost/api/contacts/bulk/view?segmentId=${SEGMENT}&channel=instagram&subscribed=1&offset=50&limit=500`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(h.scope).toHaveBeenCalledWith(tenant, { segmentId: SEGMENT, channel: 'instagram', subscribedOnly: true }, { offset: 50, limit: 100, sort: 'created', dir: 'desc' });
    await VIEW(new Request('http://localhost/api/contacts/bulk/view?offset=-3'));
    expect(h.scope).toHaveBeenLastCalledWith(tenant, {}, { offset: 0, limit: 25, sort: 'created', dir: 'desc' });
  });

  it('answers 400 for an invalid view', async () => {
    h.scope.mockRejectedValueOnce(new AudienceFilterError('Choose one view'));
    expect((await VIEW(new Request('http://localhost/api/contacts/bulk/view?channel=sms'))).status).toBe(400);
  });
});

describe('contacts Instagram status', () => {
  it('reads the listed ids for the session workspace', async () => {
    h.status.mockResolvedValueOnce({ [SEGMENT]: 'subscribed' });
    const res = await STATUS(new Request(`http://localhost/api/contacts/bulk/status?ids=${SEGMENT},x`));
    expect(await res.json()).toEqual({ statuses: { [SEGMENT]: 'subscribed' } });
    expect(h.status).toHaveBeenCalledWith(tenant, [SEGMENT, 'x']);
  });
});
