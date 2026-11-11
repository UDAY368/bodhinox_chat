import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { queueStaleProfileRechecks } from '@/lib/instagram/profile';
import { AudienceFilterError } from './filter';
import { createSegment, previewAudience, segmentContacts } from './segments';

// Segments by Instagram profile facts and the 24-hour window, and the stale-profile
// re-check queue, against real rows: every statement is scoped to the account.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const savedEnv = { ...process.env };
const accountA = randomUUID(), accountB = randomUUID();
const agent = randomUUID(), outsider = randomUUID();
const a: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const b: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
const digits = () => String(Math.floor(Math.random() * 9e15) + 1e15);
const ids = { igA: '', igADead: '', igB: '', follower: '', stranger: '', whatsappOnly: '', fresh: '', dead: '', foreign: '' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram profile segments on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    process.env.INSTAGRAM_ENABLED = 'true';
    process.env.INSTAGRAM_APP_ID = '1234567890';
    process.env.INSTAGRAM_APP_SECRET = 'test-only-secret';
    process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN = 'test-only-verify';
    process.env.APP_URL = 'https://app.example.invalid';
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG profile test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG profile A',$2),($3,'IG profile B',$4)", [accountA, agent, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [accountA, agent, accountB, outsider]);
    const ig = (account: string, user: string, status = 'active') => owner.query<{ id: string }>(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id,status)
       VALUES($1,$2,'profile_test','enc-test-only-token',$3,$4) RETURNING id`, [account, digits(), user, status]).then((r) => r.rows[0].id);
    ids.igA = await ig(accountA, agent);
    ids.igADead = await ig(accountA, agent, 'token_invalid');
    ids.igB = await ig(accountB, outsider);
    const contact = (account: string, user: string, name: string) => owner.query<{ id: string }>(
      'INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,$3,$4) RETURNING id', [account, user, name, `+1415${digits().slice(0, 7)}`]).then((r) => r.rows[0].id);
    const identity = (account: string, contactId: string, igId: string, facts: string) => owner.query<{ id: string }>(
      `INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id,follows_business,business_follows,is_verified,ig_follower_count,profile_checked_at)
       VALUES($1,$2,$3,$4,${facts}) RETURNING id`, [account, contactId, igId, digits()]).then((r) => r.rows[0].id);
    const conversation = (account: string, user: string, contactId: string, igId: string | null) => owner.query<{ id: string }>(
      igId ? "INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id"
        : 'INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
      igId ? [account, user, contactId, igId] : [account, user, contactId]).then((r) => r.rows[0].id);
    const customerSaid = (account: string, conversationId: string, ago: string) => owner.query(
      `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
       VALUES($1,$2,'customer','text','hello','delivered',now()-interval '${ago}')`, [account, conversationId]);

    // A follower: follows you, verified, 1500 followers, wrote 1 hour ago, facts fresh.
    const c1 = await contact(accountA, agent, 'Follower');
    ids.follower = await identity(accountA, c1, ids.igA, 'true,false,true,1500,now()');
    const conv1 = await conversation(accountA, agent, c1, ids.igA);
    await customerSaid(accountA, conv1, '1 hour');
    // A stranger: does not follow you, verification unknown, 10 followers, wrote 30 hours ago, facts never read.
    const c2 = await contact(accountA, agent, 'Stranger');
    ids.stranger = await identity(accountA, c2, ids.igA, 'false,NULL,NULL,10,NULL');
    const conv2 = await conversation(accountA, agent, c2, ids.igA);
    await customerSaid(accountA, conv2, '30 hours');
    // A contact with only WhatsApp: no Instagram identity, no Instagram conversation.
    const c3 = await contact(accountA, agent, 'WhatsApp only');
    ids.whatsappOnly = c3;
    const wa = await conversation(accountA, agent, c3, null);
    await customerSaid(accountA, wa, '1 hour');
    // An identity on an account whose token is invalid, facts read 8 days ago: stale but not re-checkable.
    const c4 = await contact(accountA, agent, 'Dead account');
    ids.dead = await identity(accountA, c4, ids.igADead, "true,true,true,99999,now()-interval '8 days'");
    // Fresh facts, read an hour ago.
    const c5 = await contact(accountA, agent, 'Fresh');
    ids.fresh = await identity(accountA, c5, ids.igA, "true,NULL,false,2000,now()-interval '1 hour'");
    // The other workspace has a follower inside the window, which must never show in A.
    const cb = await contact(accountB, outsider, 'Other workspace');
    ids.foreign = await identity(accountB, cb, ids.igB, 'true,true,true,5000000,NULL');
    const convB = await conversation(accountB, outsider, cb, ids.igB);
    await customerSaid(accountB, convB, '1 minute');
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  const count = async (ctx: TenantContext, condition: unknown) => (await previewAudience(ctx, { filter: { conditions: [condition] } })).total;
  const jobs = async () => (await owner.query<{ payload: Record<string, unknown>; dedupe_key: string; tenant_id: string }>(
    "SELECT payload,dedupe_key,tenant_id::text FROM jobs WHERE type='instagram.profile_fetch' AND tenant_id = ANY($1::uuid[]) ORDER BY dedupe_key", [[accountA, accountB]])).rows;

  it('counts follow, verified and unknown facts per workspace, and never across workspaces', async () => {
    // A: follower and fresh and dead follow you; the stranger does not.
    expect(await count(a, { field: 'instagram_profile', fact: 'follows_business', op: 'is_true' })).toBe(3);
    expect(await count(a, { field: 'instagram_profile', fact: 'follows_business', op: 'is_false' })).toBe(1);
    expect(await count(a, { field: 'instagram_profile', fact: 'is_verified', op: 'is_true' })).toBe(2);
    expect(await count(a, { field: 'instagram_profile', fact: 'is_verified', op: 'is_unknown' })).toBe(1);
    expect(await count(a, { field: 'instagram_profile', fact: 'business_follows', op: 'is_unknown' })).toBe(2);
    // The WhatsApp-only contact has no Instagram identity, so it matches none of these, "unknown" included (1 above, not 2).
    // B sees its own single follower, not A's.
    expect(await count(b, { field: 'instagram_profile', fact: 'follows_business', op: 'is_true' })).toBe(1);
    expect(await count(b, { field: 'instagram_profile', fact: 'follows_business', op: 'is_false' })).toBe(0);
  });

  it('counts follower bounds', async () => {
    expect(await count(a, { field: 'instagram_followers', op: 'at_least', value: 1500 })).toBe(3);
    expect(await count(a, { field: 'instagram_followers', op: 'at_most', value: 100 })).toBe(1);
    expect(await count(b, { field: 'instagram_followers', op: 'at_least', value: 1500 })).toBe(1);
  });

  it('separates the open window from the closed one, ignoring WhatsApp chats and other workspaces', async () => {
    // Open: only the follower (1 hour ago). The WhatsApp-only contact wrote an hour ago but not on Instagram.
    expect(await count(a, { field: 'instagram_window', op: 'open' })).toBe(1);
    // Closed: has an Instagram conversation and none in the window = the stranger (30 hours).
    expect(await count(a, { field: 'instagram_window', op: 'closed' })).toBe(1);
    expect(await count(b, { field: 'instagram_window', op: 'open' })).toBe(1);
  });

  it('combines the facts with the window in one saved segment and lists its contacts', async () => {
    const segment = await createSegment(a, { name: 'Open followers', filter: { conditions: [
      { field: 'instagram_profile', fact: 'follows_business', op: 'is_true' }, { field: 'instagram_window', op: 'open' }] } });
    const page = await segmentContacts(a, segment.id, { offset: 0, limit: 10 });
    expect(page.total).toBe(1);
    expect(page.contacts.map((c) => c.name)).toEqual(['Follower']);
    // Another workspace cannot read A's segment.
    await expect(segmentContacts(b, segment.id, { offset: 0, limit: 10 })).rejects.toThrow();
  });

  it('refuses malformed profile conditions', async () => {
    await expect(previewAudience(a, { filter: { conditions: [{ field: 'instagram_profile', fact: 'follower_count', op: 'is_true' }] } })).rejects.toBeInstanceOf(AudienceFilterError);
    await expect(previewAudience(a, { filter: { conditions: [{ field: 'instagram_followers', op: 'at_least', value: -1 }] } })).rejects.toBeInstanceOf(AudienceFilterError);
  });

  it('queues a facts re-check only for stale, usable identities of the counting workspace, once per day', async () => {
    // The counts above already queued, for A: the stranger (never read) only. The follower and the fresh
    // identity were read recently, and the invalid-token account's identity cannot be re-read.
    const queued = await jobs();
    expect(queued.filter((j) => j.tenant_id === accountA).map((j) => j.payload.identityId)).toEqual([ids.stranger]);
    // B's own count queued B's own identity, never one of A's.
    expect(queued.filter((j) => j.tenant_id === accountB).map((j) => j.payload.identityId)).toEqual([ids.foreign]);
    // Counting again the same day queues nothing new.
    const before = (await jobs()).length;
    await count(a, { field: 'instagram_profile', fact: 'follows_business', op: 'is_true' });
    expect((await jobs()).length).toBe(before);
    // The job carries ids and a flag, never a name or a handle.
    const job = queued.find((j) => j.payload.identityId === ids.stranger)!;
    expect(job.payload).toEqual({ accountId: accountA, identityId: ids.stranger, facts: true });
    expect(job.dedupe_key).toMatch(new RegExp(`^igfacts:${ids.stranger}:\\d{4}-\\d{2}-\\d{2}$`));
  });

  it('queues for the transaction tenant only, and not at all while Instagram is off', async () => {
    const day = new Date('2027-01-05T00:00:00Z');
    const n = await withTenant(b, (tx) => queueStaleProfileRechecks(tx, accountB, day));
    expect(n).toBe(1);
    const rows = (await jobs()).filter((j) => j.dedupe_key.endsWith(':2027-01-05'));
    expect(rows.map((j) => j.tenant_id)).toEqual([accountB]);
    expect(rows[0].payload.identityId).toBe(ids.foreign);
    // Asking for another workspace's identities from this transaction finds none: the tenant filter and RLS agree.
    const crossed = await withTenant(b, (tx) => queueStaleProfileRechecks(tx, accountA, new Date('2027-01-06T00:00:00Z')));
    expect(crossed).toBe(0);
    process.env.INSTAGRAM_ENABLED = 'false';
    expect(await withTenant(a, (tx) => queueStaleProfileRechecks(tx, accountA, new Date('2027-01-07T00:00:00Z')))).toBe(0);
    process.env.INSTAGRAM_ENABLED = 'true';
  });
});
