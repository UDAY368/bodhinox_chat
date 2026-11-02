import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withJobScope } from '@/lib/jobs/scope';
import { enqueueJob } from '@/lib/jobs/queue';
import { handleFlowTimer } from './engine';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), user = randomUUID(), flow = randomUUID(), contact = randomUUID(), conversation = randomUUID(), run = randomUUID();
let owner: pg.Client;

describe.skipIf(!ownerUrl || !workerUrl)('flow timers on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Timer test','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Timers',$2)", [account, user]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'T','14155550142')", [contact, account, user]);
    await owner.query("INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,'open')", [conversation, account, user, contact]);
    await owner.query("INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,entry_node_id) VALUES($1,$2,$3,'Timer','active','manual','start')", [flow, account, user]);
    // The new node kinds pass the widened CHECK; the run waits on a delayed end node.
    await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
      ($1,$2,'start','start','{"next_node_key":"done"}'),($1,$2,'where','ask_location','{}'),($1,$2,'set','set_attribute','{}'),
      ($1,$2,'tpl','send_template','{}'),($1,$2,'api','api_request','{}'),($1,$2,'go','connect_flow','{}'),($1,$2,'assign','assign_agent','{}'),
      ($1,$2,'done','end','{"delay_seconds":60}')`, [account, flow]);
    await owner.query(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,transition_seq,delay_until)
      VALUES($1,$2,$3,$4,$5,$6,'active','done',1,now())`, [run, account, flow, user, contact, conversation]);
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

  it('queues one job per timer however often it is scheduled', async () => {
    const key = `flow-timer:${run}:1:delay:done`;
    const runAt = new Date(Date.now() + 60_000);
    await enqueueJob('flow.timer', { runId: run, nodeKey: 'done', seq: 1, kind: 'delay' }, { tenantId: account, runAt, dedupeKey: key });
    await enqueueJob('flow.timer', { runId: run, nodeKey: 'done', seq: 1, kind: 'delay' }, { tenantId: account, runAt: new Date(), dedupeKey: key });
    const rows = (await owner.query('SELECT run_at FROM jobs WHERE dedupe_key=$1', [key])).rows;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].run_at).getTime()).toBe(runAt.getTime());
  });

  it('runs a due delay once; a redelivered job finds the run moved on', async () => {
    const fire = () => withJobScope({ accountId: account, role: 'owner' }, () =>
      handleFlowTimer({ accountId: account, runId: run, nodeKey: 'done', seq: 1, kind: 'delay' }));
    expect(await fire()).toBe('fired');
    const after = (await owner.query('SELECT status,end_reason,transition_seq,delay_until FROM flow_runs WHERE id=$1', [run])).rows[0];
    expect(after).toMatchObject({ status: 'completed', end_reason: 'end_node', transition_seq: 2, delay_until: null });
    expect(await fire()).toBe('stale');
    const events = (await owner.query("SELECT event_type FROM flow_run_events WHERE flow_run_id=$1 AND event_type='completed'", [run])).rows;
    expect(events).toHaveLength(1);
  });
});
