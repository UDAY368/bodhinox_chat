import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { emitDomainEvent } from './emit';
import { listContactEvents } from './store';

// The event feed on PostgreSQL: the triggers record each business event once, in the
// transaction of the change, with its events.dispatch job; tenancy holds for reads and writes.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const asA: TenantContext = { accountId: accountA, userId: ownerA, role: 'owner' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const contactA = randomUUID(), contactB = randomUUID();
let db: pg.Client;

async function events(accountId: string, subjectId: string) {
  return (await db.query(`SELECT d.type, d.contact_id::text AS contact_id, d.data,
      (SELECT count(*)::int FROM jobs j WHERE j.dedupe_key='domain-event:' || d.id AND j.type='events.dispatch' AND j.tenant_id=d.account_id) AS jobs
    FROM domain_events d WHERE d.account_id=$1 AND d.subject_id=$2 ORDER BY d.occurred_at, d.type`, [accountId, subjectId])).rows as
    { type: string; contact_id: string | null; data: Record<string, unknown>; jobs: number }[];
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('event feed on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Feed', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Feed A',$2),($3,'Feed B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A','14155550401'),($4,$5,$6,'B','14155550402')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
    await db.end();
    await disconnectDatabases();
  });

  it('an order records created, paid, shipped and delivered once each, with one dispatch job per event', async () => {
    const orderId = randomUUID();
    await withTenant(asA, (tx) => tx.$executeRaw`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,status)
      VALUES(${orderId}::uuid,${accountA}::uuid,'manual',${contactA}::uuid,'INR',12500,'new')`);
    for (const status of ['paid', 'dispatched', 'fulfilled'])
      await withTenant(asA, (tx) => tx.$executeRaw`UPDATE orders SET status=${status} WHERE account_id=${accountA}::uuid AND id=${orderId}::uuid`,
        getWorkerPrisma());
    const rows = await events(accountA, orderId);
    expect(rows.map((r) => r.type).sort()).toEqual(['order.created', 'order.delivered', 'order.paid', 'order.shipped']);
    expect(rows.every((r) => r.contact_id === contactA && r.jobs === 1)).toBe(true);
    const created = rows.find((r) => r.type === 'order.created')!;
    expect(created.data).toMatchObject({ order_id: orderId, source: 'manual', total_minor: 12500, currency: 'INR' });
  });

  it('a rolled-back change records no event and no job', async () => {
    const orderId = randomUUID();
    await expect(withTenant(asA, async (tx) => {
      await tx.$executeRaw`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,status)
        VALUES(${orderId}::uuid,${accountA}::uuid,'manual',${contactA}::uuid,'INR',100,'new')`;
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await events(accountA, orderId)).toEqual([]);
  });

  it('a deal stage move records each move, with the stage name and no customer content', async () => {
    const pipelineId = randomUUID(), stage1 = randomUUID(), stage2 = randomUUID(), dealId = randomUUID();
    await withTenant(asA, async (tx) => {
      await tx.$executeRaw`INSERT INTO pipelines(id,user_id,name) VALUES(${pipelineId}::uuid,${ownerA}::uuid,'Sales')`;
      await tx.$executeRaw`INSERT INTO pipeline_stages(id,pipeline_id,name,position) VALUES(${stage1}::uuid,${pipelineId}::uuid,'Lead',0),(${stage2}::uuid,${pipelineId}::uuid,'Won',1)`;
      await tx.$executeRaw`INSERT INTO deals(id,user_id,pipeline_id,stage_id,contact_id,title,notes)
        VALUES(${dealId}::uuid,${ownerA}::uuid,${pipelineId}::uuid,${stage1}::uuid,${contactA}::uuid,'Deal','private note')`;
    });
    for (const stage of [stage2, stage1])
      await withTenant(asA, (tx) => tx.$executeRaw`UPDATE deals SET stage_id=${stage}::uuid WHERE account_id=${accountA}::uuid AND id=${dealId}::uuid`);
    const rows = await events(accountA, dealId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'deal.stage_changed', data: { from_stage_id: stage1, to_stage_id: stage2, stage_name: 'Won' } });
    expect(JSON.stringify(rows)).not.toContain('private note');
  });

  it('emitDomainEvent records a dedupe key once and queues one job', async () => {
    const subject = randomUUID();
    const input = { accountId: accountA, type: 'cart.abandoned' as const, subject: { kind: 'cart' as const, id: subject },
      contactId: contactA, data: { session_id: subject, item_count: 2 }, dedupeKey: `cart:${subject}:abandoned` };
    const first = await withTenant(asA, (tx) => emitDomainEvent(tx, input));
    const second = await withTenant(asA, (tx) => emitDomainEvent(tx, input));
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const rows = await events(accountA, subject);
    expect(rows).toHaveLength(1);
    expect(rows[0].jobs).toBe(1);
  });

  it('a workspace can neither write nor read another workspace’s events', async () => {
    const subject = randomUUID();
    await expect(withTenant(asB, (tx) => emitDomainEvent(tx, { accountId: accountA, type: 'cart.abandoned',
      subject: { kind: 'cart', id: subject }, data: {} }))).rejects.toThrow();
    const fromB = await withTenant(asB, (tx) => listContactEvents(tx, accountA, contactA, null));
    expect(fromB.events).toEqual([]);
    const fromA = await withTenant(asA, (tx) => listContactEvents(tx, accountA, contactA, null, 2));
    expect(fromA.events.length).toBe(2);
    expect(fromA.nextCursor).not.toBeNull();
    const ownB = await withTenant(asB, (tx) => listContactEvents(tx, accountB, contactB, null));
    expect(ownB.events).toEqual([]);
  });

  it('the app role cannot delete events', async () => {
    const deleted = await withTenant(asA, (tx) => tx.$executeRaw`DELETE FROM domain_events WHERE account_id=${accountA}::uuid`)
      .catch(() => -1);
    expect(deleted === -1 || deleted === 0).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM domain_events WHERE account_id=$1', [accountA])).rows[0].n).toBeGreaterThan(0);
  });
});
