// Stage 1 channel inboxes on PostgreSQL: a channel inbox's loader reads only
// its channel's conversations through the tenant-scoped data contract (full
// and incremental loads), the All view reads every channel, and the ?c=
// redirect lookup finds only the signed-in workspace's conversations.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScopedClient } from '@/lib/data/server';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { conversationChannelById } from './channel-inbox';
import { loadInboxConversations } from './conversations';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agent = randomUUID(), ownerB = randomUUID();
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const ownerOfB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);

let owner: pg.Client;
let waA = '', igA = '', waB = '';

const ids = (rows: { id: string }[] | null) => (rows ?? []).map((row) => row.id).sort();

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('channel inboxes on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');

    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Inbox test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agent, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Inbox A',$2),($3,'Inbox B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, ownerA, agent, accountB, ownerB]);
    const contact = async (accountId: string, userId: string, phone: string) =>
      (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
        [accountId, userId, phone, 'Inbox contact'])).rows[0].id as string;
    const [contactA, contactA2, contactB] = [await contact(accountA, ownerA, `1415${seed}`), await contact(accountA, ownerA, `1416${seed}`),
      await contact(accountB, ownerB, `1417${seed}`)];
    const instagramAccount = (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id)
       VALUES($1,$2,'inbox_a','enc-test-token',$3) RETURNING id`, [accountA, `8${seed}`, ownerA])).rows[0].id as string;
    // A: one WhatsApp conversation (the column default) and one Instagram; B: one WhatsApp.
    waA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,last_message_at) VALUES($1,$2,$3,NOW()) RETURNING id',
      [accountA, ownerA, contactA])).rows[0].id;
    igA = (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id,last_message_at)
      VALUES($1,$2,$3,'instagram',$4,NOW()) RETURNING id`, [accountA, ownerA, contactA2, instagramAccount])).rows[0].id;
    waB = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,last_message_at) VALUES($1,$2,$3,NOW()) RETURNING id',
      [accountB, ownerB, contactB])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, agent, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('a channel inbox loads only its channel, and only its own workspace', async () => {
    const db = createScopedClient(agentA);
    const whatsapp = await loadInboxConversations(db, { channel: 'whatsapp' });
    expect(whatsapp.error).toBeNull();
    expect(ids(whatsapp.data)).toEqual([waA]);
    expect(whatsapp.data?.[0]).toMatchObject({ channel: 'whatsapp' });
    const instagram = await loadInboxConversations(db, { channel: 'instagram' });
    expect(ids(instagram.data)).toEqual([igA]);
    // The All view reads every channel, never the other workspace's rows.
    expect(ids((await loadInboxConversations(db)).data)).toEqual([waA, igA].sort());
    expect(ids((await loadInboxConversations(createScopedClient(ownerOfB), { channel: 'instagram' })).data)).toEqual([]);
    expect(ids((await loadInboxConversations(createScopedClient(ownerOfB))).data)).toEqual([waB]);
  });

  it('an incremental sync keeps the channel filter', async () => {
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const db = createScopedClient(agentA);
    expect(ids((await loadInboxConversations(db, { channel: 'instagram', updatedSince: since })).data)).toEqual([igA]);
    expect(ids((await loadInboxConversations(db, { channel: 'whatsapp', updatedSince: since })).data)).toEqual([waA]);
  });

  it('the ?c= lookup answers the channel of its own workspace\'s conversations only', async () => {
    const lookup = (context: TenantContext, accountId: string, id: string) =>
      withTenant(context, (tx) => conversationChannelById(tx, accountId, id));
    expect(await lookup(agentA, accountA, waA)).toBe('whatsapp');
    expect(await lookup(agentA, accountA, igA)).toBe('instagram');
    // Another workspace's id is not found, even when its account id is passed (RLS).
    expect(await lookup(agentA, accountA, waB)).toBeNull();
    expect(await lookup(agentA, accountB, waB)).toBeNull();
    expect(await lookup(ownerOfB, accountB, igA)).toBeNull();
    // A non-uuid never reaches SQL.
    expect(await lookup(agentA, accountA, "x' OR 1=1 --")).toBeNull();
  });
});
