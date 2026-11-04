// Phase 11 T4 on a real PostgreSQL: comment private replies. One reply per
// comment (database unique key + the outbound intent), the 7-day window, an
// ambiguous outcome recorded as 'unknown' and never sent again, throttles
// and the hourly guard re-queued, and nothing at all while Instagram is off.
// Meta is never called: fetch is stubbed per test.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { PRIVATE_REPLY_HOURLY_GUARD, runPrivateReply } from './private-reply';

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
let igA = '', igB = '', ruleA = '';
let commentSeq = 0;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sent = () => json(200, { recipient_id: '9001', message_id: `mid.${randomUUID()}` });

async function addEvent(input: { accountId?: string; instagramAccountId?: string; ruleId?: string | null; ageMs?: number; status?: string } = {}) {
  const commentId = `18${seed}${String(++commentSeq).padStart(4, '0')}`;
  const row = (await owner.query(
    `INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,from_igsid,rule_id,received_at,private_reply_status)
     VALUES($1,$2,$3,'17000000001',$4,$5,now() - make_interval(secs => $6::double precision / 1000),$7) RETURNING id`,
    [input.accountId ?? accountA, input.instagramAccountId ?? igA, commentId, `96${seed}`,
      input.ruleId === undefined ? ruleA : input.ruleId, input.ageMs ?? 60_000, input.status ?? 'queued'],
  )).rows[0];
  return { eventId: row.id as string, commentId };
}
const eventOf = async (id: string) => (await owner.query(
  'SELECT private_reply_status AS status, private_reply_at FROM instagram_comment_events WHERE id=$1', [id])).rows[0] as
  { status: string; private_reply_at: Date | null };
