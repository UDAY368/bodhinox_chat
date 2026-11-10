// Stage 2 (2B) on a real PostgreSQL: the away message and the AI reply on an
// Instagram conversation. Meta is never called: fetch is stubbed.
// - The away message follows the Instagram switch (off by default), goes out
//   once per off-hours window through the Instagram sender (claim row +
//   outbound intent), is stored as a bot message, and is skipped with
//   window_closed past 24 hours with nothing claimed or sent.
// - The AI reply is stored as an ai_generated bot message.
// - Workspace B's identical conversation is never touched by A's work.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { sendAwayMessage } from './away-message';
import { prepareInstagramAiReply, sendInstagramAiReply } from '@/lib/ai/instagram-send';

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
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let fresh = { conversation: '', contact: '', message: '' };
let stale = { conversation: '', contact: '', message: '' };
let other = { conversation: '', contact: '', message: '' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram away message and AI reply on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG replies', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG A',$2),($3,'IG B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const scopes = ['instagram_business_basic', 'instagram_business_manage_messages'];
    const addAccount = async (accountId: string, userId: string, igUserId: string) => (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`, [accountId, igUserId, encrypt('test-only-ig-token'), scopes, userId])).rows[0].id as string;
    const igA = await addAccount(accountA, ownerA, `83${seed}`);
    const igB = await addAccount(accountB, ownerB, `84${seed}`);
    const thread = async (accountId: string, userId: string, ig: string, igsid: string, age: string) => {
      const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'',NULL) RETURNING id", [accountId, userId])).rows[0].id;
      await owner.query("INSERT INTO contact_channel_identities(account_id,contact_id,channel,instagram_account_id,external_id) VALUES($1,$2,'instagram',$3,$4)",
        [accountId, contact, ig, igsid]);
      const conversation = (await owner.query(
        "INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id",
        [accountId, userId, contact, ig])).rows[0].id;
      const message = (await owner.query(
        `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,created_at)
         VALUES($1,$2,'customer','text','hello',$3,now() - $4::interval) RETURNING id`,
        [accountId, conversation, `mid.in.${randomUUID()}`, age])).rows[0].id;
      return { conversation, contact, message };
    };
    fresh = await thread(accountA, ownerA, igA, `91${seed}`, '1 minute');
    stale = await thread(accountA, ownerA, igA, `92${seed}`, '25 hours');
    other = await thread(accountB, ownerB, igB, `93${seed}`, '1 minute');
    // Closed at every moment except one minute on Sundays, so the customer wrote out of hours.
    for (const accountId of [accountA, accountB]) await owner.query(
      `INSERT INTO workspace_inbox_settings(account_id,timezone,working_hours,away_message_enabled,away_message)
       VALUES($1,'UTC','{"sun":[{"start":"03:00","end":"03:01"}]}'::jsonb,true,'We are closed, back soon.')`, [accountId]);
  });
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const input = (t: typeof fresh, accountId = accountA, userId = ownerA) =>
    ({ accountId, userId, conversationId: t.conversation, contactId: t.contact, messageId: t.message });
  const botRows = async (conversationId: string) => (await owner.query(
    "SELECT content_text, message_id, ai_generated FROM messages WHERE conversation_id=$1 AND sender_type='bot' ORDER BY created_at", [conversationId])).rows;

  it('stays off on Instagram until its own switch is on, even with the WhatsApp switch on', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendAwayMessage(input(fresh))).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await owner.query('SELECT count(*)::int AS n FROM away_message_sends WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
  });

  it('sends once per window through the Instagram sender and stores the bot message', async () => {
    await owner.query('UPDATE workspace_inbox_settings SET instagram_away_message_enabled=true WHERE account_id=$1', [accountA]);
    const fetchMock = vi.fn(async () => json(200, { recipient_id: `91${seed}`, message_id: 'mid.away.1' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendAwayMessage(input(fresh))).toBe('sent');
    expect(await sendAwayMessage(input(fresh))).toBe('already_sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    // Automated: never the Human Agent tag.
    expect(body).toMatchObject({ recipient: { id: `91${seed}` }, message: { text: 'We are closed, back soon.' } });
    expect(body).not.toHaveProperty('tag');
    expect(await botRows(fresh.conversation)).toEqual([{ content_text: 'We are closed, back soon.', message_id: 'mid.away.1', ai_generated: false }]);
    const intents = (await owner.query("SELECT status FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2",
      [accountA, `${accountA}:away:${fresh.conversation}:%`])).rows;
    expect(intents).toEqual([{ status: 'accepted' }]);
  });

  it('skips a customer message older than 24 hours with nothing claimed or sent', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendAwayMessage(input(stale))).toBe('window_closed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await owner.query('SELECT count(*)::int AS n FROM away_message_sends WHERE conversation_id=$1', [stale.conversation])).rows[0].n).toBe(0);
  });

  it('stores the AI reply as an ai_generated bot message, and refuses a closed window before sending', async () => {
    const fetchMock = vi.fn(async () => json(200, { recipient_id: `91${seed}`, message_id: 'mid.ai.1' }));
    vi.stubGlobal('fetch', fetchMock);
    const prepared = await prepareInstagramAiReply(accountA, fresh.conversation, 'Your order ships tomorrow.');
    expect(await sendInstagramAiReply(prepared)).toEqual({ whatsapp_message_id: 'mid.ai.1' });
    expect((await botRows(fresh.conversation)).at(-1)).toEqual({ content_text: 'Your order ships tomorrow.', message_id: 'mid.ai.1', ai_generated: true });
    await expect(prepareInstagramAiReply(accountA, stale.conversation, 'Too late')).rejects.toMatchObject({ code: 'instagram_window_closed' });
    // Another workspace's conversation is not reachable from A's tenant.
    await expect(prepareInstagramAiReply(accountA, other.conversation, 'x')).rejects.toMatchObject({ code: 'not_found' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await botRows(other.conversation)).toEqual([]);
  });
});
