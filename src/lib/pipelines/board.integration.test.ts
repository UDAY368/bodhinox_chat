// The Sales board on PostgreSQL:
// - the first page per stage holds at most 25 open deals, newest first; "Load more" pages the rest;
// - won and lost deals load only in their own view, also paged;
// - stage counts and totals come from SQL, per currency, without closed deals;
// - closed_at is set when a deal becomes won or lost, kept while closed, cleared on reopen;
//   a stage move alone leaves it alone; lost_reason is kept only while lost and capped at 200;
// - getDeal (the ?deal= link) returns 404 for another workspace's deal; viewers read but never write.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { BoardError, getDeal, loadBoard, loadStageDeals } from './board';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
let db: pg.Client;
let pipelineA = '', stage1 = '', stage2 = '', pipelineB = '', dealB = '';
const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const viewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
const other = { accountId: B, userId: ownerB, role: 'owner' as const };
const open = { view: 'open' as const, owner: 'all', q: '' };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof BoardError ? e.code : 'error'));

async function insertDeal(stage: string, fields: { title: string; value?: number; currency?: string; status?: string; created?: string }) {
  const { rows } = await db.query(
    `INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,title,value,currency,status,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::timestamptz, now())) RETURNING id`,
    [A, ownerA, pipelineA, stage, fields.title, fields.value ?? 0, fields.currency ?? 'USD', fields.status ?? 'open', fields.created ?? null]);
  return rows[0].id as string;
}
const row = async (id: string) => (await db.query('SELECT status, closed_at, lost_reason FROM deals WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('pipeline board', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, agentA, viewerA, ownerB])
      await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Board','test-only-hash')", [id, `${id}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Board A',$2),($3,'Board B',$4)", [A, ownerA, B, ownerB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [A, ownerA, agentA, viewerA, B, ownerB]);
    pipelineA = (await db.query("INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Sales') RETURNING id", [A, ownerA])).rows[0].id;
    stage1 = (await db.query("INSERT INTO pipeline_stages(account_id,pipeline_id,name,position) VALUES($1,$2,'New',0) RETURNING id", [A, pipelineA])).rows[0].id;
    stage2 = (await db.query("INSERT INTO pipeline_stages(account_id,pipeline_id,name,position) VALUES($1,$2,'Proposal',1) RETURNING id", [A, pipelineA])).rows[0].id;
    pipelineB = (await db.query("INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Other') RETURNING id", [B, ownerB])).rows[0].id;
    const stageB = (await db.query("INSERT INTO pipeline_stages(account_id,pipeline_id,name) VALUES($1,$2,'S') RETURNING id", [B, pipelineB])).rows[0].id;
    dealB = (await db.query("INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,title) VALUES($1,$2,$3,$4,'Theirs') RETURNING id",
      [B, ownerB, pipelineB, stageB])).rows[0].id;
    // Stage 1: 30 open USD deals (value 10 each, newest is #29) and 2 INR deals; 3 won and 2 lost deals.
    for (let i = 0; i < 30; i++)
      await insertDeal(stage1, { title: `Open ${i}`, value: 10, created: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    await insertDeal(stage1, { title: 'Rupee 1', value: 500, currency: 'INR' });
    await insertDeal(stage1, { title: 'Rupee 2', value: 250, currency: 'INR' });
    for (let i = 0; i < 3; i++) await insertDeal(stage1, { title: `Won ${i}`, value: 1000, status: 'won' });
    for (let i = 0; i < 2; i++) await insertDeal(stage2, { title: `Lost ${i}`, value: 999, status: 'lost' });
    await insertDeal(stage2, { title: 'Proposal open', value: 7, currency: 'EUR' });
  });
  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('loads the first 25 open deals per stage, newest first, and pages the rest', async () => {
    const board = await loadBoard(viewer, pipelineA, open);
    const first = board.deals.filter((d) => d.stage_id === stage1);
    expect(first).toHaveLength(25);
    expect(() => JSON.stringify(board)).not.toThrow();
    expect(first[0]).not.toHaveProperty('rn');
    expect(first.every((d) => d.status === 'open')).toBe(true);
    expect(board.deals.filter((d) => d.stage_id === stage2).map((d) => d.title)).toEqual(['Proposal open']);
    const more = await loadStageDeals(viewer, pipelineA, stage1, open, 25);
    expect(more.deals).toHaveLength(7);
    expect(more.hasMore).toBe(false);
    const all = [...first, ...more.deals].map((d) => d.id);
    expect(new Set(all).size).toBe(32);
    expect(more.deals.at(-1)?.title).toBe('Open 0');
    expect((await loadStageDeals(viewer, pipelineA, stage1, open, 0)).hasMore).toBe(true);
  });

  it('loads won and lost deals only in their own view', async () => {
    const won = await loadBoard(viewer, pipelineA, { ...open, view: 'won' });
    expect(won.deals.map((d) => d.status)).toEqual(['won', 'won', 'won']);
    const lost = await loadStageDeals(viewer, pipelineA, stage2, { ...open, view: 'lost' }, 0);
    expect(lost.deals).toHaveLength(2);
    expect(lost.deals.every((d) => d.status === 'lost')).toBe(true);
  });

  it('totals each stage per currency without closed deals', async () => {
    const board = await loadBoard(viewer, pipelineA, open);
    const s1 = board.stages.find((s) => s.stage_id === stage1)!;
    expect(s1.count).toBe(32);
    expect(s1.totals).toEqual([
      { currency: 'INR', count: 2, total: 750 },
      { currency: 'USD', count: 30, total: 300 },
    ]);
    const s2 = board.stages.find((s) => s.stage_id === stage2)!;
    expect(s2.totals).toEqual([{ currency: 'EUR', count: 1, total: 7 }]);
    const wonRows = board.overview.filter((r) => r.status === 'won');
    expect(wonRows).toEqual([expect.objectContaining({ currency: 'USD', count: 3, total: 3000 })]);
  });

  it('filters by owner and search in SQL', async () => {
    const board = await loadBoard(viewer, pipelineA, { ...open, q: 'rupee' });
    expect(board.deals.map((d) => d.title).sort()).toEqual(['Rupee 1', 'Rupee 2']);
    expect(board.stages).toEqual([{ stage_id: stage1, count: 2, totals: [{ currency: 'INR', count: 2, total: 750 }] }]);
    expect((await loadBoard(viewer, pipelineA, { ...open, q: '100%_' })).deals).toEqual([]);
    expect((await loadBoard(viewer, pipelineA, { ...open, owner: agentA })).deals).toEqual([]);
  });

  it('sets closed_at on won or lost, keeps it while closed, clears it on reopen; a stage move leaves it alone', async () => {
    const id = await insertDeal(stage1, { title: 'Lifecycle' });
    expect((await row(id)).closed_at).toBeNull();
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET stage_id=${stage2}::uuid WHERE id=${id}::uuid`);
    expect((await row(id)).closed_at).toBeNull();
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET status='won' WHERE id=${id}::uuid`);
    const closed = (await row(id)).closed_at as Date;
    expect(closed).toBeInstanceOf(Date);
    // A later edit, or a writer trying to set closed_at itself, keeps the database's value.
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET stage_id=${stage1}::uuid, closed_at='2001-01-01' WHERE id=${id}::uuid`);
    expect((await row(id)).closed_at).toEqual(closed);
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET status='open' WHERE id=${id}::uuid`);
    expect((await row(id)).closed_at).toBeNull();
    const created = await insertDeal(stage1, { title: 'Born won', status: 'won' });
    expect((await row(created)).closed_at).toBeInstanceOf(Date);
  });

  it('keeps lost_reason only while lost, trimmed and at most 200 characters', async () => {
    const id = await insertDeal(stage1, { title: 'Reasoned' });
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET status='lost', lost_reason='  Too expensive  ' WHERE id=${id}::uuid`);
    expect(await row(id)).toMatchObject({ status: 'lost', lost_reason: 'Too expensive' });
    expect((await getDeal(viewer, id)).lost_reason).toBe('Too expensive');
    await expect(withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET lost_reason=${'x'.repeat(201)} WHERE id=${id}::uuid`)).rejects.toThrow();
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET status='open' WHERE id=${id}::uuid`);
    expect(await row(id)).toMatchObject({ status: 'open', lost_reason: null, closed_at: null });
    await withTenant(agent, (tx) => tx.$executeRaw`UPDATE deals SET lost_reason='ignored' WHERE id=${id}::uuid`);
    expect((await row(id)).lost_reason).toBeNull();
  });

  it('getDeal returns a deal of this workspace and 404 for another workspace', async () => {
    const [mine] = (await loadBoard(viewer, pipelineA, open)).deals;
    expect((await getDeal(viewer, mine.id)).id).toBe(mine.id);
    expect(await code(getDeal(viewer, dealB))).toBe('not_found');
    expect(await code(getDeal(other, mine.id))).toBe('not_found');
    expect(await code(getDeal(viewer, 'not-a-uuid'))).toBe('not_found');
  });

  it('another workspace cannot read this pipeline board or its pages', async () => {
    expect(await code(loadBoard(other, pipelineA, open))).toBe('not_found');
    expect(await code(loadStageDeals(other, pipelineA, stage1, open, 0))).toBe('not_found');
    expect(await code(loadBoard(viewer, pipelineB, open))).toBe('not_found');
  });

  it('a viewer reads the board but cannot change a deal status', async () => {
    const id = await insertDeal(stage1, { title: 'Viewer target' });
    const changed = await withTenant(viewer, (tx) => tx.$executeRaw`UPDATE deals SET status='lost', lost_reason='no' WHERE id=${id}::uuid`).catch(() => 0);
    expect(changed).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'open', closed_at: null, lost_reason: null });
  });

  it('masks contact numbers for a masked member and matches them only by their last digits', async () => {
    const contact = (await db.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'Masked Buyer','+919876543210') RETURNING id",
      [A, ownerA])).rows[0].id as string;
    const { rows } = await db.query(
      "INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,title,contact_id) VALUES($1,$2,$3,$4,'Masked deal',$5) RETURNING id",
      [A, ownerA, pipelineA, stage2, contact]);
    const dealId = rows[0].id as string;
    expect((await getDeal(viewer, dealId)).contact?.phone).toBe('+919876543210');
    await db.query('UPDATE account_memberships SET mask_phone_numbers=true WHERE account_id=$1 AND user_id=$2', [A, viewerA]);
    try {
      const seen = await getDeal(viewer, dealId);
      expect(seen.contact?.phone).not.toContain('98765');
      const board = await loadBoard(viewer, pipelineA, { ...open, q: '3210' });
      expect(board.deals.find((d) => d.id === dealId)?.contact?.phone).not.toContain('98765');
      // A masked member cannot find the contact by the hidden middle digits.
      expect((await loadBoard(viewer, pipelineA, { ...open, q: '98765' })).deals.map((d) => d.id)).not.toContain(dealId);
      // Owners are never masked.
      expect((await getDeal({ accountId: A, userId: ownerA, role: 'owner' }, dealId)).contact?.phone).toBe('+919876543210');
    } finally {
      await db.query('UPDATE account_memberships SET mask_phone_numbers=false WHERE account_id=$1 AND user_id=$2', [A, viewerA]);
    }
  });
});
