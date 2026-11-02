import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import {
  createConversationNote,
  deleteConversationNote,
  listConversationNotes,
  updateConversationNote,
} from './notes';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), removedA = randomUUID();
const ownerB = randomUUID();
const users = [adminA, agentA, agent2A, viewerA, removedA, ownerB];
type Actor = Required<TenantContext>;
const asAdmin: Actor = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: Actor = { accountId: accountA, userId: agentA, role: 'agent' };
const asAgent2: Actor = { accountId: accountA, userId: agent2A, role: 'agent' };
const asViewer: Actor = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: Actor = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let conversationA = '';

const app = <T>(context: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(context, op);

async function mentionNotices(userId: string) {
  return (await owner.query(
    "SELECT user_id::text, link, dedupe_key, title FROM notifications WHERE account_id=$1 AND user_id=$2 AND type='mention'",
    [accountA, userId])).rows;
}

/** Everything a WhatsApp send would leave behind for this account. */
async function sendTraces() {
  const row = (await owner.query(
    `SELECT (SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.account_id=$1)::int AS messages,
            (SELECT count(*) FROM jobs WHERE tenant_id=$1)::int AS jobs,
            (SELECT count(*) FROM outbound_intents WHERE account_id=$1)::int AS intents`, [accountA])).rows[0];
  return row as { messages: number; jobs: number; intents: number };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('conversation notes on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Notes test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Notes A',$2),($3,'Notes B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES($1,'Asha Agent',$2,$3,'agent')",
      [agentA, `${agentA}@example.invalid`, accountA]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($1,$6,'agent'),($7,$8,'owner')`,
      [accountA, adminA, agentA, agent2A, viewerA, removedA, accountB, ownerB]);
    const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Ravi') RETURNING id", [accountA, adminA, `9196${seed}`])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, adminA, contact])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores a note, mentions only current members and notifies them without sending anything', async () => {
    await owner.query('DELETE FROM account_memberships WHERE account_id=$1 AND user_id=$2', [accountA, removedA]);
    const before = await sendTraces();
    const { note, notified } = await app(asAgent, (tx) => createConversationNote(tx, asAgent, conversationA, {
      body: 'Please call @Ravi back', mentions: [agent2A, removedA, ownerB, agentA],
    }));
    expect(note).toMatchObject({ author_id: agentA, body: 'Please call @Ravi back', edited_at: null });
    expect(new Set(note.mentions)).toEqual(new Set([agent2A, agentA]));
    expect(notified).toEqual([agent2A]);

    const notices = await mentionNotices(agent2A);
    expect(notices).toEqual([{ user_id: agent2A, link: `/inbox?c=${conversationA}`,
      dedupe_key: `note-mention:${note.id}`, title: 'Asha Agent mentioned you in a note' }]);
    // The author, removed members and other workspaces' members get nothing.
    expect(await mentionNotices(agentA)).toHaveLength(0);
    expect(await mentionNotices(removedA)).toHaveLength(0);
    expect((await owner.query("SELECT 1 FROM notifications WHERE user_id=$1 AND type='mention'", [ownerB])).rows).toHaveLength(0);

    // A note is internal: no message, job or outbound intent appears.
    expect(await sendTraces()).toEqual(before);
  });

  it('lets every member read, keeps other workspaces out, and refuses viewer writes', async () => {
    expect((await app(asViewer, (tx) => listConversationNotes(tx, accountA, conversationA))).length).toBeGreaterThan(0);
    await expect(app(asB, (tx) => listConversationNotes(tx, accountB, conversationA))).rejects.toMatchObject({ code: 'not_found' });
    expect(await app(asB, (tx) => tx.$queryRaw`SELECT 1 FROM conversation_notes`)).toHaveLength(0);
    await expect(app(asViewer, (tx) => createConversationNote(tx, asViewer, conversationA, { body: 'nope' }))).rejects.toThrow();
    // Another workspace cannot write into this conversation either.
    await expect(app(asB, (tx) => createConversationNote(tx, asB, conversationA, { body: 'nope' }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('emits a workspace-scoped note event for live panels that the realtime projection reduces to ids', async () => {
    const { note } = await app(asAgent, (tx) => createConversationNote(tx, asAgent, conversationA, { body: `Live ${seed}` }));
    const eventsFor = (context: TenantContext) => app(context, (tx) => tx.$queryRaw<{ account_id: string; recipient_user_id: string | null; payload: unknown }[]>`
      SELECT account_id::text, recipient_user_id::text, payload FROM outbox_events
      WHERE event_type='conversation_notes.INSERT' AND payload->'new'->>'id'=${note.id}`);
    const mine = await eventsFor(asViewer);
    expect(mine).toHaveLength(1);
    // Every member of the workspace (viewers included) may read notes, so the event has no single recipient.
    expect(mine[0]).toMatchObject({ account_id: accountA, recipient_user_id: null });
    expect(await eventsFor(asB)).toHaveLength(0);
    const { projectRealtimePayload } = await import('@/lib/realtime/projection');
    const projected = projectRealtimePayload(mine[0].payload) as { table: string; new: Record<string, unknown>; old: Record<string, unknown> };
    expect(projected.table).toBe('conversation_notes');
    expect(projected.new).toMatchObject({ id: note.id, conversation_id: conversationA });
    expect(projected.old).toEqual({});
    expect(JSON.stringify(projected)).not.toContain(`Live ${seed}`);
  });

  it('lets only the author edit, and notifies only newly mentioned members', async () => {
    const { note } = await app(asAgent, (tx) => createConversationNote(tx, asAgent, conversationA, { body: 'first', mentions: [agent2A] }));
    await expect(app(asAgent2, (tx) => updateConversationNote(tx, asAgent2, conversationA, note.id, { body: 'hijack' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(app(asAdmin, (tx) => updateConversationNote(tx, asAdmin, conversationA, note.id, { body: 'hijack' }))).rejects.toMatchObject({ code: 'forbidden' });
    // Even bypassing the module, the database refuses a non-author edit.
    await expect(app(asAdmin, (tx) => tx.$executeRaw`UPDATE conversation_notes SET body='hijack' WHERE id=${note.id}::uuid`)).rejects.toThrow();

    const agent2Before = (await mentionNotices(agent2A)).length;
    const { note: edited, notified } = await app(asAgent, (tx) => updateConversationNote(tx, asAgent, conversationA, note.id, {
      body: 'second', mentions: [agent2A, adminA],
    }));
    expect(edited.body).toBe('second');
    expect(edited.edited_at).not.toBeNull();
    expect(notified).toEqual([adminA]);
    expect(await mentionNotices(agent2A)).toHaveLength(agent2Before);
    expect(await mentionNotices(adminA)).toHaveLength(1);
  });

  it('soft-deletes for the author or an admin, hides the note and freezes it', async () => {
    const { note } = await app(asAgent, (tx) => createConversationNote(tx, asAgent, conversationA, { body: 'to delete' }));
    await expect(app(asAgent2, (tx) => deleteConversationNote(tx, asAgent2, conversationA, note.id))).rejects.toMatchObject({ code: 'forbidden' });
    await app(asAdmin, (tx) => deleteConversationNote(tx, asAdmin, conversationA, note.id));
    const listed = await app(asAgent, (tx) => listConversationNotes(tx, accountA, conversationA));
    expect(listed.map((n) => n.id)).not.toContain(note.id);
    await expect(app(asAgent, (tx) => updateConversationNote(tx, asAgent, conversationA, note.id, { body: 'back' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(app(asAgent, (tx) => tx.$executeRaw`UPDATE conversation_notes SET deleted_at=NULL WHERE id=${note.id}::uuid`)).resolves.toBe(0);
    await expect(app(asAgent, (tx) => tx.$executeRaw`DELETE FROM conversation_notes WHERE id=${note.id}::uuid`)).rejects.toThrow();

    const own = await app(asAgent2, (tx) => createConversationNote(tx, asAgent2, conversationA, { body: 'mine' }));
    await app(asAgent2, (tx) => deleteConversationNote(tx, asAgent2, conversationA, own.note.id));
  });
});
