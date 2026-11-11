/// <reference types="vite/client" />
// Phase 15 (design 1.2.4): the public v1 API against the real database. Tenant A's API key with
// tenant B's ids is a 404 everywhere, list routes never return B rows, a revoked key is a 401,
// scopes are enforced, and v1/messages cannot send from B's number. No provider call can escape:
// fetch is stubbed and must never be reached.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { disconnectDatabases } from '@/lib/db/prisma';
import { generateApiKey } from '@/lib/api-keys/keys';
import {
  apiKeyRequest, cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool,
  type TenantFixture, type TenantPair,
} from '@/test/tenancy/fixtures';

const routes = import.meta.glob('/src/app/api/v1/**/route.ts');
const databases = fixtureDatabaseUrls();
type Handler = (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(route: string, method: string, key: string, params: Record<string, string> = {}, body?: unknown,
  query = ''): Promise<Response> {
  const mod = (await routes[`/src/app/api/v1/${route}/route.ts`]()) as Record<string, Handler>;
  const path = `/api/v1/${route.replace(/\[([^\]]+)\]/g, (_m, k: string) => params[k])}${query}`;
  return mod[method](apiKeyRequest(key, method, path, body), { params: Promise.resolve(params) });
}

async function rows(accountId: string): Promise<Record<string, number>> {
  const pool = fixtureOwnerPool();
  const out: Record<string, number> = {};
  for (const table of ['contacts', 'conversations', 'messages', 'broadcasts', 'broadcast_recipients', 'webhook_endpoints', 'outbound_intents', 'jobs']) {
    const column = table === 'jobs' ? 'tenant_id' : 'account_id';
    out[table] = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1::uuid`, [accountId])).rows[0].n;
  }
  out.contact_hash = (await pool.query("SELECT md5(coalesce(string_agg(to_jsonb(c)::text, ',' ORDER BY id), '')) AS h FROM contacts c WHERE account_id=$1::uuid", [accountId])).rows[0].h;
  out.webhook_hash = (await pool.query("SELECT md5(coalesce(string_agg(to_jsonb(w)::text, ',' ORDER BY id), '')) AS h FROM webhook_endpoints w WHERE account_id=$1::uuid", [accountId])).rows[0].h;
  return out;
}

async function extraKey(t: TenantFixture, scopes: string[], revoked = false): Promise<string> {
  const key = generateApiKey();
  await fixtureOwnerPool().query(
    `INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes,revoked_at) VALUES($1,$2,'p15 extra',$3,$4,$5,${revoked ? 'NOW()' : 'NULL'})`,
    [t.accountId, t.users.owner.userId, key.prefix, key.hash, scopes]);
  return key.plaintext;
}

describe.skipIf(!databases)('[TEN-01][SEC-02] public v1 API tenancy', () => {
  let pair: TenantPair;
  let a: TenantFixture, b: TenantFixture;
  let bPhoneNumberId: string;
  const fetchSpy = vi.fn(async () => { throw new Error('network disabled in tenancy tests'); });

  beforeAll(async () => {
    pair = await createTenantPair({ label: 'v1' });
    ({ a, b } = pair);
    bPhoneNumberId = (await fixtureOwnerPool().query('SELECT phone_number_id FROM whatsapp_config WHERE id=$1', [b.whatsappConfigId])).rows[0].phone_number_id;
    vi.stubGlobal('fetch', fetchSpy);
  }, 60000);
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('covers all 13 v1 route files', () => {
    // Stage 5 (5G) added contacts/[id]/flows.
    expect(Object.keys(routes)).toHaveLength(13);
  });

  it("tenant A's key gets 404 for every tenant B id and B is unchanged", async () => {
    const before = await rows(b.accountId);
    const cases: [string, string, Record<string, string>, unknown?][] = [
      ['contacts/[id]', 'GET', { id: b.contactId }],
      ['contacts/[id]', 'PATCH', { id: b.contactId }, { name: 'p15 tamper' }],
      ['conversations/[id]', 'GET', { id: b.conversationId }],
      ['conversations/[id]/messages', 'GET', { id: b.conversationId }],
      // Stage 5 (5G): sending into, and starting a flow for, another workspace's ids.
      ['conversations/[id]/messages', 'POST', { id: b.conversationId }, { text: 'p15 foreign send' }],
      ['contacts/[id]/flows', 'POST', { id: b.contactId }, { flow_id: b.ids.flows }],
      ['broadcasts/[id]', 'GET', { id: b.broadcastId }],
      ['broadcasts/[id]/recipients', 'POST', { id: b.broadcastId }, { recipients: [{ phone: '910000000002' }] }],
      ['webhooks/[id]', 'GET', { id: b.webhookEndpointId }],
      ['webhooks/[id]', 'PATCH', { id: b.webhookEndpointId }, { is_active: false }],
      ['webhooks/[id]', 'DELETE', { id: b.webhookEndpointId }],
    ];
    const wrong: string[] = [];
    for (const [route, method, params, body] of cases) {
      const response = await call(route, method, a.apiKey, params, body);
      const text = await response.text();
      if (response.status !== 404) wrong.push(`${method} ${route} -> ${response.status}`);
      if (Object.values(b.ids).some((value) => text.includes(value))) wrong.push(`${method} ${route} leaked a B id`);
    }
    expect(wrong).toEqual([]);
    expect(await rows(b.accountId)).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120000);

  it("tenant A's key cannot start tenant B's flow for its own contact (404, nothing queued)", async () => {
    const beforeA = await rows(a.accountId), beforeB = await rows(b.accountId);
    const response = await call('contacts/[id]/flows', 'POST', a.apiKey, { id: a.contactId }, { flow_id: b.ids.flows });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(b.ids.flows);
    expect(await rows(a.accountId)).toEqual(beforeA);
    expect(await rows(b.accountId)).toEqual(beforeB);
  }, 60000);

  it("custom fields by key never resolve another workspace's field", async () => {
    const bField = (await fixtureOwnerPool().query('SELECT field_name FROM custom_fields WHERE id=$1', [b.ids.custom_fields])).rows[0].field_name;
    const before = await rows(b.accountId);
    const byName = await call('contacts/[id]', 'PATCH', a.apiKey, { id: a.contactId }, { custom_fields: { [bField]: 'p15 tamper' } });
    const byId = await call('contacts/[id]', 'PATCH', a.apiKey, { id: a.contactId }, { custom_fields: { [b.ids.custom_fields]: 'p15 tamper' } });
    expect([byName.status, byId.status]).toEqual([400, 400]);
    expect(await rows(b.accountId)).toEqual(before);
    const values = await fixtureOwnerPool().query('SELECT count(*)::int AS n FROM contact_custom_values WHERE value=$1', ['p15 tamper']);
    expect(values.rows[0].n).toBe(0);
  }, 60000);

  it('positive control: the same id routes answer 200 for tenant A ids', async () => {
    for (const [route, id] of [['contacts/[id]', a.contactId], ['conversations/[id]', a.conversationId], ['broadcasts/[id]', a.broadcastId],
      ['webhooks/[id]', a.webhookEndpointId]] as const)
      expect((await call(route, 'GET', a.apiKey, { id })).status, route).toBe(200);
  }, 60000);

  it('list routes and /me return only tenant A', async () => {
    const bIds = [...Object.values(b.ids), b.accountId];
    for (const route of ['contacts', 'conversations', 'webhooks', 'me']) {
      const response = await call(route, 'GET', a.apiKey);
      expect(response.status, route).toBe(200);
      const text = await response.text();
      expect(bIds.filter((value) => text.includes(value)), route).toEqual([]);
    }
    const me = await (await call('me', 'GET', a.apiKey)).json();
    expect(JSON.stringify(me)).toContain(a.accountId);
  }, 60000);

  it('a revoked key is 401 and an unknown key is 401', async () => {
    const revoked = await extraKey(a, ['contacts:read'], true);
    expect((await call('contacts', 'GET', revoked)).status).toBe(401);
    expect((await call('contacts', 'GET', generateApiKey().plaintext)).status).toBe(401);
  }, 30000);

  it('scopes are enforced: a read-only key cannot write, send or manage webhooks', async () => {
    const readOnly = await extraKey(a, ['contacts:read']);
    const before = await rows(a.accountId);
    expect((await call('contacts', 'GET', readOnly)).status).toBe(200);
    expect((await call('contacts', 'POST', readOnly, {}, { phone: '+910000000003', name: 'p15 scope' })).status).toBe(403);
    expect((await call('contacts/[id]', 'PATCH', readOnly, { id: a.contactId }, { name: 'p15 scope' })).status).toBe(403);
    expect((await call('messages', 'POST', readOnly, {}, { to: '+910000000003', text: 'hi' })).status).toBe(403);
    expect((await call('conversations/[id]/messages', 'POST', readOnly, { id: a.conversationId }, { text: 'hi' })).status).toBe(403);
    expect((await call('contacts/[id]/flows', 'POST', readOnly, { id: a.contactId }, { flow_id: a.ids.flows })).status).toBe(403);
    expect((await call('webhooks', 'GET', readOnly)).status).toBe(403);
    expect((await call('conversations', 'GET', readOnly)).status).toBe(403);
    expect((await call('broadcasts', 'POST', readOnly, {}, { template_name: 'x', recipients: [] })).status).toBe(403);
    expect(await rows(a.accountId)).toEqual(before);
  }, 60000);

  it("v1/messages and v1/broadcasts cannot send from tenant B's number", async () => {
    const beforeA = await rows(a.accountId), beforeB = await rows(b.accountId);
    const message = await call('messages', 'POST', a.apiKey, {}, { to: '+910000000004', text: 'p15', phone_number_id: bPhoneNumberId });
    expect(message.status).toBeGreaterThanOrEqual(400);
    expect(message.status).toBeLessThan(500);
    const broadcast = await call('broadcasts', 'POST', a.apiKey, {}, {
      name: 'p15 foreign number', template_name: 'p15_tpl_a', template_language: 'en_US', phone_number_id: bPhoneNumberId,
      recipients: [{ phone: '+910000000005' }], client_request_id: randomUUID(),
    });
    expect(broadcast.status).toBeGreaterThanOrEqual(400);
    expect(broadcast.status).toBeLessThan(500);
    expect(await rows(b.accountId)).toEqual(beforeB);
    // Refused before any contact, conversation, intent or job is created for A either.
    expect(await rows(a.accountId)).toEqual(beforeA);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 60000);
});
