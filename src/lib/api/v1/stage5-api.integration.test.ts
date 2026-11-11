// Stage 5 (5G) public API on a real PostgreSQL: sending into an Instagram
// conversation (a repeated Idempotency-Key sends once, a closed window is a
// 409 with nothing stored), starting a flow from outside (queued once per
// key, before the 202) and custom fields by key. Meta is never reached:
// fetch is stubbed per test and counted.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { generateApiKey } from '@/lib/api-keys/keys';
import { encrypt } from '@/lib/whatsapp/encryption';
import { POST as sendMessage } from '@/app/api/v1/conversations/[id]/messages/route';
import { POST as startFlow } from '@/app/api/v1/contacts/[id]/flows/route';
import { GET as getContact, PATCH as patchContact } from '@/app/api/v1/contacts/[id]/route';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const ENV = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123456', INSTAGRAM_APP_SECRET: 'test-only-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify', APP_URL: 'https://app.example.test',
};
const account = randomUUID();
const user = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let apiKey = '';
let contact = '';
let conversation = '';
let closedConversation = '';
let flow = '';
let otherFlow = '';
let cityField = '';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`https://app.example.test${path}`, {
  method, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const count = async (sql: string, values: unknown[]) => (await owner.query(sql, values)).rows[0].n as number;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Stage 5 public API (real database)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'API test','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Stage 5 API',$2)", [account, user]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, user]);
    const key = generateApiKey();
    apiKey = key.plaintext;
    await owner.query('INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,$3,$4,$5,$6)',
      [account, user, 's5 key', key.prefix, key.hash, ['messages:send', 'contacts:read', 'contacts:write']]);
    const ig = (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`,
      [account, `83${seed}`, encrypt('test-only-ig-token'), ['instagram_business_basic', 'instagram_business_manage_messages'], user],
    )).rows[0].id as string;
    const igConversation = async (n: string, lastCustomerAgo: string) => {
      const c = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
        [account, user, `+1419${n}${seed.slice(-6)}`, `Customer ${n}`])).rows[0].id as string;
      await owner.query('INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4)',
        [account, c, ig, `97${n}${seed}`]);
      const conv = (await owner.query(
        `INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id`,
        [account, user, c, ig])).rows[0].id as string;
      await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status,created_at)
        VALUES($1,$2,'customer','text','hi',$3,'delivered',now() - $4::interval)`, [account, conv, `mid.in.${n}.${seed}`, lastCustomerAgo]);
      return { c, conv };
    };
    ({ c: contact, conv: conversation } = await igConversation('1', '5 minutes'));
    ({ conv: closedConversation } = await igConversation('2', '25 hours'));
    flow = (await owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type,status,channel_scope) VALUES($1,$2,'S5 start','keyword','active','instagram') RETURNING id",
      [account, user])).rows[0].id;
    otherFlow = (await owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type,status,channel_scope) VALUES($1,$2,'S5 other','keyword','active','instagram') RETURNING id",
      [account, user])).rows[0].id;
    cityField = (await owner.query("INSERT INTO custom_fields(account_id,user_id,field_name) VALUES($1,$2,'City') RETURNING id", [account, user])).rows[0].id;
    await owner.query("INSERT INTO custom_fields(account_id,user_id,field_name) VALUES($1,$2,'Plan'),($1,$2,'plan')", [account, user]);
  });
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('a repeated Idempotency-Key sends once and answers the same message; reusing it for other text is refused', async () => {
    const mid = `mid.api.${randomUUID()}`;
    const fetcher = vi.fn(async () => json(200, { recipient_id: `971${seed}`, message_id: mid }));
    vi.stubGlobal('fetch', fetcher);
    const idem = { 'idempotency-key': `order-${randomUUID()}` };
    const first = await sendMessage(request('POST', `/api/v1/conversations/${conversation}/messages`, { text: 'Your order shipped' }, idem), params(conversation));
    const again = await sendMessage(request('POST', `/api/v1/conversations/${conversation}/messages`, { text: 'Your order shipped' }, idem), params(conversation));
    expect([first.status, again.status]).toEqual([201, 201]);
    const a = (await first.json()).data, b = (await again.json()).data;
    expect(b).toEqual(a);
    expect(a).toMatchObject({ provider_message_id: mid, channel: 'instagram', conversation_id: conversation });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await count("SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND message_id=$2 AND status='sent'", [conversation, mid])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2 AND status='accepted'",
      [account, `${account}:api_msg:%`])).toBeGreaterThanOrEqual(1);
    const other = await sendMessage(request('POST', `/api/v1/conversations/${conversation}/messages`, { text: 'Something else' }, idem), params(conversation));
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe('idempotency_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('outside the 24-hour window the send is 409 window_closed and nothing is stored or sent', async () => {
    const fetcher = vi.fn(async () => json(200, { message_id: 'never' }));
    vi.stubGlobal('fetch', fetcher);
    const before = await count('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [closedConversation]);
    const intents = await count('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [account]);
    const response = await sendMessage(request('POST', `/api/v1/conversations/${closedConversation}/messages`, { text: 'Promo' },
      { 'idempotency-key': randomUUID() }), params(closedConversation));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('window_closed');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await count('SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1', [closedConversation])).toBe(before);
    expect(await count('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [account])).toBe(intents);
  });

  it('starting a flow is queued once per Idempotency-Key before the 202', async () => {
    const idem = { 'idempotency-key': `lead-${randomUUID()}` };
    const first = await startFlow(request('POST', `/api/v1/contacts/${contact}/flows`, { flow_id: flow }, idem), params(contact));
    const again = await startFlow(request('POST', `/api/v1/contacts/${contact}/flows`, { flow_id: flow }, idem), params(contact));
    expect([first.status, again.status]).toEqual([202, 202]);
    expect((await first.json()).data).toMatchObject({ status: 'queued', conversation_id: conversation, channel: 'instagram' });
    expect(await count("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='api.start_flow' AND payload->>'flowId'=$2", [account, flow])).toBe(1);
    const reused = await startFlow(request('POST', `/api/v1/contacts/${contact}/flows`, { flow_id: otherFlow }, idem), params(contact));
    expect(reused.status).toBe(409);
    expect(await count("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='api.start_flow' AND payload->>'flowId'=$2", [account, otherFlow])).toBe(0);
    // A paused flow is refused and nothing is queued.
    await owner.query("UPDATE flows SET status='paused' WHERE id=$1", [otherFlow]);
    const paused = await startFlow(request('POST', `/api/v1/contacts/${contact}/flows`, { flow_id: otherFlow }), params(contact));
    expect(paused.status).toBe(409);
    expect(await count("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND type='api.start_flow' AND payload->>'flowId'=$2", [account, otherFlow])).toBe(0);
  });

  it('reads and writes custom fields by name; an ambiguous or unknown name writes nothing', async () => {
    const set = await patchContact(request('PATCH', `/api/v1/contacts/${contact}`, { custom_fields: { city: 'Pune' } }), params(contact));
    expect(set.status).toBe(200);
    expect((await set.json()).data.custom_fields).toMatchObject({ City: 'Pune' });
    const read = await getContact(request('GET', `/api/v1/contacts/${contact}`), params(contact));
    expect((await read.json()).data.custom_fields.City).toBe('Pune');
    for (const body of [{ name: 'Renamed', custom_fields: { Plan: 'Pro' } }, { custom_fields: { Unknown: 'x' } }]) {
      const refused = await patchContact(request('PATCH', `/api/v1/contacts/${contact}`, body), params(contact));
      expect(refused.status).toBe(400);
    }
    // The refused request changed neither the name nor any value.
    expect((await owner.query('SELECT name FROM contacts WHERE id=$1', [contact])).rows[0].name).toBe('Customer 1');
    const cleared = await patchContact(request('PATCH', `/api/v1/contacts/${contact}`, { custom_fields: { [cityField]: null } }), params(contact));
    expect((await cleared.json()).data.custom_fields.City).toBeNull();
  });
});
