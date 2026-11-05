import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { claimOnAgentReply } from './lifecycle';
import { runSlaCheck } from './sla';

// Concurrent inbox actions on one conversation: claim on reply, resolve, reply and the
// SLA sweep. Local Docker database only (scripts/test-db-local.cjs); no .env file is loaded.
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), adminId = randomUUID();
const agents = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const asWorker: TenantContext = { accountId, role: 'owner' };
const asAgent = (userId: string): TenantContext => ({ accountId, userId, role: 'agent' });
const seed = String(Date.now()).slice(-7);
let owner: pg.Client;
let phone = 0;

async function waitingConversation() {
  const contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id',
    [accountId, adminId, `9197${seed}${phone++}`])).rows[0].id;
  const id = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id::text',
    [accountId, adminId, contact])).rows[0].id as string;
  // A customer message starts the first-response clock.
  await withTenant(asWorker, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,content_text)
    VALUES(${id}::uuid,'customer','hello')`, getWorkerPrisma());
  return id;
}
const agentReply = (userId: string, conversationId: string) => withTenant(asAgent(userId), (tx) => tx.$executeRaw`
  INSERT INTO messages(conversation_id,sender_type,sender_id,content_text) VALUES(${conversationId}::uuid,'agent',${userId}::uuid,'on it')`);
const row = async (id: string) => (await owner.query(`SELECT status, lifecycle_state, assigned_agent_id::text AS assigned_agent_id,
  first_response_due_at, first_responded_at, reopened_count FROM conversations WHERE id=$1`, [id])).rows[0];
const breachNotifications = async (id: string) => (await owner.query(
  "SELECT user_id::text AS user_id, dedupe_key FROM notifications WHERE account_id=$1 AND type='sla_breach' AND conversation_id=$2 ORDER BY user_id", [accountId, id])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('[INB-01] inbox assignment and SLA under concurrency on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'SLA concurrency', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminId, ...agents]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'SLA concurrency',$2)", [accountId, adminId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) SELECT $1, x, CASE WHEN x=$2 THEN 'admin' ELSE 'agent' END FROM unnest($3::uuid[]) x",
      [accountId, adminId, [adminId, ...agents]]);
    await owner.query('INSERT INTO workspace_inbox_settings(account_id,sla_first_response_minutes) VALUES($1,30)', [accountId]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountId]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminId, ...agents]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('five agents replying at once: exactly one claims the conversation, and the clock stops once', async () => {
    const id = await waitingConversation();
    expect((await row(id)).first_response_due_at).not.toBeNull();
    await Promise.all(agents.map((agent) => agentReply(agent, id)));
    const claims = await Promise.all(agents.map((agent) => claimOnAgentReply(asAgent(agent), id)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const after = await row(id);
    expect(after.assigned_agent_id).toBe(agents[claims.indexOf(true)]);
    // The first reply stops the clock (first_responded_at); the due time stays as the record of the target.
    expect(after.first_responded_at).not.toBeNull();
    // A sweep later finds nothing to alert on.
    await runSlaCheck(accountId, new Date(Date.now() + 2 * 3_600_000));
    expect(await breachNotifications(id)).toEqual([]);
  });

  it('five overlapping SLA sweeps notify each member once per breach', async () => {
    const id = await waitingConversation();
    await owner.query('UPDATE conversations SET assigned_agent_id=$2 WHERE id=$1', [id, agents[0]]);
    const late = new Date(Date.now() + 2 * 3_600_000);
    await Promise.all(Array.from({ length: 5 }, () => runSlaCheck(accountId, late)));
    const rows = await breachNotifications(id);
    expect(rows.map((r) => r.user_id).sort()).toEqual([adminId, agents[0]].sort());
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(1);
  });

  it('a resolve, a customer message, a reply and a sweep racing each other leave one consistent clock', async () => {
    const id = await waitingConversation();
    const late = new Date(Date.now() + 2 * 3_600_000);
    await Promise.all([
      withTenant(asWorker, (tx) => tx.$executeRaw`UPDATE conversations SET status='closed' WHERE id=${id}::uuid`, getWorkerPrisma()),
      withTenant(asWorker, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,content_text)
        VALUES(${id}::uuid,'customer','are you there?')`, getWorkerPrisma()),
      agentReply(agents[1], id),
      claimOnAgentReply(asAgent(agents[2]), id),
      runSlaCheck(accountId, late),
    ]);
    const after = await row(id);
    // Whatever the order, a closed conversation is resolved. The due time is a column on the
    // conversation, so there is never a second timer.
    if (after.status === 'closed') expect(after.lifecycle_state).toBe('resolved');
    // Open again (a customer message after the close starts a new cycle): the customer is either
    // answered in this cycle or waiting on exactly one due time.
    else expect(after.first_responded_at ?? after.first_response_due_at).not.toBeNull();
    // Breach alerts never repeat within one cycle, however the race went.
    await Promise.all([runSlaCheck(accountId, late), runSlaCheck(accountId, late)]);
    const keys = (await breachNotifications(id)).map((r) => `${r.user_id}:${r.dedupe_key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
