// The shared deal actions on PostgreSQL: create skips a contact's second open deal in a pipeline
// (also when two runs race), a move goes to the newest open deal, marking it won sets closed_at
// through the deals trigger, a move to the same stage records no event, a run started by a deal's
// own move never moves it again, and another workspace's deals are never touched.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { createDeal, moveDealStage } from './deals';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), contactB = randomUUID();
const pipeA = randomUUID(), lead = randomUUID(), won = randomUUID(), pipeB = randomUUID(), stageB = randomUUID();
let db: pg.Client;

const deals = async (accountId: string, contactId: string) => (await db.query(
  'SELECT id::text, stage_id::text, status, closed_at FROM deals WHERE account_id=$1 AND contact_id=$2 ORDER BY created_at', [accountId, contactId])).rows;
const stageEvents = async (dealId: string) =>
  (await db.query("SELECT count(*)::int AS n FROM domain_events WHERE subject_id=$1 AND type='deal.stage_changed'", [dealId])).rows[0].n as number;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('deal actions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Deals', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Deals A',$2),($3,'Deals B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A','14155550601'),($4,$5,$6,'B','14155550602')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    await db.query('INSERT INTO pipelines(id,account_id,user_id,name) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', [pipeA, accountA, ownerA, 'Sales', pipeB, accountB, ownerB, 'B']);
    await db.query(`INSERT INTO pipeline_stages(id,account_id,pipeline_id,name,position) VALUES($1,$2,$3,'Lead',0),($4,$2,$3,'Won',1),($5,$6,$7,'B',0)`,
      [lead, accountA, pipeA, won, stageB, accountB, pipeB]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
    await db.end();
    await disconnectDatabases();
  });

  it('creates one open deal per contact and pipeline, even when two runs race', async () => {
    const input = { accountId: accountA, userId: ownerA, contactId: contactA, pipelineId: pipeA, stageId: lead, title: 'Order', value: 10 };
    const outcomes = await Promise.all([createDeal(input), createDeal(input)]);
    expect(outcomes.sort()).toEqual(['created', 'exists']);
    expect(await deals(accountA, contactA)).toHaveLength(1);
    // A stage of another pipeline (or workspace) is refused.
    expect(await createDeal({ ...input, contactId: null, stageId: stageB })).toBe('stage_invalid');
  });

  it('moves the open deal, records the move once, and a same-stage move is a no-op', async () => {
    const [deal] = await deals(accountA, contactA);
    const move = { accountId: accountA, contactId: contactA, pipelineId: pipeA, stageId: lead };
    expect(await moveDealStage(move)).toBe('unchanged');
    expect(await stageEvents(deal.id)).toBe(0);
    // A run started by this deal's own move never moves it (loop guard).
    expect(await moveDealStage({ ...move, stageId: won, startedByDealId: deal.id })).toBe('loop');
    expect(await stageEvents(deal.id)).toBe(0);
    expect(await moveDealStage({ ...move, stageId: won, status: 'won' })).toBe('moved');
    const [after] = await deals(accountA, contactA);
    expect(after).toMatchObject({ stage_id: won, status: 'won' });
    expect(after.closed_at).not.toBeNull();
    expect(await stageEvents(deal.id)).toBe(1);
    // Now closed: no open deal is left to move.
    expect(await moveDealStage(move)).toBe('no_deal');
  });

  it('never touches another workspace’s deal', async () => {
    await db.query("INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,title) VALUES($1,$2,$3,$4,$5,'B deal')",
      [accountB, ownerB, pipeB, stageB, contactB]);
    // Workspace A naming B's contact, pipeline and stage finds nothing of its own.
    expect(await moveDealStage({ accountId: accountA, contactId: contactB, pipelineId: pipeB, stageId: stageB, status: 'lost' })).toBe('stage_invalid');
    expect(await createDeal({ accountId: accountA, userId: ownerA, contactId: contactB, pipelineId: pipeB, stageId: stageB, title: 'x' })).toBe('stage_invalid');
    const [b] = await deals(accountB, contactB);
    expect(b.status).toBe('open');
  });
});
