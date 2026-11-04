// Phase 11 review fix (I6/I10) on a real PostgreSQL: Meta's is_echo webhook of
// an automated Instagram send can be stored before the sender writes its own
// row. The flow send must still succeed (intent 'accepted', not 'unknown'), and
// its bot row replaces the echo row under the same mid. Any other row with that
// mid is never overwritten. Meta is never called: fetch is stubbed per test.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { storeInstagramSentMessage } from '@/lib/channels/sender';
import { encrypt } from '@/lib/whatsapp/encryption';
import { flowSend } from './channel-send';

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
const scope = { accountId: account, role: 'owner' as const };
let owner: pg.Client;
let contact = '';
let conversation = '';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const storeEcho = (mid: string, text: string) => owner.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status,interactive_payload)
   VALUES($1,$2,'agent','text',$3,$4,'sent','{"ig":{"external_echo":true}}'::jsonb)`, [account, conversation, text, mid]);
const rowsFor = async (mid: string) => (await owner.query(
  'SELECT sender_type, sender_id, content_text, interactive_payload FROM messages WHERE conversation_id=$1 AND message_id=$2',
  [conversation, mid])).rows;
const intentOf = async (key: string) => (await owner.query(
  'SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${account}:${key}`])).rows[0]?.status ?? null;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram flow send and an echo stored first', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Echo test','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Echo race',$2)", [account, user]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, user]);
    const ig = (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`,
      [account, `83${seed}`, encrypt('test-only-ig-token'), ['instagram_business_basic', 'instagram_business_manage_messages'], user],
    )).rows[0].id as string;
    contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$4,$3) RETURNING id',
      [account, user, 'Echo customer', `+1419${seed.slice(-7)}`])).rows[0].id;
    await owner.query('INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id) VALUES($1,$2,$3,$4)',
      [account, contact, ig, `97${seed}`]);
    conversation = (await owner.query(
      `INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id`,
      [account, user, contact, ig])).rows[0].id;
    // An open messaging window.
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status)
      VALUES($1,$2,'customer','text','hi',$3,'sent')`, [account, conversation, `mid.in.${seed}`]);
  });
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM outbound_intents WHERE account_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const send = (key: string, text: string) => withJobScope(scope, () => flowSend({ account_id: account, conversation_id: conversation }, key,
    { kind: 'text', args: { accountId: account, userId: user, conversationId: conversation, contactId: contact, text } }));

  it('keeps the bot row over an echo stored before it, and the intent is accepted', async () => {
    const mid = `mid.flow.${randomUUID()}`;
    // The echo lands while the Graph call is still returning.
    vi.stubGlobal('fetch', vi.fn(async () => { await storeEcho(mid, 'Your order shipped'); return json(200, { recipient_id: `97${seed}`, message_id: mid }); }));
    const key = `flow_test:${randomUUID()}`;
    await expect(send(key, 'Your order shipped')).resolves.toEqual({ whatsapp_message_id: mid, provider_message_id: mid });
    expect(await intentOf(key)).toBe('accepted');
    const rows = await rowsFor(mid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sender_type: 'bot', sender_id: null, content_text: 'Your order shipped' });
    expect(rows[0].interactive_payload).toBeNull();
  });

  it('still stores the bot row when no echo arrived', async () => {
    const mid = `mid.flow.${randomUUID()}`;
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { recipient_id: `97${seed}`, message_id: mid })));
    const key = `flow_test:${randomUUID()}`;
    await send(key, 'Hello');
    expect(await intentOf(key)).toBe('accepted');
    expect(await rowsFor(mid)).toEqual([expect.objectContaining({ sender_type: 'bot', content_text: 'Hello' })]);
  });

  it('never overwrites a row with the same mid that is not an external echo', async () => {
    const mid = `mid.flow.${randomUUID()}`;
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,content_text,message_id,status)
      VALUES($1,$2,'agent',$3,'text','member text',$4,'sent')`, [account, conversation, user, mid]);
    const stored = await withTenant(scope, (tx) => storeInstagramSentMessage(tx, {
      accountId: account, conversationId: conversation, senderType: 'bot', senderId: null, contentType: 'text', contentText: 'bot text', messageId: mid,
    }), getWorkerPrisma());
    expect(stored).toBeNull();
    expect(await rowsFor(mid)).toEqual([expect.objectContaining({ sender_type: 'agent', sender_id: user, content_text: 'member text' })]);
  });
});
