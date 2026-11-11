// Stage 4C on PostgreSQL: Conversions API events from Instagram flows. Rows, RLS, intents and jobs are real;
// Meta is the only fake (global fetch). Proves: an event is attributable only to a click-to-Direct ad message of
// THIS conversation within 7 days; it is queued once with its job (a replay adds nothing); nothing queues while
// INSTAGRAM_CAPI_ENABLED is off or for another workspace's conversation; the send carries the account and the
// person's Instagram ids, is made once through an outbound intent, and an ambiguous outcome is never re-sent.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { handleCapiEventJob, queueConversionEvent, queueConversionEventTx } from './capi';

vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
const dataset = `83${seed}`, igUserA = `96${seed}`, igsid = `97${seed}`;
const savedEnv = { ...process.env };
const ENV = {
  META_ADS_ENABLED: 'true', META_APP_ID: '1234567890', META_APP_SECRET_PRIMARY: 'test-only-secret', META_ADS_LOGIN_CONFIG_ID: '987654321',
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123456', INSTAGRAM_APP_SECRET: 'test-only-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify', APP_URL: 'https://app.example.test', INSTAGRAM_CAPI_ENABLED: 'true',
};
let owner: pg.Client;
let contactA = '', adConv = '', plainConv = '', oldAdConv = '', convB = '';
const fetchMock = vi.fn<typeof fetch>();

const events = async (where = '') => (await owner.query(`SELECT * FROM capi_events WHERE account_id=$1 ${where} ORDER BY created_at`, [accountA])).rows;
const jobsFor = async (eventId: string) => (await owner.query("SELECT payload FROM jobs WHERE tenant_id=$1 AND type='meta.capi_event' AND dedupe_key=$2", [accountA, `capi:${accountA}:${eventId}`])).rows;
const queue = (conversationId: string | null, sourceId = `${randomUUID()}:n1`) => queueConversionEvent(accountA, {
  eventName: 'QualifiedLead', source: 'flow', sourceId, contactId: contactA, channel: 'instagram', conversationId });

