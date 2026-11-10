// Phase 11 T3 on a real PostgreSQL: Instagram webhook ingestion. A delivery is
// persisted as a receipt + job and processed like the worker does. Proves the
// dedupe keys (receipt by body hash, identity by (account, IGSID), conversation
// by its unique index, message by mid), that a new IGSID never matches an
// existing contact (CRM-02), that echoes are agent messages, that comments
// queue one private reply, and that nothing is written while Instagram is off
// or for an account no workspace connected.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { persistInstagramWebhook } from './webhook';
import { processInstagramWebhookJob } from './process-webhook';
import { runPrivateReply } from './private-reply';

const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
const igUserA1 = `81${seed}`, igUserA2 = `82${seed}`, igUserB = `83${seed}`, igUserUnknown = `89${seed}`;
let owner: pg.Client;
let igA1 = '', igA2 = '';
const receipts: string[] = [];
let n = 0;

const env = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123', INSTAGRAM_APP_SECRET: 'test-only-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify', APP_URL: 'https://app.example.test',
};
const igsid = () => `7${seed}${String(++n).padStart(3, '0')}`;

async function addInstagramAccount(accountId: string, userId: string, igUserId: string, scopes: string[]): Promise<string> {
  return (await owner.query(
    `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
     VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`,
    [accountId, igUserId, encrypt('test-only-ig-token'), scopes, userId],
  )).rows[0].id;
}

/** What the route does after verifying the signature, then what the worker does. */
async function deliver(body: Record<string, unknown>): Promise<string> {
  const raw = JSON.stringify(body);
  const receiptId = await persistInstagramWebhook(raw, body);
  receipts.push(receiptId);
  await processInstagramWebhookJob({ receiptId });
  return receiptId;
}
const entry = (accountIgId: string, part: Record<string, unknown>) => ({ object: 'instagram', entry: [{ id: accountIgId, time: Date.now(), ...part }] });
const dm = (from: string, to: string, mid: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ sender: { id: from }, recipient: { id: to }, timestamp: Date.now() - 1000, message: { mid, text, ...extra } });

const identitiesOf = async (accountId: string, externalId: string) => (await owner.query(
  'SELECT id, contact_id, instagram_account_id FROM contact_channel_identities WHERE account_id=$1 AND external_id=$2 ORDER BY created_at',
  [accountId, externalId])).rows as { id: string; contact_id: string; instagram_account_id: string }[];
const conversationsOf = async (contactId: string) => (await owner.query(
  'SELECT id, channel, whatsapp_config_id, instagram_account_id FROM conversations WHERE contact_id=$1', [contactId])).rows;
const messagesOf = async (conversationId: string) => (await owner.query(
  'SELECT message_id, sender_type, content_type, content_text, interactive_payload FROM messages WHERE conversation_id=$1 ORDER BY created_at, message_id',
  [conversationId])).rows as { message_id: string; sender_type: string; content_type: string; content_text: string | null; interactive_payload: unknown }[];
