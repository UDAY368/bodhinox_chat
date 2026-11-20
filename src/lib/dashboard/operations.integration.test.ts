// The dashboard operations overview on PostgreSQL (batch 5): the waiting queue reads open chats
// only, through the per-conversation message indexes, and won/lost deals count by closed_at.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { loadDashboardOperations } from './operations';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const A = randomUUID(), B = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const waiting = randomUUID(), closed = randomUUID(), answered = randomUUID(), oldWaiting = randomUUID(), convB = randomUUID();
const pipeline = randomUUID(), stage = randomUUID();
const seed = `${Date.now()}`.slice(-7);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe.skipIf(!ownerUrl || !appUrl)('dashboard operations on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Ops', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ops A',$2),($3,'Ops B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [A, ownerA, B, ownerB]);
    const conversations: [string, string, string][] = [[waiting, A, 'open'], [closed, A, 'closed'], [answered, A, 'open'], [oldWaiting, A, 'pending'], [convB, B, 'open']];
    for (const [i, [id, account, status]] of conversations.entries()) {
      const contact = randomUUID();
      await q('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)',
        [contact, account, account === A ? ownerA : ownerB, `Ops ${i}`, `91${i}${seed}0`]);
      await q('INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,$5)', [id, account, account === A ? ownerA : ownerB, contact, status]);
    }
    const message = (account: string, conversation: string, sender: string, ago: string) => q(
      `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
       VALUES($1,$2,$3,'text','body',$4,now() - $5::interval)`, [account, conversation, sender, sender === 'customer' ? 'delivered' : 'sent', ago]);
    await message(A, waiting, 'customer', '23 hours'); // its 24-hour window closes within 2 hours
    await message(A, closed, 'customer', '1 hour'); // closed: never waiting
    await message(A, answered, 'customer', '2 hours');
    await message(A, answered, 'agent', '1 hour');
    await message(A, oldWaiting, 'agent', '61 days');
    await message(A, oldWaiting, 'customer', '60 days'); // still open, still waiting, however old
    await message(B, convB, 'customer', '1 hour');
    await q("INSERT INTO pipelines(id,account_id,user_id,name) VALUES($1,$2,$3,'Sales')", [pipeline, A, ownerA]);
    await q("INSERT INTO pipeline_stages(id,account_id,pipeline_id,name) VALUES($1,$2,$3,'New')", [stage, A, pipeline]);
    const deal = async (status: string) => (await q(
      'INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,title,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [A, ownerA, pipeline, stage, `Deal ${status}`, status])).rows[0].id as string;
    await deal('won');
    await deal('lost');
    const wonLongAgo = await deal('won');
    // Closed 40 days ago, edited today: the old updated_at filter counted it, closed_at does not.
    // The deals trigger owns closed_at, so the backdate bypasses it for this one owner statement.
    await q('BEGIN');
    await q("SET LOCAL session_replication_role = 'replica'");
    await q("UPDATE deals SET closed_at=now()-interval '40 days', created_at=now()-interval '50 days', updated_at=now() WHERE id=$1", [wonLongAgo]);
    await q('COMMIT');
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('lists only open chats still waiting for a reply, oldest first, never another workspace', async () => {
    const overview = await loadDashboardOperations({ accountId: A, userId: ownerA, role: 'owner' }, 7);
    expect(overview.attention.waiting).toBe(2);
    expect(overview.queue.map((row) => row.id)).toEqual([oldWaiting, waiting]);
    expect(overview.attention.expiring).toBe(1);
    expect(overview.attention.unassigned).toBe(2); // status 'open' and unassigned: waiting, answered
    const other = await loadDashboardOperations({ accountId: B, userId: ownerB, role: 'owner' }, 7);
    expect(other.queue.map((row) => row.id)).toEqual([convB]);
  });

  it('counts won and lost deals by when they closed, not when they were last edited', async () => {
    const week = await loadDashboardOperations({ accountId: A, userId: ownerA, role: 'owner' }, 7);
    expect(week.pipelines).toEqual([expect.objectContaining({ id: pipeline, won: 1, lost: 1 })]);
    const quarter = await loadDashboardOperations({ accountId: A, userId: ownerA, role: 'owner' }, 90);
    expect(quarter.pipelines).toEqual([expect.objectContaining({ id: pipeline, won: 2, lost: 1 })]);
    expect(Number(quarter.pipelines[0].avgDaysToWin)).toBeGreaterThan(4); // (0 + 10 days) / 2
  });
});
