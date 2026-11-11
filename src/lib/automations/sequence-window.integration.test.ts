/**
 * Stage 4C on PostgreSQL: an Instagram sequence stays inside the 24-hour window.
 * The real window rule (sender.ts) reads the customer's messages under the worker
 * role: a customer message reached after the window closed is dropped and logged
 * with window_closed (nothing is sent, no outbound intent exists, the steps after
 * it do not run); a step that does not message the customer still runs; one
 * workspace's conversation never opens another's window. Meta is never called.
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withJobScope } from '@/lib/jobs/scope';
import { runAutomationsForTrigger } from './engine';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let contactA = '', convA = '', convB = '', contactB = '';

async function sequence(steps: { type: string; config: Record<string, unknown> }[]): Promise<string> {
  const id = (await owner.query(`INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active,channel)
    VALUES($1,$2,'seq','new_message_received','{}',true,'instagram') RETURNING id`, [accountA, ownerA])).rows[0].id;
  for (const [position, step] of steps.entries()) {
    await owner.query('INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,$3,$4,$5)',
      [accountA, id, step.type, step.config, position]);
  }
  return id;
}

const customerMessageAt = (account: string, conversation: string, hoursAgo: number) => owner.query(
  `INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at)
   VALUES($1,$2,'customer','text','hi','delivered',now() - make_interval(hours => $3))`, [account, conversation, hoursAgo]);

const run = (conversationId: string) => withJobScope({ accountId: accountA, role: 'owner' }, () => runAutomationsForTrigger({
  accountId: accountA, channel: 'instagram', triggerType: 'new_message_received', contactId: contactA,
  context: { message_text: 'hi', conversation_id: conversationId },
}));
const logs = async () => (await owner.query('SELECT status,error_message,steps_executed FROM automation_logs WHERE account_id=$1', [accountA])).rows;
const intents = async () => (await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n as number;
const company = async () => (await owner.query('SELECT company FROM contacts WHERE account_id=$1 AND id=$2', [accountA, contactA])).rows[0].company as string | null;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram sequences and the 24-hour window on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name))
      throw new Error('Sequence window tests require an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Sequence window test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Sequence A',$2),($3,'Sequence B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const ig = async (account: string, user: string, tag: string) => (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id) VALUES($1,$2,$3,'enc-test-token',$4) RETURNING id`,
      [account, `95${tag === 'a' ? 1 : 2}${seed}`, `seq_${tag}`, user])).rows[0].id as string;
    const igA = await ig(accountA, ownerA, 'a'), igB = await ig(accountB, ownerB, 'b');
    contactA = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
      [accountA, ownerA, `+1429${seed.slice(-7)}`, 'Sequence contact'])).rows[0].id;
    contactB = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
      [accountB, ownerB, `+1439${seed.slice(-7)}`, 'Other workspace'])).rows[0].id;
    const conv = async (account: string, user: string, contact: string, igId: string) => (await owner.query(
      `INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id`,
      [account, user, contact, igId])).rows[0].id as string;
    convA = await conv(accountA, ownerA, contactA, igA);
    convB = await conv(accountB, ownerB, contactB, igB);
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM automation_logs WHERE account_id=$1', [accountA]);
    await owner.query('DELETE FROM automations WHERE account_id=$1', [accountA]);
    await owner.query('DELETE FROM messages WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
    await owner.query('DELETE FROM outbound_intents WHERE account_id=$1', [accountA]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id IN ($1,$2)', [accountA, accountB]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('drops a customer message past the window with window_closed and runs nothing after it', async () => {
    await customerMessageAt(accountA, convA, 30);
    await sequence([{ type: 'send_message', config: { text: 'too late' } }, { type: 'update_contact_field', config: { field: 'company', value: 'after' } }]);
    await run(convA);
    const [row] = await logs();
    expect(row).toMatchObject({ status: 'partial', error_message: 'window_closed' });
    expect(row.steps_executed).toEqual([expect.objectContaining({ step_type: 'send_message', status: 'skipped', detail: 'window_closed' })]);
    expect(await intents()).toBe(0);
    expect(await company()).toBeNull();
  });

  it('never opens the window for a conversation that has no customer message at all', async () => {
    await sequence([{ type: 'send_message', config: { text: 'cold' } }]);
    await run(convA);
    expect((await logs())[0]).toMatchObject({ status: 'partial', error_message: 'window_closed' });
    expect(await intents()).toBe(0);
  });

  it("does not count another workspace's recent message as an open window", async () => {
    await customerMessageAt(accountB, convB, 1);
    await sequence([{ type: 'send_message', config: { text: 'cold' } }]);
    await run(convA);
    expect((await logs())[0]).toMatchObject({ status: 'partial', error_message: 'window_closed' });
  });

  it('still runs a step that does not message the customer after the window closed', async () => {
    await customerMessageAt(accountA, convA, 30);
    await sequence([{ type: 'update_contact_field', config: { field: 'company', value: 'ran' } }]);
    await run(convA);
    const [row] = await logs();
    expect(row.status).toBe('success');
    expect(row.error_message).toBeNull();
    expect(await company()).toBe('ran');
  });
});
