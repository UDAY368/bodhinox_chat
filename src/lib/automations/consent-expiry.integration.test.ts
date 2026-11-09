// Real-database proof for audit finding 49: blocking a contact (an agent, on
// the app role under RLS) or a STOP opt-out (the worker) expires that
// contact's parked automation runs in the same statement, and nothing else:
// running rows, other contacts and other workspaces are left alone.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), owner = randomUUID(), agent = randomUUID();
const blocked = randomUUID(), stopped = randomUUID(), bystander = randomUUID(), foreign = randomUUID();
const automationA = randomUUID(), automationB = randomUUID();
const seed = String(Date.now()).slice(-6);
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

async function park(account: string, automation: string, contact: string, status: string, logId: string | null = null): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO automation_pending_executions(id,account_id,automation_id,user_id,contact_id,next_step_position,status,run_at,log_id)
    VALUES($1,$2,$3,$4,$5,1,$6,now() + interval '1 hour',$7)`, [id, account, automation, owner, contact, status, logId]);
  return id;
}
async function runLog(account: string, automation: string, contact: string): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO automation_logs(id,account_id,automation_id,user_id,contact_id,trigger_event,status)
    VALUES($1,$2,$3,$4,$5,'new_message_received','partial')`, [id, account, automation, owner, contact]);
  return id;
}
const logOf = async (id: string) => (await q('SELECT status,error_message FROM automation_logs WHERE id=$1', [id])).rows[0];
const statusOf = async (id: string) => (await q('SELECT status FROM automation_pending_executions WHERE id=$1', [id])).rows[0].status;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('automation waits expire on block and opt-out', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [owner, agent])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Consent','test-only-hash')", [id, `${id}@example.invalid`]);
    for (const [account, automation] of [[A, automationA], [B, automationB]]) {
      await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Consent expiry',$2)", [account, owner]);
      await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, owner]);
      await q(`INSERT INTO automations(id,account_id,user_id,name,trigger_type,trigger_config,is_active)
        VALUES($1,$2,$3,'Wait then send','new_message_received','{}',true)`, [automation, account, owner]);
    }
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent')", [A, agent]);
    let n = 0;
    for (const [id, account] of [[blocked, A], [stopped, A], [bystander, A], [foreign, B]])
      await q('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)', [id, account, owner, 'C', `1415${seed}${++n}0`]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, agent]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('expires the blocked contact\'s pending and reply waits, but not a running row or another contact', async () => {
    const log = await runLog(A, automationA, blocked);
    const waiting = await park(A, automationA, blocked, 'pending', log);
    const replying = await park(A, automationA, blocked, 'awaiting_reply');
    const running = await park(A, automationA, blocked, 'running');
    const other = await park(A, automationA, bystander, 'pending');
    await withTenant({ accountId: A, userId: agent, role: 'agent' }, (tx) =>
      tx.$executeRaw(Prisma.sql`UPDATE contacts SET blocked_at=now() WHERE account_id=${A}::uuid AND id=${blocked}::uuid`), getPrisma());
    expect([await statusOf(waiting), await statusOf(replying), await statusOf(running), await statusOf(other)])
      .toEqual(['expired', 'expired', 'running', 'pending']);
    expect(await logOf(log)).toEqual({ status: 'partial', error_message: expect.stringMatching(/blocked/) });
  });

  it('expires the waits of a contact who sent STOP (worker), once, and leaves other workspaces alone', async () => {
    const log = await runLog(A, automationA, stopped);
    const waiting = await park(A, automationA, stopped, 'pending', log);
    const elsewhere = await park(B, automationB, foreign, 'pending');
    await withTenant({ accountId: A, role: 'owner' }, (tx) =>
      tx.$executeRaw(Prisma.sql`UPDATE contacts SET opted_out_at=now(), opt_out_source='keyword' WHERE account_id=${A}::uuid AND id=${stopped}::uuid`),
    getWorkerPrisma());
    expect(await statusOf(waiting)).toBe('expired');
    expect((await logOf(log)).error_message).toMatch(/opted out/);
    expect(await statusOf(elsewhere)).toBe('pending');
    // A later wait after re-consent is not touched by an unrelated update of an already-set flag.
    const later = await park(A, automationA, stopped, 'pending');
    await q('UPDATE contacts SET name=$2 WHERE id=$1', [stopped, 'Renamed']);
    await q('UPDATE contacts SET opted_out_at=opted_out_at WHERE id=$1', [stopped]);
    expect(await statusOf(later)).toBe('pending');
  });
});
