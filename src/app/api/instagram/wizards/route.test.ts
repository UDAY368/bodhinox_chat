// POST /api/instagram/wizards (Stage 2): the platform flag answers first,
// then session, Origin/CSRF proof, role (agent and above), rate limit and a
// strict body; the draft is written in the caller's own workspace only, and
// only while the workspace can use Instagram.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  enabled: true, signedIn: true, mutationOk: true, rateOk: true, role: 'agent',
  sessions: 0, contexts: [] as unknown[], creates: [] as unknown[],
  instagram: { enabled: true, unavailableReason: null as string | null },
}));

vi.mock('@/lib/instagram/config', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/config')>()),
  instagramConfig: () => (h.enabled ? { appId: 'app' } : null),
}));
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    h.sessions++;
    if (!h.signedIn) throw new (await import('@/lib/auth/errors')).UnauthorizedError();
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) throw new (await import('@/lib/auth/errors')).ForbiddenError('Invalid origin');
  },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: h.rateOk }),
  rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => { h.contexts.push(ctx); return fn({ tx: true }); },
}));
vi.mock('@/lib/channels/workspace', () => ({
  getWorkspaceChannels: async (_tx: unknown, accountId: string) => {
    expect(accountId).toBe(ACCOUNT);
    return { channels: { instagram: h.instagram, whatsapp: { enabled: true } }, enabled: [], chosen: true };
  },
}));
vi.mock('@/lib/instagram/wizards', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/wizards')>()),
  createWizardFlow: async (tx: unknown, owner: unknown, draft: { name: string }) => {
    h.creates.push({ tx, owner, draft });
    return { id: FLOW, name: draft.name, status: 'draft', channel_scope: 'instagram' };
  },
}));

import { POST } from './route';

const body = {
  wizard: 'comment_links',
  keywords: ['link'],
  message: 'Thanks! Tap below for the link.',
  link_url: 'https://shop.example.com/guide',
};
const post = (value: unknown = body) =>
  POST(new Request('http://localhost/api/instagram/wizards', { method: 'POST', body: typeof value === 'string' ? value : JSON.stringify(value) }));

beforeEach(() => {
  Object.assign(h, {
    enabled: true, signedIn: true, mutationOk: true, rateOk: true, role: 'agent', sessions: 0, contexts: [], creates: [],
    instagram: { enabled: true, unavailableReason: null },
  });
});

describe('POST /api/instagram/wizards', () => {
  it('creates a draft Instagram flow in the caller\'s own workspace, as the caller', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ flow: { id: FLOW, name: 'Auto-DM links from comments: link', status: 'draft', channel_scope: 'instagram' } });
    expect(h.contexts).toEqual([{ accountId: ACCOUNT, userId: USER, role: 'agent' }]);
    expect(h.creates).toEqual([{
      tx: { tx: true },
      owner: { accountId: ACCOUNT, userId: USER },
      draft: expect.objectContaining({ trigger_type: 'ig_comment', entry_node_id: 'start' }),
    }]);
  });

  it('answers 503 while Instagram is off, before any session or database work', async () => {
    h.enabled = false;
    const res = await post();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('instagram_not_enabled');
    expect(h.sessions).toBe(0);
    expect(h.contexts).toEqual([]);
  });

  it('needs a live session and Origin/CSRF proof', async () => {
    h.signedIn = false;
    expect((await post()).status).toBe(401);
    h.signedIn = true;
    h.mutationOk = false;
    expect((await post()).status).toBe(403);
    expect(h.contexts).toEqual([]);
    expect(h.creates).toEqual([]);
  });

  it('lets agents, admins and owners create, never viewers', async () => {
    h.role = 'viewer';
    expect((await post()).status).toBe(403);
    expect(h.creates).toEqual([]);
    for (const role of ['agent', 'admin', 'owner']) {
      h.role = role;
      expect((await post()).status).toBe(201);
    }
  });

  it('rate-limits each person', async () => {
    h.rateOk = false;
    expect((await post()).status).toBe(429);
    expect(h.creates).toEqual([]);
  });

  it('names the refused field and what is wrong with it, writing nothing', async () => {
    const res = await post({ ...body, link_url: 'http://shop.example.com' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter a full link that starts with https://.', code: 'invalid_request', field: 'link_url', problem: 'url' });
    expect((await post('not json')).status).toBe(400);
    expect((await post({ ...body, account_id: '44444444-4444-4444-8444-444444444444' })).status).toBe(400);
    expect(h.contexts).toEqual([]);
    expect(h.creates).toEqual([]);
  });

  it('refuses a workspace whose plan lacks Instagram (402) or that turned it off (409)', async () => {
    h.instagram = { enabled: false, unavailableReason: 'plan' };
    let res = await post();
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('plan_required');
    h.instagram = { enabled: false, unavailableReason: null };
    res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('channel_disabled');
    h.instagram = { enabled: false, unavailableReason: 'platform_off' };
    expect((await post()).status).toBe(503);
    expect(h.creates).toEqual([]);
  });
});
