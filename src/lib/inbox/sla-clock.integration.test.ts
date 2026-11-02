import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { notifySlaBreaches } from './sla';

// The first-response clock starts on a customer message, never on conversation
// creation (business-opened conversations have no customer waiting).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const asWorkerA: TenantContext = { accountId: accountA, role: 'owner' };
const asWorkerB: TenantContext = { accountId: accountB, role: 'owner' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const seed = String(Date.now()).slice(-8);
const SLA_MINUTES = 30;
let owner: pg.Client;
let phone = 0;

const worker = <T>(context: TenantContext, op: Parameters<typeof withTenant<T>>[1]) => withTenant(context, op, getWorkerPrisma());

async function newConversation(accountId: string, userId: string, extra = '', values: unknown[] = []) {
  const contact = (await owner.query('INSERT INTO contacts(account_id,user_id,phone) VALUES($1,$2,$3) RETURNING id',
    [accountId, userId, `9196${seed}${phone++}`])).rows[0].id;
  return (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id${extra ? `,${extra}` : ''})
    VALUES($1,$2,$3${values.map((_, i) => `,$${i + 4}`).join('')}) RETURNING id`, [accountId, userId, contact, ...values])).rows[0].id as string;
}

async function message(context: TenantContext, conversationId: string, senderType: 'customer' | 'bot') {
  await worker(context, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,content_text)
    VALUES(${conversationId}::uuid,${senderType},'x')`);
}

async function row(id: string) {
  return (await owner.query(`SELECT status, lifecycle_state, first_response_due_at, first_responded_at
    FROM conversations WHERE id=$1`, [id])).rows[0] as {
      status: string; lifecycle_state: string; first_response_due_at: Date | null; first_responded_at: Date | null;
    };
}

async function breachedIds(at: Date) {
  await worker(asWorkerA, (tx) => notifySlaBreaches(tx, accountA, at));
  return (await owner.query("SELECT DISTINCT conversation_id::text AS id FROM notifications WHERE account_id=$1 AND type='sla_breach'",
    [accountA])).rows.map((r: { id: string }) => r.id);
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('first-response SLA clock on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'SLA test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'SLA A',$2),($3,'SLA B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, adminA, agentA, accountB, ownerB]);
    // Only workspace A has an SLA.
    await owner.query('INSERT INTO workspace_inbox_settings(account_id,sla_first_response_minutes) VALUES($1,$2)', [accountA, SLA_MINUTES]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('does not start the clock for a business-opened conversation, and never alerts on it', async () => {
    const id = await newConversation(accountA, adminA);
    expect(await row(id)).toMatchObject({ lifecycle_state: 'requesting', first_response_due_at: null });
    await message(asWorkerA, id, 'bot'); // template / commerce / flow send
    expect((await row(id)).first_response_due_at).toBeNull();
    expect(await breachedIds(new Date(Date.now() + 2 * 3_600_000))).not.toContain(id);
  });

  it('starts the clock on the first customer message only, and the breach check then sees it', async () => {
    const id = await newConversation(accountA, adminA);
    await message(asWorkerA, id, 'bot');
    const before = Date.now();
    await message(asWorkerA, id, 'customer');
    const due = (await row(id)).first_response_due_at;
    expect(due).not.toBeNull();
    const offset = due!.getTime() - before;
    expect(offset).toBeGreaterThan((SLA_MINUTES - 1) * 60_000);
    expect(offset).toBeLessThan((SLA_MINUTES + 1) * 60_000);

    await message(asWorkerA, id, 'customer');
    expect((await row(id)).first_response_due_at).toEqual(due);
    expect(await breachedIds(new Date(due!.getTime() - 60_000))).not.toContain(id);
    expect(await breachedIds(new Date(due!.getTime() + 60_000))).toContain(id);
  });

  it('leaves the clock alone for bot-owned, closed, already-answered and SLA-less conversations', async () => {
    const botOwned = await newConversation(accountA, adminA, 'lifecycle_state', ['bot']);
    const closed = await newConversation(accountA, adminA, 'status', ['closed']);
    const answered = await newConversation(accountA, adminA);
    await withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO messages(conversation_id,sender_type,sender_id,content_text)
      VALUES(${answered}::uuid,'agent',${agentA}::uuid,'hello')`);
    const noSla = await newConversation(accountB, ownerB);
    for (const id of [botOwned, closed, answered]) await message(asWorkerA, id, 'customer');
    await message(asWorkerB, noSla, 'customer');

    expect(await row(botOwned)).toMatchObject({ lifecycle_state: 'bot', first_response_due_at: null });
    expect(await row(closed)).toMatchObject({ lifecycle_state: 'resolved', first_response_due_at: null });
    expect((await row(answered)).first_responded_at).not.toBeNull();
    expect((await row(answered)).first_response_due_at).toBeNull();
    expect((await row(noSla)).first_response_due_at).toBeNull();
  });

  it('keeps restarting the clock on updates (bot pause, reopen)', async () => {
    const id = await newConversation(accountA, adminA, 'lifecycle_state', ['bot']);
    await worker(asWorkerA, (tx) => tx.$executeRaw`UPDATE conversations SET bot_paused=true WHERE id=${id}::uuid`);
    expect(await row(id)).toMatchObject({ lifecycle_state: 'requesting' });
    expect((await row(id)).first_response_due_at).not.toBeNull();

    await worker(asWorkerA, (tx) => tx.$executeRaw`UPDATE conversations SET status='closed' WHERE id=${id}::uuid`);
    await worker(asWorkerA, (tx) => tx.$executeRaw`UPDATE conversations SET status='open' WHERE id=${id}::uuid`);
    expect((await row(id)).first_response_due_at).not.toBeNull();
  });
});