const receiptStatus = async (id: string) => (await owner.query('SELECT status FROM webhook_receipts WHERE id=$1', [id])).rows[0]?.status;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram ingest on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ingest test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ingest A',$2),($3,'Ingest B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const dmScopes = ['instagram_business_basic', 'instagram_business_manage_messages'];
    igA1 = await addInstagramAccount(accountA, ownerA, igUserA1, [...dmScopes, 'instagram_business_manage_comments']);
    igA2 = await addInstagramAccount(accountA, ownerA, igUserA2, dmScopes);
    await addInstagramAccount(accountB, ownerB, igUserB, dmScopes);
  });
  beforeEach(() => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      if (receipts.length) {
        await owner.query("DELETE FROM jobs WHERE type='instagram.webhook' AND payload->>'receiptId' = ANY($1::text[])", [receipts]);
        await owner.query('DELETE FROM webhook_receipts WHERE id=ANY($1::uuid[])', [receipts]);
      }
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('the same IGSID twice gives one identity, contact and conversation; a new IGSID gets a phone-less, unnamed contact', async () => {
    const user = igsid();
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}-1`, 'hello')] }));
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}-2`, 'again')] }));
    const identities = await identitiesOf(accountA, user);
    expect(identities).toHaveLength(1);
    const contact = (await owner.query('SELECT phone, name FROM contacts WHERE id=$1', [identities[0].contact_id])).rows[0];
    // No IGSID or handle in contacts.name: every list, search and event returns it unmasked.
    expect(contact).toEqual({ phone: '', name: null });
    const conversations = await conversationsOf(identities[0].contact_id);
    expect(conversations).toEqual([{ id: expect.any(String), channel: 'instagram', whatsapp_config_id: null, instagram_account_id: igA1 }]);
    const messages = await messagesOf(conversations[0].id);
    expect(messages.map((m) => [m.message_id, m.sender_type, m.content_type, m.content_text]))
      .toEqual([[`mid-${user}-1`, 'customer', 'text', 'hello'], [`mid-${user}-2`, 'customer', 'text', 'again']]);
    // One profile fetch is queued for the new identity.
    const jobs = (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='instagram.profile_fetch' AND dedupe_key=$1",
      [`igprofile:${identities[0].id}`])).rows[0].n;
    expect(jobs).toBe(1);
  });

  it('the same body twice is one receipt and one message, and reprocessing stores nothing twice', async () => {
    const user = igsid();
    const body = entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}`, 'once')] });
    const first = await deliver(body);
    const second = await deliver(body);
    expect(second).toBe(first);
    await owner.query("UPDATE webhook_receipts SET status='received' WHERE id=$1", [first]);
    await processInstagramWebhookJob({ receiptId: first });
    const [identity] = await identitiesOf(accountA, user);
    const [conversation] = await conversationsOf(identity.contact_id);
    expect(await messagesOf(conversation.id)).toHaveLength(1);
    expect(await receiptStatus(first)).toBe('processed');
  });

  it('the same IGSID on two connected accounts gives two identities and two contacts', async () => {
    const user = igsid();
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}-a1`, 'to one')] }));
    await deliver(entry(igUserA2, { messaging: [dm(user, igUserA2, `mid-${user}-a2`, 'to two')] }));
    const identities = await identitiesOf(accountA, user);
    expect(identities.map((i) => i.instagram_account_id).sort()).toEqual([igA1, igA2].sort());
    expect(new Set(identities.map((i) => i.contact_id)).size).toBe(2);
  });

  it('never matches an existing contact: a WhatsApp contact with the same name stays separate', async () => {
    const user = igsid();
    const waContact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id",
      [accountA, ownerA, `+1415${seed.slice(-7)}`, `@${user}`])).rows[0].id;
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}`, 'hi')] }));
    const [identity] = await identitiesOf(accountA, user);
    expect(identity.contact_id).not.toBe(waContact);
    expect(await conversationsOf(waContact)).toEqual([]);
  });

  it('stores an echo as an agent message on the existing thread and never opens one', async () => {
    const user = igsid();
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}-in`, 'question')] }));
    await deliver(entry(igUserA1, { messaging: [dm(igUserA1, user, `mid-${user}-echo`, 'answer from the app', { is_echo: true })] }));
    const [identity] = await identitiesOf(accountA, user);
    const [conversation] = await conversationsOf(identity.contact_id);
    const echo = (await messagesOf(conversation.id)).find((m) => m.message_id === `mid-${user}-echo`);
    expect(echo).toMatchObject({ sender_type: 'agent', content_text: 'answer from the app', interactive_payload: { ig: { external_echo: true } } });
    // An echo to someone who never wrote creates nothing.
    const stranger = igsid();
    await deliver(entry(igUserA1, { messaging: [dm(igUserA1, stranger, `mid-${stranger}-echo`, 'cold', { is_echo: true })] }));
    expect(await identitiesOf(accountA, stranger)).toEqual([]);
  });

  it('stores unsupported attachments as unsupported bubbles and counts reactions and reads on the account', async () => {
    const user = igsid();
    const before = (await owner.query('SELECT unsupported_event_count AS n FROM instagram_accounts WHERE id=$1', [igA1])).rows[0].n;
    await deliver(entry(igUserA1, { messaging: [
      dm(user, igUserA1, `mid-${user}-sticker`, '', { text: undefined, attachments: [{ type: 'some_new_type', payload: { url: 'https://cdn.example/x' } }] }),
      { sender: { id: user }, recipient: { id: igUserA1 }, timestamp: Date.now(), reaction: { mid: `mid-${user}-sticker`, action: 'react' } },
      { sender: { id: user }, recipient: { id: igUserA1 }, timestamp: Date.now(), read: { mid: `mid-${user}-sticker` } },
    ] }));
    const [identity] = await identitiesOf(accountA, user);
    const [conversation] = await conversationsOf(identity.contact_id);
    expect((await messagesOf(conversation.id)).map((m) => m.content_type)).toEqual(['unsupported']);
    const after = (await owner.query('SELECT unsupported_event_count AS n FROM instagram_accounts WHERE id=$1', [igA1])).rows[0].n;
    expect(after - before).toBe(2);
  });

  it('counts unsupported events once per receipt, even when the job is retried after a failed entry', async () => {
    const user = igsid();
    const count = async () => (await owner.query('SELECT unsupported_event_count AS n FROM instagram_accounts WHERE id=$1', [igA1])).rows[0].n as number;
    const before = await count();
    const body = { object: 'instagram', entry: [
      { id: igUserA1, time: Date.now(), messaging: [
        { sender: { id: user }, recipient: { id: igUserA1 }, timestamp: Date.now(), reaction: { mid: 'x', action: 'react' } },
        { sender: { id: user }, recipient: { id: igUserA1 }, timestamp: Date.now(), read: { mid: 'x' } }] },
      { id: igUserA1, time: Date.now(), messaging: [dm(user, igUserA1, `mid-${user}-retry`, 'hi')] },
    ] };
    const receiptId = await persistInstagramWebhook(JSON.stringify(body), body);
    receipts.push(receiptId);
    // [audit-38] inbound Instagram processing gets the long retry budget, like WhatsApp's.
    expect((await owner.query('SELECT max_attempts FROM jobs WHERE dedupe_key=$1', [`igwebhook:${receiptId}`])).rows[0].max_attempts).toBe(8);
    // The first attempt loses its lease on the second entry, after counting the first one in memory.
    let calls = 0;
    await expect(processInstagramWebhookJob({ receiptId }, () => { if (++calls === 4) throw new Error('lease lost'); })).rejects.toThrow('lease lost');
    expect(await count()).toBe(before);
    expect(await receiptStatus(receiptId)).not.toBe('processed');
    await processInstagramWebhookJob({ receiptId });
    await processInstagramWebhookJob({ receiptId });
    expect(await count()).toBe(before + 2);
    expect(await receiptStatus(receiptId)).toBe('processed');
  });

  it('a blocked contact\'s comment is rejected with no private reply job', async () => {
    const user = igsid();
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}-b`, 'hi')] }));
    const [identity] = await identitiesOf(accountA, user);
    await owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,keywords,reply_text,active,created_by_user_id)
       VALUES($1,$2,ARRAY['blockedkw'],'We sent you a DM',true,$3)`, [accountA, igA1, ownerA]);
    const comment = async (commentId: string) => {
      await deliver(entry(igUserA1, { changes: [{ field: 'comments', value: { id: commentId, text: 'blockedkw', media: { id: '1' }, from: { id: user } } }] }));
      return (await owner.query('SELECT id, private_reply_status FROM instagram_comment_events WHERE comment_id=$1', [commentId])).rows[0] as
        { id: string; private_reply_status: string };
    };
    const jobsOf = async (eventId: string) =>
      (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='instagram.private_reply' AND payload->>'eventId'=$1", [eventId])).rows[0].n;
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      // Queued while the contact was not blocked, then blocked before the job ran: refused at send time.
      const queued = await comment(`6${seed}8`);
      expect(queued.private_reply_status).toBe('queued');
      await owner.query('UPDATE contacts SET blocked_at=now() WHERE id=$1', [identity.contact_id]);
      expect(await runPrivateReply(accountA, { eventId: queued.id })).toBe('rejected');
      expect((await owner.query('SELECT private_reply_status AS s FROM instagram_comment_events WHERE id=$1', [queued.id])).rows[0].s).toBe('rejected');
      expect((await owner.query("SELECT count(*)::int AS n FROM outbound_intents WHERE idempotency_key LIKE $1", [`%ig_private_reply:6${seed}8`])).rows[0].n).toBe(0);
      // Already blocked when the comment arrives: never queued.
      const refused = await comment(`6${seed}9`);
      expect(refused.private_reply_status).toBe('rejected');
      expect(await jobsOf(refused.id)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('records a comment once and queues one private reply when a rule matches; without the scope it is only counted', async () => {
    const rule = (await owner.query(
      `INSERT INTO instagram_comment_rules(account_id,instagram_account_id,keywords,reply_text,active,created_by_user_id)
       VALUES($1,$2,ARRAY['price'],'We sent you a DM',true,$3) RETURNING id`, [accountA, igA1, ownerA])).rows[0].id;
    const commentId = `6${seed}1`;
    const body = entry(igUserA1, { changes: [{ field: 'comments', value: { id: commentId, text: 'Price please', media: { id: '1' }, from: { id: igsid() } } }] });
    await deliver(body);
    await deliver({ ...body, entry: [{ ...(body.entry[0]), time: Date.now() + 1 }] }); // a redelivery with a different body hash
    const events = (await owner.query('SELECT id, rule_id, private_reply_status FROM instagram_comment_events WHERE comment_id=$1', [commentId])).rows;
    expect(events).toEqual([{ id: expect.any(String), rule_id: rule, private_reply_status: 'queued' }]);
    const jobs = (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='instagram.private_reply' AND dedupe_key=$1", [`igpr:${events[0].id}`])).rows[0].n;
    expect(jobs).toBe(1);
    // Account A2 has no comments scope: the change is counted, not stored.
    const other = `6${seed}2`;
    await deliver(entry(igUserA2, { changes: [{ field: 'comments', value: { id: other, text: 'price', from: { id: igsid() } } }] }));
    expect((await owner.query('SELECT count(*)::int AS n FROM instagram_comment_events WHERE comment_id=$1', [other])).rows[0].n).toBe(0);
  });

  it('writes nothing for an account no workspace connected', async () => {
    const user = igsid();
    const receipt = await deliver(entry(igUserUnknown, { messaging: [dm(user, igUserUnknown, `mid-${user}`, 'hi')] }));
    expect((await owner.query('SELECT count(*)::int AS n FROM contact_channel_identities WHERE external_id=$1', [user])).rows[0].n).toBe(0);
    expect(await receiptStatus(receipt)).toBe('processed');
  });

  it('a job queued while on does nothing once Instagram is off', async () => {
    const user = igsid();
    const body = entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}`, 'late')] });
    const raw = JSON.stringify(body);
    const receiptId = await persistInstagramWebhook(raw, body);
    receipts.push(receiptId);
    vi.stubEnv('INSTAGRAM_ENABLED', '');
    await processInstagramWebhookJob({ receiptId });
    expect(await receiptStatus(receiptId)).toBe('skipped_disabled');
    expect(await identitiesOf(accountA, user)).toEqual([]);
  });

  it('keeps workspaces apart: workspace B never sees workspace A identities', async () => {
    const user = igsid();
    await deliver(entry(igUserA1, { messaging: [dm(user, igUserA1, `mid-${user}`, 'hi')] }));
    expect(await identitiesOf(accountB, user)).toEqual([]);
  });
});
