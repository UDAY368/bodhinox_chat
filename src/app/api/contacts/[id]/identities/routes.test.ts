// Phase 11 T5: the contact identity routes. While Instagram is off, link and
// unlink answer the fixed 503 before any session or database work and the list
// answers { enabled:false } without a query; then session, CSRF/origin, admin
// role, rate limit and strict bodies, with fixed codes for library refusals.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';
const IDENTITY = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  on: true, role: 'admin', signedIn: true, mutationOk: true, sessions: 0, mask: false,
  calls: [] as string[], fail: null as unknown,
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
vi.mock('@/lib/instagram/config', async (original) => ({
  ...(await original<typeof import('@/lib/instagram/config')>()),
  instagramConfig: () => (h.on ? { appId: '1', appSecret: 's', webhookSecrets: 's', webhookVerifyToken: 'v', redirectUri: 'x', humanAgentEnabled: false } : null),
}));
vi.mock('@/lib/inbox/masking-apply', async (original) => ({
  ...(await original<typeof import('@/lib/inbox/masking-apply')>()),
  resolvePhoneMask: async () => h.mask,
}));
vi.mock('@/lib/contacts/identity-link', async (original) => ({
  ...(await original<typeof import('@/lib/contacts/identity-link')>()),
  listContactIdentities: async (actor: { accountId: string }, contactId: string) => {
    h.calls.push(`list:${actor.accountId}:${contactId}`);
    return [{ id: IDENTITY, channel: 'instagram', instagramAccountId: 'ig', username: 'shop_fan', displayName: 'Fan',
      createdAt: new Date('2026-11-01T00:00:00Z'), canUnlink: true }];
  },
  linkIdentity: async (actor: { accountId: string; userId: string }, input: Record<string, unknown>) => {
    if (h.fail) throw h.fail;
    h.calls.push(`link:${actor.accountId}:${actor.userId}:${JSON.stringify(input)}`);
    return { linkId: 'link-1' };
  },
  unlinkIdentity: async (_actor: unknown, input: Record<string, unknown>) => {
    if (h.fail) throw h.fail;
    h.calls.push(`unlink:${JSON.stringify(input)}`);
    return { linkId: 'link-2', contactId: TARGET };
  },
}));

import { IdentityLinkError } from '@/lib/contacts/identity-link';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as list } from './route';
import { POST as link } from './link/route';
import { POST as unlink } from './unlink/route';

const params = { params: Promise.resolve({ id: CONTACT }) };
const post = (path: string, body: unknown) => new Request(`http://localhost/api/contacts/${CONTACT}/identities/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const linkBody = { identity_id: IDENTITY, target_contact_id: TARGET, note: 'Same person, confirmed by phone' };

beforeEach(() => {
  Object.assign(h, { on: true, role: 'admin', signedIn: true, mutationOk: true, sessions: 0, mask: false, calls: [], fail: null });
  __resetRateLimitForTests();
});

describe('while Instagram is off', () => {
  it('link and unlink answer 503 before any session or library call', async () => {
    h.on = false;
    for (const response of [await link(post('link', linkBody), params), await unlink(post('unlink', { identity_id: IDENTITY }), params)]) {
      expect(response.status).toBe(503);
      expect((await response.json()).error).toBe('instagram_not_enabled');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(h.sessions).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it('the list says disabled and makes no query', async () => {
    h.on = false;
    const response = await list(new Request('http://localhost'), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, identities: [] });
    expect(h.calls).toEqual([]);
  });
});

describe('GET /api/contacts/{id}/identities', () => {
  it('lists display fields only, scoped to the session workspace', async () => {
    h.role = 'agent';
    const response = await list(new Request('http://localhost'), params);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ enabled: true, can_link: false });
    expect(body.identities[0]).toEqual({ id: IDENTITY, channel: 'instagram', instagram_account_id: 'ig', username: 'shop_fan',
      display_name: 'Fan', created_at: '2026-11-01T00:00:00.000Z', can_unlink: true });
    expect(JSON.stringify(body)).not.toMatch(/external_id|token/);
    expect(h.calls).toEqual([`list:${ACCOUNT}:${CONTACT}`]);
  });

  it('masks the Instagram handle for a member whose phone numbers are masked', async () => {
    h.role = 'agent';
    h.mask = true;
    const body = await (await list(new Request('http://localhost'), params)).json();
    expect(body.identities[0].username).not.toBe('shop_fan');
    expect(body.identities[0].username).toMatch(/^s.+n$/);
    expect(JSON.stringify(body)).not.toContain('shop_fan');
  });

  it('needs a session', async () => {
    h.signedIn = false;
    expect((await list(new Request('http://localhost'), params)).status).toBe(401);
  });
});

describe('POST link / unlink', () => {
  it('an admin links with the session actor and the path contact', async () => {
    const response = await link(post('link', linkBody), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ link_id: 'link-1' });
    expect(h.calls).toEqual([`link:${ACCOUNT}:${USER}:${JSON.stringify({
      contactId: CONTACT, identityId: IDENTITY, targetContactId: TARGET, note: linkBody.note })}`]);
  });

  it('an admin unlinks', async () => {
    const response = await unlink(post('unlink', { identity_id: IDENTITY }), params);
    expect(await response.json()).toEqual({ link_id: 'link-2', contact_id: TARGET });
    expect(h.calls).toEqual([`unlink:${JSON.stringify({ contactId: CONTACT, identityId: IDENTITY, note: null })}`]);
  });

  it('refuses a signed-out caller, a failed CSRF/origin check and an agent before the library', async () => {
    h.signedIn = false;
    expect((await link(post('link', linkBody), params)).status).toBe(401);
    h.signedIn = true; h.mutationOk = false;
    expect((await link(post('link', linkBody), params)).status).toBe(403);
    h.mutationOk = true; h.role = 'agent';
    const response = await unlink(post('unlink', { identity_id: IDENTITY }), params);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('forbidden');
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown key', { ...linkBody, contact_id: CONTACT }],
    ['a non-uuid target', { ...linkBody, target_contact_id: 'abc' }],
    ['a missing identity', { target_contact_id: TARGET }],
    ['an oversized note', { ...linkBody, note: 'x'.repeat(801) }],
  ])('rejects %s with 400 invalid_request', async (_label, body) => {
    const response = await link(post('link', body), params);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('invalid_request');
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['identity_conflict', 409], ['identity_busy', 409], ['not_found', 404], ['invalid_request', 400],
  ] as const)('answers the library refusal %s with %i and a translated message', async (code, status) => {
    h.fail = new IdentityLinkError(code);
    const response = await link(post('link', linkBody), params);
    const body = await response.json();
    expect(response.status).toBe(status);
    expect(body.error).toBe(code);
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('rate-limits each member per action', async () => {
    let last: Response | null = null;
    for (let i = 0; i < 31; i++) last = await link(post('link', linkBody), params);
    expect(last?.status).toBe(429);
    expect((await unlink(post('unlink', { identity_id: IDENTITY }), params)).status).toBe(200);
  });
});
