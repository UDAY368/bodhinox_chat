// [TEN-01][SEC-03] Stage 5 (5D) routes with real sessions, membership, CSRF and RLS:
//   POST /api/inbox/pause                  agent role; another workspace's conversation is 404 and untouched.
//   GET/PUT /api/instagram/consent-settings members read their own; admins save; another
//                                          workspace's flow id is invalid_flow and nothing is saved.
// Both mutations are refused by the proxy without the CSRF header.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest,
  type TenantPair,
} from './fixtures';
import { callRoute } from './request-scope';

vi.mock('next/headers', async () => (await import('./request-scope')).nextHeadersMock);

const databases = fixtureDatabaseUrls();

describe.skipIf(!databases)('[TEN-01][SEC-03] Stage 5 consent and pause routes keep tenants apart', () => {
  let pair: TenantPair;
  let flowA: string, flowB: string;
  const pauseRow = async (conversationId: string) => (await fixtureOwnerPool().query(
    'SELECT bot_paused, bot_paused_until, bot_paused_by::text AS bot_paused_by FROM conversations WHERE id=$1', [conversationId])).rows[0];
  const flow = async (accountId: string, userId: string) => (await fixtureOwnerPool().query(
    "INSERT INTO flows(account_id,user_id,name,trigger_type,status,channel_scope) VALUES($1,$2,$3,'manual','active','instagram') RETURNING id",
    [accountId, userId, `Consent ${randomUUID().slice(0, 8)}`])).rows[0].id as string;

  beforeAll(async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', 'true');
    pair = await createTenantPair({ label: 's5d' });
    flowA = await flow(pair.a.accountId, pair.a.users.owner.userId);
    flowB = await flow(pair.b.accountId, pair.b.users.owner.userId);
  }, 60000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('lets an agent pause and resume their own conversation, recording who paused', async () => {
    const { POST } = await import('@/app/api/inbox/pause/route');
    const agent = pair.a.users.agent;
    const res = await callRoute(POST, await signedRequest(agent, 'POST', '/api/inbox/pause',
      { conversation_id: pair.a.conversationId, action: 'pause', minutes: 60 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ paused: true, paused_by: agent.userId });
    expect(await pauseRow(pair.a.conversationId)).toMatchObject({ bot_paused: true, bot_paused_by: agent.userId });
    const resumed = await callRoute(POST, await signedRequest(agent, 'POST', '/api/inbox/pause',
      { conversation_id: pair.a.conversationId, action: 'resume' }));
    expect(await resumed.json()).toEqual({ paused: false, until: null, paused_by: null });
    expect(await pauseRow(pair.a.conversationId)).toEqual({ bot_paused: false, bot_paused_until: null, bot_paused_by: null });
  });

  it("answers 404 for another workspace's conversation and leaves it untouched", async () => {
    const { POST } = await import('@/app/api/inbox/pause/route');
    const before = await pauseRow(pair.b.conversationId);
    for (const scope of ['conversation', 'contact']) {
      const res = await callRoute(POST, await signedRequest(pair.a.users.owner, 'POST', '/api/inbox/pause',
        { conversation_id: pair.b.conversationId, action: 'pause', minutes: 30, scope }));
      expect(res.status).toBe(404);
    }
    expect(await pauseRow(pair.b.conversationId)).toEqual(before);
  });

  it('refuses a viewer', async () => {
    const { POST } = await import('@/app/api/inbox/pause/route');
    const res = await callRoute(POST, await signedRequest(pair.a.users.viewer, 'POST', '/api/inbox/pause',
      { conversation_id: pair.a.conversationId, action: 'pause', minutes: 30 }));
    expect(res.status).toBe(403);
  });

  it('saves consent settings for admins only and refuses another workspace’s flow', async () => {
    const { GET, PUT } = await import('@/app/api/instagram/consent-settings/route');
    const body = { opt_out_keywords: ['Basta'], opt_in_keywords: [], opt_out_reply: null, opt_in_reply: null, opt_out_flow_id: flowA, opt_in_flow_id: null };
    const saved = await callRoute(PUT, await signedRequest(pair.a.users.admin, 'PUT', '/api/instagram/consent-settings', body));
    expect(saved.status).toBe(200);
    expect((await saved.json()).settings).toMatchObject({ opt_out_keywords: ['basta'], opt_out_flow_id: flowA });

    const agent = await callRoute(PUT, await signedRequest(pair.a.users.agent, 'PUT', '/api/instagram/consent-settings', body));
    expect(agent.status).toBe(403);
    const foreign = await callRoute(PUT, await signedRequest(pair.a.users.admin, 'PUT', '/api/instagram/consent-settings',
      { ...body, opt_out_flow_id: flowB }));
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ code: 'invalid_flow' });

    const readA = await callRoute(GET, await signedRequest(pair.a.users.viewer, 'GET', '/api/instagram/consent-settings'));
    expect((await readA.json()).settings).toMatchObject({ opt_out_keywords: ['basta'], opt_out_flow_id: flowA });
    const readB = await callRoute(GET, await signedRequest(pair.b.users.owner, 'GET', '/api/instagram/consent-settings'));
    expect((await readB.json()).settings).toMatchObject({ opt_out_keywords: [], opt_out_flow_id: null });
  });

  it('refuses both mutations at the proxy without the CSRF header', async () => {
    const { proxy } = await import('@/proxy');
    const requests = [
      await signedRequest(pair.a.users.owner, 'POST', '/api/inbox/pause', { conversation_id: pair.a.conversationId, action: 'resume' }, { omitCsrf: true }),
      await signedRequest(pair.a.users.owner, 'PUT', '/api/instagram/consent-settings', {}, { omitCsrf: true }),
    ];
    for (const request of requests) expect((await proxy(new NextRequest(request))).status).toBe(403);
  });
});
