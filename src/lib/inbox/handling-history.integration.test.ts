// Who handled which chat (team management, group 1) on PostgreSQL:
// - Every assignment change, resolve and reopen is logged by the database with
//   the acting member, or none when automatic; direct writes to the log or to
//   resolved_by are refused or ignored.
// - The history and "Handled by" lookups stay inside the workspace and follow
//   agent visibility (assigned_or_team).
// - Removing a member (the auth role deletes the membership) unassigns their
//   chats through the existing foreign key, and the history and resolved_by
//   still credit them, shown as a former member.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { ConversationNotFoundError, conversationHandlingHistory, conversationsHandledBy } from './handling-history';
import { conversationsWithFailedLastOutbound } from './failed-outbound';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
const authUrl = process.env.TEST_AUTH_DATABASE_URL || configured?.AUTH_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const admin = randomUUID(), priya = randomUUID(), ravi = randomUUID(), other = randomUUID();
const seed = String(Date.now()).slice(-6);
let db: pg.Client;
let n = 0;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const as = (userId: string, role: 'owner' | 'admin' | 'agent' | 'viewer', account = A) => ({ accountId: account, userId, role });

async function conversation(account = A, user = admin): Promise<string> {
  const contact = (await q("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Customer') RETURNING id",
    [account, user, `1419${seed}${++n}0`])).rows[0].id;
  return (await q('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [account, user, contact])).rows[0].id;
}
/** An update as a signed-in member through the app role, like the inbox's own write. */
const update = (who: ReturnType<typeof as>, id: string, set: string, values: unknown[] = []) =>
  withTenant(who, (tx) => tx.$executeRawUnsafe(`UPDATE conversations SET ${set} WHERE account_id=$1::uuid AND id=$2::uuid`, who.accountId, id, ...values), getPrisma());
const events = async (id: string) => (await q(
  `SELECT kind, from_user_id::text AS "from", to_user_id::text AS "to", actor_user_id::text AS actor
   FROM conversation_handling_events WHERE conversation_id=$1 ORDER BY created_at, id`, [id])).rows;
const visibility = (value: 'all' | 'assigned_or_team') => q(
  `INSERT INTO workspace_inbox_settings(account_id,agent_visibility) VALUES($1,$2)
   ON CONFLICT (account_id) DO UPDATE SET agent_visibility=EXCLUDED.agent_visibility`, [A, value]);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl || !authUrl)('who handled which chat on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [admin, priya, ravi, other])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Member','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Handling A',$2),($3,'Handling B',$4)", [A, admin, B, other]);
    await q(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'agent'),($5,$6,'owner')`,
      [A, admin, priya, ravi, B, other]);
    await q(`INSERT INTO profiles(user_id,full_name,email,account_id,account_role) VALUES
      ($1,'Asha Admin','a@example.invalid',$5,'owner'),($2,'Priya','p@example.invalid',$5,'agent'),
      ($3,'Ravi','r@example.invalid',$5,'agent'),($4,'Other','o@example.invalid',$6,'owner')`, [admin, priya, ravi, other, A, B]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM profiles WHERE user_id = ANY($1::uuid[])', [[admin, priya, ravi, other]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, priya, ravi, other]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('logs assignments with who made them, and resolves and reopens with who did them', async () => {
    const c = await conversation();
    await update(as(admin, 'owner'), c, 'assigned_agent_id=$3::uuid', [priya]);
    await update(as(priya, 'agent'), c, 'assigned_agent_id=$3::uuid', [ravi]);
    await update(as(ravi, 'agent'), c, "status='closed'");
    expect((await q('SELECT resolved_by::text AS by FROM conversations WHERE id=$1', [c])).rows[0].by).toBe(ravi);
    await update(as(admin, 'owner'), c, "status='open'");
    expect((await q('SELECT resolved_by FROM conversations WHERE id=$1', [c])).rows[0].resolved_by).toBeNull();
    expect(await events(c)).toEqual([
      { kind: 'assigned', from: null, to: priya, actor: admin },
      { kind: 'assigned', from: priya, to: ravi, actor: priya },
      { kind: 'resolved', from: null, to: ravi, actor: ravi },
      { kind: 'reopened', from: null, to: ravi, actor: admin },
    ]);

    const history = await conversationHandlingHistory(as(priya, 'agent'), c);
    expect(history.map((e) => [e.kind, e.to?.name ?? null, e.actor?.name ?? null])).toEqual([
      ['reopened', 'Ravi', 'Asha Admin'], ['resolved', 'Ravi', 'Ravi'], ['assigned', 'Ravi', 'Priya'], ['assigned', 'Priya', 'Asha Admin'],
    ]);
  });

  it('records automatic changes (the worker, no member) without an actor', async () => {
    const c = await conversation();
    await withTenant({ accountId: A }, (tx) => tx.$executeRawUnsafe(
      'UPDATE conversations SET assigned_agent_id=$3::uuid WHERE account_id=$1::uuid AND id=$2::uuid', A, c, priya), getWorkerPrisma());
    expect(await events(c)).toEqual([{ kind: 'assigned', from: null, to: priya, actor: null }]);
  });

  it('ignores a direct write to resolved_by and refuses direct writes to the log', async () => {
    const c = await conversation();
    await update(as(priya, 'agent'), c, 'resolved_by=$3::uuid', [ravi]);
    expect((await q('SELECT resolved_by FROM conversations WHERE id=$1', [c])).rows[0].resolved_by).toBeNull();
    await expect(withTenant(as(admin, 'owner'), (tx) => tx.$executeRawUnsafe(
      `INSERT INTO conversation_handling_events(account_id,conversation_id,kind,to_user_id) VALUES($1::uuid,$2::uuid,'assigned',$3::uuid)`,
      A, c, priya), getPrisma())).rejects.toThrow(/permission denied/);
    const logged = (await q('SELECT id FROM conversation_handling_events WHERE account_id=$1 LIMIT 1', [A])).rows[0].id;
    await expect(withTenant(as(admin, 'owner'), (tx) => tx.$executeRawUnsafe(
      'DELETE FROM conversation_handling_events WHERE id=$1::uuid', logged), getPrisma())).rejects.toThrow(/permission denied/);
  });

  it('keeps history and "Handled by" inside the workspace and behind agent visibility', async () => {
    const c = await conversation();
    await update(as(admin, 'owner'), c, 'assigned_agent_id=$3::uuid', [ravi]);
    await expect(conversationHandlingHistory(as(other, 'owner', B), c)).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(await conversationsHandledBy(as(other, 'owner', B), ravi)).toEqual([]);

    await visibility('assigned_or_team');
    try {
      await expect(conversationHandlingHistory(as(priya, 'agent'), c)).rejects.toBeInstanceOf(ConversationNotFoundError);
      expect(await conversationsHandledBy(as(priya, 'agent'), ravi)).not.toContain(c);
      expect((await conversationHandlingHistory(as(ravi, 'agent'), c)).length).toBeGreaterThan(0);
    } finally {
      await visibility('all');
    }
  });

  it('"Handled by" finds chats assigned now or before, resolved, or with a message the member sent', async () => {
    const before = await conversation(), sent = await conversation(), untouched = await conversation();
    await update(as(admin, 'owner'), before, 'assigned_agent_id=$3::uuid', [priya]);
    await update(as(admin, 'owner'), before, 'assigned_agent_id=$3::uuid', [ravi]);
    await q(`INSERT INTO messages(account_id,conversation_id,sender_type,sender_id,content_type,content_text,status)
      VALUES($1,$2,'agent',$3,'text','Hello','sent')`, [A, sent, priya]);
    const ids = await conversationsHandledBy(as(admin, 'owner'), priya);
    expect(ids).toEqual(expect.arrayContaining([before, sent]));
    expect(ids).not.toContain(untouched);
    expect(await conversationsHandledBy(as(admin, 'owner'), 'not-a-uuid')).toEqual([]);
  });

  it('"Failed" lists chats whose latest team message failed, inside the workspace only', async () => {
    const failed = await conversation(), recovered = await conversation(), customerLast = await conversation();
    const say = (c: string, sender: string, status: string, at: string) => q(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
      VALUES($1,$2,$3,'text','x',$4,$5::timestamptz)`, [A, c, sender, status, at]);
    await say(failed, 'agent', 'sent', '2026-01-01T00:00:00Z');
    await say(failed, 'agent', 'failed', '2026-01-01T00:01:00Z');
    await say(recovered, 'agent', 'failed', '2026-01-01T00:00:00Z');
    await say(recovered, 'bot', 'sent', '2026-01-01T00:01:00Z');
    await say(customerLast, 'agent', 'failed', '2026-01-01T00:00:00Z');
    await say(customerLast, 'customer', 'read', '2026-01-01T00:01:00Z');
    await q('UPDATE conversations SET last_message_at=now() WHERE id = ANY($1::uuid[])', [[failed, recovered, customerLast]]);
    const ids = await conversationsWithFailedLastOutbound(as(admin, 'owner'));
    expect(ids).toEqual(expect.arrayContaining([failed, customerLast]));
    expect(ids).not.toContain(recovered);
    expect(await conversationsWithFailedLastOutbound(as(other, 'owner', B))).not.toContain(failed);
  });

  it('unassigns a removed member\'s chats, and still credits them in the history and resolved_by', async () => {
    const leaver = randomUUID();
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Leaver','test-only-hash')", [leaver, `${leaver}@example.invalid`]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent')", [A, leaver]);
    const open = await conversation(), closed = await conversation();
    await update(as(admin, 'owner'), open, 'assigned_agent_id=$3::uuid', [leaver]);
    await update(as(admin, 'owner'), closed, 'assigned_agent_id=$3::uuid', [leaver]);
    await update(as(leaver, 'agent'), closed, "status='closed'");

    const auth = new pg.Client({ connectionString: authUrl });
    await auth.connect();
    try {
      await auth.query('DELETE FROM account_memberships WHERE account_id=$1 AND user_id=$2', [A, leaver]);
    } finally {
      await auth.end();
    }
    const rows = (await q('SELECT id::text, assigned_agent_id::text AS agent, lifecycle_state FROM conversations WHERE id = ANY($1::uuid[])', [[open, closed]])).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    // conversations_assigned_agent_id_membership_fkey (ON DELETE SET NULL) unassigns both;
    // an open chat goes back to the queue.
    expect(byId[open]).toMatchObject({ agent: null, lifecycle_state: 'requesting' });
    expect(byId[closed].agent).toBeNull();
    expect((await events(open)).at(-1)).toEqual({ kind: 'unassigned', from: leaver, to: null, actor: null });
    // Who handled and resolved it survives, with the name hidden once they have left.
    expect((await q('SELECT resolved_by::text AS by FROM conversations WHERE id=$1', [closed])).rows[0].by).toBe(leaver);
    const history = await conversationHandlingHistory(as(admin, 'owner'), closed);
    expect(history.find((e) => e.kind === 'resolved')?.actor).toEqual({ id: leaver, name: null });
    expect(history.find((e) => e.kind === 'assigned')?.to).toEqual({ id: leaver, name: null });
    expect(await conversationsHandledBy(as(admin, 'owner'), leaver)).toEqual(expect.arrayContaining([open, closed]));
    await q('DELETE FROM auth_users WHERE id=$1', [leaver]).catch(() => undefined);
  });
});
