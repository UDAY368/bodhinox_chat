// Event triggers on PostgreSQL: an order written in a tenant transaction records a domain event
// and its events.dispatch job; the job fires a matching rule and starts a matching flow once,
// a second run of the same job fires nothing again (dispatchOnce), and another workspace's rules
// and flows never run for the event.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';

vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => undefined) }));

import { handleEventDispatchJob } from './dispatch';
import { withJobScope } from '@/lib/jobs/scope';

// As the worker runs it: inside the job's tenant scope.
const runJob = (accountId: string, eventId: string) =>
  withJobScope({ accountId, role: 'owner' }, () => handleEventDispatchJob(accountId, { eventId }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const asA: TenantContext = { accountId: accountA, userId: ownerA, role: 'owner' };
const contactA = randomUUID(), contactB = randomUUID();
const tagA = randomUUID(), tagB = randomUUID(), tagShopify = randomUUID();
let db: pg.Client;
let ruleA = '', ruleShopify = '', ruleB = '', flowA = '', flowB = '';

async function rule(accountId: string, userId: string, name: string, config: Record<string, unknown>, tagId: string): Promise<string> {
  const id = (await db.query(`INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active,channel)
    VALUES($1,$2,$3,'order_created',$4,true,'whatsapp') RETURNING id`, [accountId, userId, name, config])).rows[0].id as string;
  await db.query(`INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,'add_tag',$3,0)`,
    [accountId, id, { tag_id: tagId }]);
  return id;
}

async function liveFlow(accountId: string, userId: string, triggerConfig: Record<string, unknown>): Promise<string> {
  const id = (await db.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,channel_scope,entry_node_id)
    VALUES($1,$2,'Order thanks','order_created',$3,'whatsapp','start') RETURNING id`, [accountId, userId, triggerConfig])).rows[0].id as string;
  const nodes = [
    { node_key: 'start', node_type: 'start', config: { next_node_key: 'done' } },
    { node_key: 'done', node_type: 'end', config: {} },
  ];
  const version = (await db.query(`INSERT INTO flow_versions(account_id,flow_id,version,trigger_type,trigger_config,entry_node_id,fallback_policy,channel_scope,nodes,published_by)
    VALUES($1,$2,1,'order_created',$3,'start','{}'::jsonb,'whatsapp',$4,$5) RETURNING id`,
  [accountId, id, triggerConfig, JSON.stringify(nodes), userId])).rows[0].id as string;
  await db.query("UPDATE flows SET published_version_id=$1, status='active' WHERE id=$2", [version, id]);
  return id;
}

const logs = async (automationId: string) =>
  (await db.query('SELECT count(*)::int AS n FROM automation_logs WHERE automation_id=$1', [automationId])).rows[0].n as number;
const runs = async (flowId: string) =>
  (await db.query('SELECT vars FROM flow_runs WHERE flow_id=$1', [flowId])).rows as { vars: Record<string, unknown> }[];
const hasTag = async (contactId: string, tagId: string) =>
  (await db.query('SELECT 1 FROM contact_tags WHERE contact_id=$1 AND tag_id=$2', [contactId, tagId])).rowCount === 1;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('event triggers on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Triggers', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Triggers A',$2),($3,'Triggers B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A','14155550501'),($4,$5,$6,'B','14155550502')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    await db.query("INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3),($4,$5,$6)", [accountA, ownerA, contactA, accountB, ownerB, contactB]);
    await db.query('INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,$4),($5,$2,$3,$6),($7,$8,$9,$10)',
      [tagA, accountA, ownerA, 'ordered', tagShopify, 'shopify', tagB, accountB, ownerB, 'b-ordered']);
    ruleA = await rule(accountA, ownerA, 'Manual orders', { source: 'manual' }, tagA);
    ruleShopify = await rule(accountA, ownerA, 'Shopify orders', { source: 'shopify' }, tagShopify);
    ruleB = await rule(accountB, ownerB, 'Every order', {}, tagB);
    flowA = await liveFlow(accountA, ownerA, { source: 'manual' });
    flowB = await liveFlow(accountB, ownerB, {});
  });

  afterAll(async () => {
    await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
    await db.end();
    await disconnectDatabases();
  });

  it('an order fires the matching rule and flow once, however often its job runs', async () => {
    const orderId = randomUUID();
    await withTenant(asA, (tx) => tx.$executeRaw`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,status)
      VALUES(${orderId}::uuid,${accountA}::uuid,'manual',${contactA}::uuid,'INR',12500,'new')`, getWorkerPrisma());
    const event = (await db.query(`SELECT d.id::text AS id,
        (SELECT count(*)::int FROM jobs j WHERE j.type='events.dispatch' AND j.dedupe_key='domain-event:' || d.id AND j.tenant_id=d.account_id) AS jobs
      FROM domain_events d WHERE d.account_id=$1 AND d.subject_id=$2 AND d.type='order.created'`, [accountA, orderId])).rows;
    expect(event).toHaveLength(1);
    expect(event[0].jobs).toBe(1);

    await runJob(accountA, event[0].id);
    await runJob(accountA, event[0].id);

    expect(await logs(ruleA)).toBe(1);
    expect(await hasTag(contactA, tagA)).toBe(true);
    // The filter keeps a rule for another source quiet.
    expect(await logs(ruleShopify)).toBe(0);
    const started = await runs(flowA);
    expect(started).toHaveLength(1);
    expect(started[0].vars).toMatchObject({ event_order_id: orderId, event_source: 'manual' });
    // Each fan-out is recorded once under the event's id.
    const intents = (await db.query("SELECT idempotency_key AS key FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2 ORDER BY 1",
      [accountA, `${accountA}:domain-event:${event[0].id}:%`])).rows.map((r) => r.key);
    expect(intents).toEqual(expect.arrayContaining([`${accountA}:domain-event:${event[0].id}:flows`, `${accountA}:domain-event:${event[0].id}:rules`]));
  });

  it('another workspace never runs a rule or flow for the event, even when its job names that workspace', async () => {
    const orderId = randomUUID();
    await withTenant(asA, (tx) => tx.$executeRaw`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,status)
      VALUES(${orderId}::uuid,${accountA}::uuid,'manual',${contactA}::uuid,'INR',900,'new')`, getWorkerPrisma());
    const eventId = (await db.query("SELECT id::text AS id FROM domain_events WHERE account_id=$1 AND subject_id=$2 AND type='order.created'",
      [accountA, orderId])).rows[0].id as string;
    // A job carrying B's tenant cannot read A's event.
    await runJob(accountB, eventId);
    await runJob(accountA, eventId);
    expect(await logs(ruleB)).toBe(0);
    expect(await hasTag(contactB, tagB)).toBe(false);
    expect(await runs(flowB)).toHaveLength(0);
  });
});
