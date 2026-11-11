// POST /api/inbox/pause (Stage 5, 5D): agent role and above, validated body,
// the conversation read as the member (another workspace's id is 404), and the
// proxy's CSRF check in front of it. Real RLS and tenancy:
// src/lib/inbox/automation-pause.integration.test.ts.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const h = vi.hoisted(() => ({
  role: 'agent',
  conversation: null as { contact_id: string | null } | null,
  row: null as { bot_paused: boolean; bot_paused_until: Date | null; bot_paused_by: string | null } | null,
  tenants: [] as unknown[],
  pause: vi.fn(),
  resume: vi.fn(),
  mutation: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
  resolveSession: h.resolve,
  resolveEnrollmentSession: async () => null,
  assertMutation: h.mutation,
}));
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
vi.mock('@/lib/db/tenant', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant')>()),
  withTenant: async (tenant: unknown, work: (tx: unknown) => unknown) => {
    h.tenants.push(tenant);
    let reads = 0;
    return work({ $queryRaw: async () => (reads++ === 0 ? (h.conversation ? [h.conversation] : []) : (h.row ? [h.row] : [])) });
  },
}));
vi.mock('@/lib/inbox/automation-pause', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/automation-pause')>()),
  pauseAutomations: h.pause,
  resumeAutomations: h.resume,
}));

import { POST } from './route';
import { proxy } from '@/proxy';
import { ForbiddenError } from '@/lib/auth/errors';

const post = (body: unknown) => POST(new Request('http://x/api/inbox/pause', { method: 'POST', body: JSON.stringify(body) }));
const UNTIL = new Date('2026-11-11T13:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.tenants = [];
  h.conversation = { contact_id: CONTACT };
  h.row = { bot_paused: true, bot_paused_until: new Date(Date.now() + 3 * 3_600_000), bot_paused_by: USER };
  h.mutation.mockResolvedValue(undefined);
  h.resolve.mockResolvedValue(null);
});

describe('POST /api/inbox/pause', () => {
  it('refuses a viewer', async () => {
    h.role = 'viewer';
    expect((await post({ conversation_id: CONVERSATION, action: 'pause', minutes: 180 })).status).toBe(403);
    expect(h.pause).not.toHaveBeenCalled();
  });

  it('pauses one conversation as the member, records who, and answers until when', async () => {
    const res = await post({ conversation_id: CONVERSATION, action: 'pause', minutes: 180 });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const json = await res.json();
    expect(json).toMatchObject({ paused: true, paused_by: USER });
    expect(typeof json.until).toBe('string');
    expect(h.tenants).toEqual([{ accountId: ACCOUNT, userId: USER, role: 'agent' }]);
    expect(h.pause).toHaveBeenCalledWith(ACCOUNT, { conversationId: CONVERSATION, minutes: 180, byUserId: USER }, expect.anything());
  });

  it('pauses all of the contact’s conversations when asked, until resumed by default', async () => {
    h.row = { bot_paused: true, bot_paused_until: null, bot_paused_by: USER };
    const res = await post({ conversation_id: CONVERSATION, action: 'pause', scope: 'contact' });
    expect(await res.json()).toEqual({ paused: true, until: null, paused_by: USER });
    expect(h.pause).toHaveBeenCalledWith(ACCOUNT, { contactId: CONTACT, minutes: null, byUserId: USER }, expect.anything());
  });

  it('resumes', async () => {
    h.row = { bot_paused: false, bot_paused_until: null, bot_paused_by: null };
    const res = await post({ conversation_id: CONVERSATION, action: 'resume' });
    expect(await res.json()).toEqual({ paused: false, until: null, paused_by: null });
    expect(h.resume).toHaveBeenCalledWith(ACCOUNT, { conversationId: CONVERSATION, byUserId: USER }, expect.anything());
  });

  it('reports an expired pause as not paused', async () => {
    h.row = { bot_paused: true, bot_paused_until: UNTIL, bot_paused_by: USER };
    expect(await (await post({ conversation_id: CONVERSATION, action: 'pause', minutes: 30 })).json())
      .toEqual({ paused: false, until: null, paused_by: null });
  });

  it('is 404 for a conversation it cannot see (another workspace’s), writing nothing', async () => {
    h.conversation = null;
    expect((await post({ conversation_id: CONVERSATION, action: 'pause', minutes: 30 })).status).toBe(404);
    expect(h.pause).not.toHaveBeenCalled();
  });

  it.each([
    { conversation_id: 'x', action: 'pause' },
    { conversation_id: CONVERSATION, action: 'pause', minutes: 45 },
    { conversation_id: CONVERSATION, action: 'later' },
  ])('refuses %j as invalid_pause', async (body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_pause' });
    expect(h.pause).not.toHaveBeenCalled();
  });

  it('sits behind the proxy’s CSRF check for cookie sessions', async () => {
    h.resolve.mockResolvedValue({ userId: USER });
    h.mutation.mockRejectedValue(new ForbiddenError('Invalid CSRF token'));
    const response = await proxy(new NextRequest('https://crm.test/api/inbox/pause', {
      method: 'POST', headers: { cookie: 'bnx_access=jwt' }, body: JSON.stringify({ conversation_id: CONVERSATION, action: 'resume' }),
    }));
    expect(response.status).toBe(403);
    expect(h.mutation).toHaveBeenCalled();
  });
});
