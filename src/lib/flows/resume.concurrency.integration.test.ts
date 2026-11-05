import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withJobScope } from '@/lib/jobs/scope';
import { flowPaymentReference } from '@/lib/payments/links';
import { dispatchInboundToFlows, handleFlowTimer, resumePaymentLinkRun } from './engine';

// One waiting flow run woken by several things at once: the customer's reply, its timeout
// timer and a payment outcome. Exactly one may move it. No node here sends a message.
// Local Docker database only (scripts/test-db-local.cjs); no .env file is loaded.
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), user = randomUUID(), flow = randomUUID();
let owner: pg.Client;
let phone = 0;
const scope = <T>(fn: () => Promise<T>) => withJobScope({ accountId: account, role: 'owner' }, fn);

/** A contact, its conversation and an active run sitting on `node` at transition 1. */
async function waitingRun(node: string) {
  const contact = randomUUID(), conversation = randomUUID(), run = randomUUID();
  await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'R',$4)", [contact, account, user, `1415555${String(phone++).padStart(4, '0')}`]);
  await owner.query("INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,'open')", [conversation, account, user, contact]);
  await owner.query(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,transition_seq)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7,1)`, [run, account, flow, user, contact, conversation, node]);
  return { run, contact, conversation };
}
const runRow = async (id: string) => (await owner.query('SELECT status,end_reason,current_node_key,transition_seq FROM flow_runs WHERE id=$1', [id])).rows[0];
const events = async (id: string) => (await owner.query('SELECT event_type,node_key FROM flow_run_events WHERE flow_run_id=$1 ORDER BY created_at,id', [id])).rows as
  { event_type: string; node_key: string | null }[];
const count = (rows: { event_type: string }[], type: string) => rows.filter((e) => e.event_type === type).length;

describe.skipIf(!ownerUrl || !workerUrl)('[AUT-02] flow run resume under concurrency on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Resume concurrency','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Resume concurrency',$2)", [account, user]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, user]);
    await owner.query("INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,entry_node_id) VALUES($1,$2,$3,'Resume race','active','manual','start')", [flow, account, user]);
    await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
      ($1,$2,'start','start','{"next_node_key":"ask"}'),
      ($1,$2,'ask','collect_input','{"prompt_text":"Your name?","var_key":"name","next_node_key":"answered","timeout_minutes":5,"after_timeout":"timed_out"}'),
      ($1,$2,'answered','end','{}'),($1,$2,'timed_out','end','{}'),
      ($1,$2,'pay','payment_link','{"amount":"499","currency":"INR","message":"Pay here","paid_next":"paid","expired_next":"expired"}'),
      ($1,$2,'paid','end','{}'),($1,$2,'expired','end','{}')`, [account, flow]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('a reply and its timeout timer racing (two of each): one path wins, the run ends once', async () => {
    const { run, contact, conversation } = await waitingRun('ask');
    const timer = () => scope(() => handleFlowTimer({ accountId: account, runId: run, nodeKey: 'ask', seq: 1, kind: 'timeout' }));
    const reply = (text: string) => scope(() => dispatchInboundToFlows({
      accountId: account, userId: user, contactId: contact, conversationId: conversation, isFirstInboundMessage: false,
      message: { kind: 'text', text, meta_message_id: `wamid.${randomUUID()}` },
    }));
    await Promise.all([timer(), reply('Ana'), timer(), reply('Ana again')]);

    const after = await runRow(run);
    expect(after.status).toBe('completed');
    expect(['answered', 'timed_out']).toContain(after.current_node_key);
    const log = await events(run);
    // Either the timeout or an answer moved the run, never both, and it completed once.
    const timedOut = count(log, 'timeout');
    expect(timedOut).toBeLessThanOrEqual(1);
    expect(after.current_node_key === 'timed_out').toBe(timedOut === 1);
    expect(count(log, 'completed')).toBe(1);
    expect(after.transition_seq).toBe(2);
  });

  it('paid and expired outcomes arriving together (several deliveries each): one outcome wins, the run ends once', async () => {
    const { run } = await waitingRun('pay');
    const referenceId = flowPaymentReference(run, 'pay', 1);
    const wake = (outcome: 'paid' | 'expired') => scope(() => resumePaymentLinkRun({
      accountId: account, runId: run, nodeKey: 'pay', referenceId, outcome, status: outcome,
    }));
    const results = await Promise.all([wake('paid'), wake('expired'), wake('paid'), wake('expired'), wake('paid')]);

    expect(results).toContain('resumed');
    const after = await runRow(run);
    expect(after.status).toBe('completed');
    expect(['paid', 'expired']).toContain(after.current_node_key);
    const log = await events(run);
    expect(count(log, 'payment_received') + count(log, 'payment_expired')).toBe(1);
    expect(count(log, after.current_node_key === 'paid' ? 'payment_received' : 'payment_expired')).toBe(1);
    expect(count(log, 'completed')).toBe(1);
    expect(after.transition_seq).toBe(2);
  });

  it('a timer redelivered five times at once fires once', async () => {
    const { run } = await waitingRun('ask');
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      scope(() => handleFlowTimer({ accountId: account, runId: run, nodeKey: 'ask', seq: 1, kind: 'timeout' }))));
    const log = await events(run);
    expect(count(log, 'timeout')).toBe(1);
    expect(count(log, 'completed')).toBe(1);
    expect(results.filter((r) => r === 'fired').length).toBeGreaterThanOrEqual(1);
    expect(await runRow(run)).toMatchObject({ status: 'completed', current_node_key: 'timed_out', transition_seq: 2 });
  });
});