async function message(account: string, conversation: string, daysAgo: number, source: string | null) {
  await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,interactive_payload,created_at)
    VALUES($1,$2,'customer','text','hi','received',$3,now() - make_interval(days => $4))`,
  [account, conversation, source ? { ig: { referral: { source, ad_id: '120000000009' } } } : null, daysAgo]);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Conversions API from Instagram on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    Object.assign(process.env, ENV);
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'CAPI Instagram test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'CAPI IG A',$2),($3,'CAPI IG B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'owner')", [accountA, adminA, accountB, ownerB]);
    const igA = (await owner.query("INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id) VALUES($1,$2,'capi_a','enc-test-token',$3) RETURNING id",
      [accountA, igUserA, adminA])).rows[0].id as string;
    const igB = (await owner.query("INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id) VALUES($1,$2,'capi_b','enc-test-token',$3) RETURNING id",
      [accountB, `98${seed}`, ownerB])).rows[0].id as string;
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'IG clicked',$3) RETURNING id", [accountA, adminA, `+9184${seed}`])).rows[0].id;
    const contactB = (await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Other workspace',$3) RETURNING id", [accountB, ownerB, `+9185${seed}`])).rows[0].id;
    await owner.query("INSERT INTO contact_channel_identities(account_id,contact_id,channel,instagram_account_id,external_id) VALUES($1,$2,'instagram',$3,$4)", [accountA, contactA, igA, igsid]);
    const conv = async (account: string, user: string, contact: string, ig: string) => (await owner.query(
      "INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id", [account, user, contact, ig])).rows[0].id as string;
    adConv = await conv(accountA, adminA, contactA, igA);
    // One Instagram conversation per contact and account is the norm; these extra rows model the other cases.
    const igA2 = (await owner.query("INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id) VALUES($1,$2,'capi_a2','enc-test-token',$3) RETURNING id",
      [accountA, `99${seed}`, adminA])).rows[0].id as string;
    const igA3 = (await owner.query("INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id) VALUES($1,$2,'capi_a3','enc-test-token',$3) RETURNING id",
      [accountA, `90${seed}`, adminA])).rows[0].id as string;
    plainConv = await conv(accountA, adminA, contactA, igA2);
    oldAdConv = await conv(accountA, adminA, contactA, igA3);
    convB = await conv(accountB, ownerB, contactB, igB);
    await message(accountA, adConv, 1, 'ADS');
    await message(accountA, plainConv, 1, 'SHORTLINK');
    await message(accountA, oldAdConv, 10, 'ADS');
    await message(accountB, convB, 1, 'ADS');
    await owner.query(`INSERT INTO meta_ad_connections(account_id,connected_by,status,user_token_enc,scopes,capi_enabled,capi_dataset_id)
      VALUES($1,$2,'active',$3,ARRAY['ads_read','whatsapp_business_manage_events'],true,$4)`, [accountA, adminA, encrypt('test-only-user-token'), dataset]);
    vi.stubGlobal('fetch', fetchMock);
  });
  beforeEach(() => {
    Object.assign(process.env, ENV);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    process.env = savedEnv;
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('queues an event with its job for the contact\'s click-to-Direct ad conversation, once', async () => {
    const sourceId = `${randomUUID()}:once`;
    expect(await queue(adConv, sourceId)).toBe(true);
    const [row] = await events(`AND source_id='${sourceId}'`);
    expect(row).toMatchObject({ channel: 'instagram', status: 'queued', source: 'flow', event_name: 'QualifiedLead', ad_referral_id: null, contact_id: contactA });
    expect(row.message_id).toBeTruthy();
    expect(await jobsFor(row.event_id)).toEqual([{ payload: { capiEventId: row.id } }]);
    // A replay (a loop revisit or a re-run after a crash) adds neither a row nor a second job.
    expect(await queue(adConv, sourceId)).toBe(false);
    expect(await events(`AND source_id='${sourceId}'`)).toHaveLength(1);
    expect(await jobsFor(row.event_id)).toHaveLength(1);
  });

  it('queues nothing without an ad message in that conversation, past 7 days, or for another workspace\'s conversation', async () => {
    expect(await queue(plainConv)).toBe(false);
    expect(await queue(oldAdConv)).toBe(false);
    expect(await queue(convB)).toBe(false);
    expect(await queue(null)).toBe(false);
  });

  it('queues nothing while INSTAGRAM_CAPI_ENABLED is off or for a source other than a flow', async () => {
    process.env.INSTAGRAM_CAPI_ENABLED = 'false';
    expect(await queue(adConv)).toBe(false);
    process.env.INSTAGRAM_CAPI_ENABLED = 'true';
    // A form, order or payment link is a WhatsApp business object.
    const asOrder = await withTenant({ accountId: accountA, role: 'owner' }, (tx) => queueConversionEventTx(tx, {
      accountId: accountA, eventName: 'LeadSubmitted', source: 'form', sourceId: `${randomUUID()}`, contactId: contactA, channel: 'instagram', conversationId: adConv }), getWorkerPrisma());
    expect(asOrder).toBe(false);
  });

  it('sends the account and person ids once through an outbound intent, and marks it sent', async () => {
    const sourceId = `${randomUUID()}:send`;
    await queue(adConv, sourceId);
    const [row] = await events(`AND source_id='${sourceId}'`);
    await handleCapiEventJob(accountA, { capiEventId: row.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/${dataset}/events`);
    expect(String(url)).not.toContain('test-only-user-token');
    expect(JSON.parse(String(init?.body)).data[0]).toMatchObject({ event_name: 'QualifiedLead', event_id: row.event_id, action_source: 'business_messaging',
      messaging_channel: 'instagram', user_data: { ig_account_id: igUserA, ig_sid: igsid } });
    expect((await events(`AND id='${row.id}'`))[0]).toMatchObject({ status: 'sent' });
    await handleCapiEventJob(accountA, { capiEventId: row.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never re-sends an unknown outcome and skips when the person\'s identity is gone', async () => {
    const ambiguous = `${randomUUID()}:amb`, orphan = `${randomUUID()}:orphan`;
    await queue(adConv, ambiguous);
    await queue(adConv, orphan);
    const [a] = await events(`AND source_id='${ambiguous}'`);
    const [b] = await events(`AND source_id='${orphan}'`);
    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await handleCapiEventJob(accountA, { capiEventId: a.id });
    expect((await events(`AND id='${a.id}'`))[0]).toMatchObject({ status: 'unknown' });
    await owner.query("UPDATE capi_events SET status='queued' WHERE id=$1", [a.id]);
    await handleCapiEventJob(accountA, { capiEventId: a.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await events(`AND id='${a.id}'`))[0]).toMatchObject({ status: 'unknown' });

    await owner.query('UPDATE capi_events SET message_id=NULL WHERE id=$1', [b.id]);
    await handleCapiEventJob(accountA, { capiEventId: b.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await events(`AND id='${b.id}'`))[0]).toMatchObject({ status: 'skipped' });
  });
});