const intentOf = async (accountId: string, commentId: string) => (await owner.query(
  'SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${accountId}:ig_private_reply:${commentId}`])).rows[0]?.status ?? null;
const jobsFor = async (eventId: string) => (await owner.query(
  "SELECT dedupe_key FROM jobs WHERE type='instagram.private_reply' AND payload->>'eventId'=$1", [eventId])).rows.map((r) => r.dedupe_key as string);
const pgCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'error');

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram private replies on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Reply test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reply A',$2),($3,'Reply B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const scopes = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
    const addAccount = async (accountId: string, userId: string, igUserId: string) => (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`, [accountId, igUserId, encrypt('test-only-ig-token'), scopes, userId])).rows[0].id as string;
    igA = await addAccount(accountA, ownerA, `81${seed}`);
    igB = await addAccount(accountB, ownerB, `82${seed}`);
    ruleA = (await owner.query(
      `INSERT INTO instagram_comment_rules(account_id,instagram_account_id,keywords,reply_text,created_by_user_id)
       VALUES($1,$2,ARRAY['price'],'Thanks! We sent you the details.',$3) RETURNING id`, [accountA, igA, ownerA])).rows[0].id;
  });
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('sends one private reply to the comment and never a second', async () => {
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    const { eventId, commentId } = await addEvent();
    expect(await runPrivateReply(accountA, { eventId })).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/81${seed}/messages`);
    expect(JSON.parse(String(init.body))).toEqual({ recipient: { comment_id: commentId }, message: { text: 'Thanks! We sent you the details.' } });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-only-ig-token');
    expect(await eventOf(eventId)).toMatchObject({ status: 'sent', private_reply_at: expect.any(Date) });
    expect(await intentOf(accountA, commentId)).toBe('accepted');

    // A replayed job does nothing.
    expect(await runPrivateReply(accountA, { eventId })).toBe('noop');
    // Even forced back to queued, the accepted intent is not sent again.
    await owner.query("UPDATE instagram_comment_events SET private_reply_status='queued' WHERE id=$1", [eventId]);
    expect(await runPrivateReply(accountA, { eventId })).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a second row for the same comment in the database', async () => {
    const { commentId } = await addEvent();
    expect(await pgCode(owner.query(
      `INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,private_reply_status) VALUES($1,$2,$3,'queued')`,
      [accountA, igA, commentId]))).toBe('23505');
  });

  it('expires a comment older than 7 days without calling Meta', async () => {
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    const { eventId, commentId } = await addEvent({ ageMs: 7 * 24 * 3600_000 + 60_000 });
    expect(await runPrivateReply(accountA, { eventId })).toBe('expired');
    expect((await eventOf(eventId)).status).toBe('expired');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await intentOf(accountA, commentId)).toBeNull();
  });

  it('records an ambiguous outcome as unknown and never sends it again', async () => {
    const fetchMock = vi.fn(async () => json(500, { error: { message: 'internal', code: 2 } }));
    vi.stubGlobal('fetch', fetchMock);
    const { eventId, commentId } = await addEvent();
    expect(await runPrivateReply(accountA, { eventId })).toBe('unknown');
    expect((await eventOf(eventId)).status).toBe('unknown');
    expect(await intentOf(accountA, commentId)).toBe('unknown');
    expect(await runPrivateReply(accountA, { eventId })).toBe('noop');
    // Forced back to queued: the unknown intent blocks the send; nothing is cleared.
    await owner.query("UPDATE instagram_comment_events SET private_reply_status='queued' WHERE id=$1", [eventId]);
    fetchMock.mockImplementation(async () => sent());
    expect(await runPrivateReply(accountA, { eventId })).toBe('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await intentOf(accountA, commentId)).toBe('unknown');
  });

  it('re-queues a throttled reply and sends it on the next run', async () => {
    const fetchMock = vi.fn(async () => json(429, { error: { message: 'slow down', code: 4 } }));
    vi.stubGlobal('fetch', fetchMock);
    const { eventId, commentId } = await addEvent();
    expect(await runPrivateReply(accountA, { eventId })).toBe('throttled');
    expect((await eventOf(eventId)).status).toBe('queued');
    expect(await intentOf(accountA, commentId)).toBe('failed');
    expect((await jobsFor(eventId)).some((key) => key.startsWith(`igpr:${eventId}:throttle:`))).toBe(true);
    fetchMock.mockImplementation(async () => sent());
    expect(await runPrivateReply(accountA, { eventId })).toBe('sent');
    expect(await intentOf(accountA, commentId)).toBe('accepted');
  });

  it('marks a Meta rejection and an invalid token, and stops', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: { message: 'no', code: 10, error_subcode: 2534022 } })));
    const rejected = await addEvent();
    expect(await runPrivateReply(accountA, { eventId: rejected.eventId })).toBe('rejected');
    expect((await eventOf(rejected.eventId)).status).toBe('rejected');

    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { message: 'expired', code: 190 } })));
    const expired = await addEvent();
    expect(await runPrivateReply(accountA, { eventId: expired.eventId })).toBe('rejected');
    expect((await owner.query('SELECT status,last_error_code FROM instagram_accounts WHERE id=$1', [igA])).rows[0])
      .toEqual({ status: 'token_invalid', last_error_code: '190' });
    // While the token is invalid nothing is sent.
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    const later = await addEvent();
    expect(await runPrivateReply(accountA, { eventId: later.eventId })).toBe('rejected');
    expect(fetchMock).not.toHaveBeenCalled();
    // The token_invalid change notifies each owner/admin once (workspace A has one owner).
    expect((await owner.query(
      "SELECT user_id::text AS user_id FROM notifications WHERE instagram_account_id=$1 AND type='instagram_account_health'", [igA])).rows)
      .toEqual([{ user_id: ownerA }]);
    await owner.query("UPDATE instagram_accounts SET status='active', last_error_code=NULL WHERE id=$1", [igA]);
    await owner.query("DELETE FROM notifications WHERE instagram_account_id=$1", [igA]);
  });

  it('a 190 for a token replaced by a reconnect meanwhile leaves the account active and notifies nobody', async () => {
    const fresh = encrypt('test-only-ig-token-fresh');
    vi.stubGlobal('fetch', vi.fn(async () => {
      // An admin reconnects while the send with the old token is in flight.
      await owner.query('UPDATE instagram_accounts SET access_token_enc=$1 WHERE id=$2', [fresh, igA]);
      return json(401, { error: { message: 'expired', code: 190 } });
    }));
    const { eventId } = await addEvent();
    try {
      expect(await runPrivateReply(accountA, { eventId })).toBe('rejected');
      expect((await owner.query('SELECT status, access_token_enc FROM instagram_accounts WHERE id=$1', [igA])).rows[0])
        .toEqual({ status: 'active', access_token_enc: fresh });
      expect((await owner.query(
        "SELECT count(*)::int AS n FROM notifications WHERE instagram_account_id=$1 AND type='instagram_account_health'", [igA])).rows[0].n)
        .toBe(0);
    } finally {
      await owner.query("UPDATE instagram_accounts SET status='active', last_error_code=NULL, access_token_enc=$1 WHERE id=$2",
        [encrypt('test-only-ig-token'), igA]);
    }
  });

  it('refuses without the comments scope, a switched-off rule or no rule', async () => {
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    await owner.query("UPDATE instagram_accounts SET scopes=ARRAY['instagram_business_basic','instagram_business_manage_messages'] WHERE id=$1", [igA]);
    const noScope = await addEvent();
    expect(await runPrivateReply(accountA, { eventId: noScope.eventId })).toBe('rejected');
    await owner.query("UPDATE instagram_accounts SET scopes=scopes || ARRAY['instagram_business_manage_comments'] WHERE id=$1", [igA]);

    await owner.query('UPDATE instagram_comment_rules SET active=false WHERE id=$1', [ruleA]);
    const ruleOff = await addEvent();
    expect(await runPrivateReply(accountA, { eventId: ruleOff.eventId })).toBe('no_rule');
    await owner.query('UPDATE instagram_comment_rules SET active=true WHERE id=$1', [ruleA]);

    const noRule = await addEvent({ ruleId: null });
    expect(await runPrivateReply(accountA, { eventId: noRule.eventId })).toBe('no_rule');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it(`re-queues at ${PRIVATE_REPLY_HOURLY_GUARD} replies in the last hour`, async () => {
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    // Account B's own hour is full; account A's count is separate.
    await owner.query(
      `INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,private_reply_status,private_reply_at)
       SELECT $1,$2,'19' || $3 || lpad(g::text,5,'0'),'sent',now() - interval '10 minutes' FROM generate_series(1,$4::int) g`,
      [accountB, igB, seed, PRIVATE_REPLY_HOURLY_GUARD]);
    const full = await addEvent({ accountId: accountB, instagramAccountId: igB, ruleId: null });
    const ruleB = (await owner.query(
      `INSERT INTO instagram_comment_rules(account_id,instagram_account_id,reply_text) VALUES($1,$2,'Hi') RETURNING id`, [accountB, igB])).rows[0].id;
    await owner.query('UPDATE instagram_comment_events SET rule_id=$1 WHERE id=$2', [ruleB, full.eventId]);
    expect(await runPrivateReply(accountB, { eventId: full.eventId })).toBe('rate_limited');
    expect((await eventOf(full.eventId)).status).toBe('queued');
    expect((await jobsFor(full.eventId)).some((key) => key.startsWith(`igpr:${full.eventId}:rate:`))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const other = await addEvent();
    expect(await runPrivateReply(accountA, { eventId: other.eventId })).toBe('sent');
  });

  it('cannot reach another workspace\'s event', async () => {
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    const { eventId } = await addEvent();
    expect(await runPrivateReply(accountB, { eventId })).toBe('noop');
    expect((await eventOf(eventId)).status).toBe('queued');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing while Instagram is off', async () => {
    vi.stubEnv('INSTAGRAM_ENABLED', 'false');
    const fetchMock = vi.fn(async () => sent());
    vi.stubGlobal('fetch', fetchMock);
    const { eventId, commentId } = await addEvent();
    expect(await runPrivateReply(accountA, { eventId })).toBe('disabled');
    expect((await eventOf(eventId)).status).toBe('queued');
    expect(await intentOf(accountA, commentId)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
