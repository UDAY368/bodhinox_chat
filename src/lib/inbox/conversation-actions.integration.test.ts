import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { ConversationActionError, exportConversation, setConversationUnread } from './conversation-actions';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), maskedA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, agentA, maskedA, ownerB];
type Actor = Required<TenantContext>;
const asOwner: Actor = { accountId: accountA, userId: ownerA, role: 'owner' };
const asAgent: Actor = { accountId: accountA, userId: agentA, role: 'agent' };
const asMasked: Actor = { accountId: accountA, userId: maskedA, role: 'agent' };
const asB: Actor = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let conversationA = '';

const unreadOf = async (id: string) =>
  (await owner.query('SELECT unread_count FROM conversations WHERE id=$1', [id])).rows[0].unread_count as number;

describe.skipIf(!ownerUrl || !appUrl)('conversation read state and export on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Actions test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Actions A',$2),($3,'Actions B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES
      ($1,$2,'owner',false),($1,$3,'agent',false),($1,$4,'agent',true),($5,$6,'owner',false)`,
      [accountA, ownerA, agentA, maskedA, accountB, ownerB]);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Ravi Kumar') RETURNING id",
      [accountA, ownerA, `9198${seed}`])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id,unread_count) VALUES($1,$2,$3,0) RETURNING id',
      [accountA, ownerA, contact])).rows[0].id;
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,created_at) VALUES
      ($1,$2,'customer','text','Call me on +91 98765 43210', now() - interval '2 minutes'),
      ($1,$2,'agent','text','=HYPERLINK("http://x")', now() - interval '1 minute')`, [accountA, conversationA]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('marks a conversation unread and read again', async () => {
    expect(await withTenant(asAgent, (tx) => setConversationUnread(tx, accountA, conversationA, true))).toBe(1);
    expect(await unreadOf(conversationA)).toBe(1);
    await owner.query('UPDATE conversations SET unread_count=4 WHERE id=$1', [conversationA]);
    // Marking unread never lowers a real count.
    expect(await withTenant(asAgent, (tx) => setConversationUnread(tx, accountA, conversationA, true))).toBe(4);
    expect(await withTenant(asAgent, (tx) => setConversationUnread(tx, accountA, conversationA, false))).toBe(0);
  });

  it('refuses another workspace and leaves its count alone', async () => {
    await owner.query('UPDATE conversations SET unread_count=2 WHERE id=$1', [conversationA]);
    await expect(withTenant(asB, (tx) => setConversationUnread(tx, accountB, conversationA, false)))
      .rejects.toBeInstanceOf(ConversationActionError);
    await expect(withTenant(asB, (tx) => setConversationUnread(tx, accountA, conversationA, false))).rejects.toThrow();
    await expect(withTenant(asB, (tx) => exportConversation(tx, asB, conversationA))).rejects.toBeInstanceOf(ConversationActionError);
    expect(await unreadOf(conversationA)).toBe(2);
  });

  it('exports the messages oldest first with formulas neutralised', async () => {
    const { csv, fileName } = await withTenant(asOwner, (tx) => exportConversation(tx, asOwner, conversationA));
    expect(fileName).toBe('ravi-kumar.csv');
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('Customer');
    expect(lines[1]).toContain('98765 43210');
    expect(lines[2]).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  it('masks phone numbers for a masked member', async () => {
    const { csv } = await withTenant(asMasked, (tx) => exportConversation(tx, asMasked, conversationA));
    expect(csv).not.toContain('98765 43210');
    expect(csv).toContain('•');
  });
});
