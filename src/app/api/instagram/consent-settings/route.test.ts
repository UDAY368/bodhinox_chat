// GET/PUT /api/instagram/consent-settings (Stage 5, 5D): every member reads as
// themselves, only admins and owners save, bodies are validated, the route is
// off with INSTAGRAM_ENABLED, and the proxy's CSRF check sits in front of PUT.
// The real RLS and the cross-tenant flow refusal:
// src/lib/contacts/channel-consent.integration.test.ts.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'admin', load: vi.fn(), save: vi.fn(), mutation: vi.fn(), resolve: vi.fn() }));

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
vi.mock('@/lib/contacts/channel-consent', async (original) => ({
  ...(await original<typeof import('@/lib/contacts/channel-consent')>()),
  loadConsentSettings: h.load,
  saveConsentSettings: h.save,
}));

import { GET, PUT } from './route';
import { proxy } from '@/proxy';
import { ForbiddenError } from '@/lib/auth/errors';
import { ConsentSettingsError, DEFAULT_CONSENT_SETTINGS } from '@/lib/contacts/channel-consent';

const put = (body: unknown) => PUT(new Request('http://x/api/instagram/consent-settings', { method: 'PUT', body: JSON.stringify(body) }));
const tenant = (role: string) => ({ accountId: ACCOUNT, userId: USER, role });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('INSTAGRAM_ENABLED', 'true');
  vi.stubEnv('INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED', '');
  h.role = 'admin';
  h.load.mockResolvedValue({ ...DEFAULT_CONSENT_SETTINGS });
  h.save.mockImplementation(async (_tenant: unknown, value: unknown) => value);
  h.mutation.mockResolvedValue(undefined);
  h.resolve.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/instagram/consent-settings', () => {
  it.each(['viewer', 'agent', 'admin'])('lets a %s read as themselves, with the built-in words and the schedule flag', async (role) => {
    h.role = role;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const json = await res.json();
    expect(json.settings).toEqual(DEFAULT_CONSENT_SETTINGS);
    expect(json.built_in.opt_out).toContain('STOP');
    expect(json.built_in.opt_in).toContain('START');
    expect(json.features).toEqual({ scheduled_automations: false });
    expect(h.load).toHaveBeenCalledWith(tenant(role));
  });

  it('reports the Instagram schedule flag when it is on', async () => {
    vi.stubEnv('INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED', 'true');
    expect((await (await GET()).json()).features).toEqual({ scheduled_automations: true });
  });

  it('is not found while Instagram is off', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    expect((await GET()).status).toBe(404);
    expect((await put({})).status).toBe(404);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe('PUT /api/instagram/consent-settings', () => {
  it.each(['agent', 'viewer'])('refuses %s', async (role) => {
    h.role = role;
    expect((await put({ opt_out_keywords: ['basta'] })).status).toBe(403);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('saves the parsed settings as the admin', async () => {
    const res = await put({ opt_out_keywords: [' Basta '], opt_in_keywords: ['volver'], opt_out_reply: 'Done.', opt_out_flow_id: FLOW });
    expect(res.status).toBe(200);
    expect(h.save).toHaveBeenCalledWith(tenant('admin'), {
      ...DEFAULT_CONSENT_SETTINGS, opt_out_keywords: ['basta'], opt_in_keywords: ['volver'], opt_out_reply: 'Done.', opt_out_flow_id: FLOW,
    });
  });

  it.each([
    [{ opt_out_keywords: ['x'.repeat(51)] }, 'invalid_keywords'],
    [{ opt_in_reply: 'x'.repeat(1001) }, 'invalid_reply'],
    [{ opt_in_flow_id: 'nope' }, 'invalid_flow'],
  ])('refuses %j with %s and saves nothing', async (body, code) => {
    const res = await put(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code });
    expect(h.save).not.toHaveBeenCalled();
  });

  it('answers invalid_flow when the flow is not this workspace’s', async () => {
    h.save.mockRejectedValue(new ConsentSettingsError('invalid_flow'));
    const res = await put({ opt_in_flow_id: FLOW });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_flow' });
  });

  it('sits behind the proxy’s CSRF check for cookie sessions', async () => {
    h.resolve.mockResolvedValue({ userId: USER });
    h.mutation.mockRejectedValue(new ForbiddenError('Invalid CSRF token'));
    const response = await proxy(new NextRequest('https://crm.test/api/instagram/consent-settings', {
      method: 'PUT', headers: { cookie: 'bnx_access=jwt' }, body: '{}',
    }));
    expect(response.status).toBe(403);
    expect(h.mutation).toHaveBeenCalled();
  });
});
