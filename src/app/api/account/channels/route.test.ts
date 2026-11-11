import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  role: 'admin', session: true, mutationOk: true, rateOk: true, contexts: [] as unknown[],
  getWorkspaceChannels: vi.fn(), setWorkspaceChannels: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.session) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
    return { userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { ForbiddenError } = await import('@/lib/auth/errors');
      throw new ForbiddenError('Invalid request origin');
    }
  },
}));
vi.mock('@/lib/data/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: h.rateOk }),
  rateLimitResponse: () => Response.json({ error: 'slow down' }, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (ctx: unknown, fn: (tx: unknown) => unknown) => { h.contexts.push(ctx); return fn({ tx: true }); },
}));
vi.mock('@/lib/channels/workspace', async (original) => ({
  ...(await original<typeof import('@/lib/channels/workspace')>()),
  getWorkspaceChannels: h.getWorkspaceChannels,
  setWorkspaceChannels: h.setWorkspaceChannels,
}));

import { ChannelSettingsError } from '@/lib/channels/workspace';
import { GET, PUT } from './route';

const state = { channels: {}, enabled: ['whatsapp'], chosen: false };
const put = (body: unknown) => PUT(new Request('http://localhost/api/account/channels', { method: 'PUT', body: JSON.stringify(body) }));
const get = () => GET(new Request('http://localhost/api/account/channels'));

beforeEach(() => {
  Object.assign(h, { role: 'admin', session: true, mutationOk: true, rateOk: true, contexts: [] });
  h.getWorkspaceChannels.mockReset().mockResolvedValue(state);
  h.setWorkspaceChannels.mockReset().mockResolvedValue({ ...state, chosen: true });
});

describe('/api/account/channels', () => {
  it('lets any member read the state, scoped to their own workspace', async () => {
    for (const role of ['viewer', 'agent', 'admin', 'owner']) {
      h.role = role;
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual(state);
    }
    expect(h.getWorkspaceChannels).toHaveBeenCalledWith({ tx: true }, ACCOUNT);
    expect(h.contexts[0]).toEqual({ accountId: ACCOUNT, userId: USER, role: 'viewer' });
  });

  it('needs a live session', async () => {
    h.session = false;
    expect((await get()).status).toBe(401);
    expect((await put({ channels: { instagram: true } })).status).toBe(401);
    expect(h.getWorkspaceChannels).not.toHaveBeenCalled();
    expect(h.setWorkspaceChannels).not.toHaveBeenCalled();
  });

  it('saves an admin change in the admin\'s own workspace and as the admin', async () => {
    const res = await put({ channels: { whatsapp: true, instagram: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...state, chosen: true });
    expect(h.setWorkspaceChannels).toHaveBeenCalledWith({ tx: true }, { accountId: ACCOUNT, userId: USER }, { whatsapp: true, instagram: true });
    expect(h.contexts).toEqual([{ accountId: ACCOUNT, userId: USER, role: 'admin' }]);
  });

  it('refuses agents and viewers', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await put({ channels: { instagram: true } })).status).toBe(403);
    }
    expect(h.setWorkspaceChannels).not.toHaveBeenCalled();
  });

  it('refuses a mutation without the Origin and CSRF proof', async () => {
    h.role = 'owner';
    h.mutationOk = false;
    expect((await put({ channels: { instagram: true } })).status).toBe(403);
    expect(h.setWorkspaceChannels).not.toHaveBeenCalled();
  });

  it('rate limits writes', async () => {
    h.rateOk = false;
    expect((await put({ channels: { instagram: true } })).status).toBe(429);
    expect(h.setWorkspaceChannels).not.toHaveBeenCalled();
  });

  it('refuses a malformed body, and never accepts an account id from it', async () => {
    for (const body of [null, {}, { channels: { whatsapp: 'on' } }, { channels: { whatsapp: true }, account_id: 'x' }]) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_request');
    }
    expect(h.setWorkspaceChannels).not.toHaveBeenCalled();
  });

  it('answers each channel rule with its status and code', async () => {
    const cases = [
      [new ChannelSettingsError('channel_connected', 'whatsapp'), 409, 'channel_connected', 'whatsapp'],
      [new ChannelSettingsError('last_channel'), 409, 'last_channel', null],
      [new ChannelSettingsError('plan_required', 'instagram'), 402, 'plan_required', 'instagram'],
      [new ChannelSettingsError('platform_off', 'instagram'), 503, 'platform_off', 'instagram'],
    ] as const;
    for (const [error, status, code, channel] of cases) {
      h.setWorkspaceChannels.mockRejectedValueOnce(error);
      const res = await put({ channels: { instagram: true } });
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).toMatchObject({ code, channel });
      expect(typeof body.error).toBe('string');
      expect(body.error).not.toContain('errors.');
    }
    h.setWorkspaceChannels.mockRejectedValueOnce(new ChannelSettingsError('channel_connected', 'whatsapp'));
    expect((await (await put({ channels: { whatsapp: false } })).json()).error).toContain('WhatsApp');
  });

  it('hides unexpected failures', async () => {
    h.setWorkspaceChannels.mockRejectedValueOnce(new Error('database said something with customer text'));
    const res = await put({ channels: { instagram: true } });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('customer');
  });
});
