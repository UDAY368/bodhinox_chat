// Deal team notes on PostgreSQL:
// - an agent adds a note (author-stamped, audited with ids only) and lists them newest first;
// - only the author or an admin deletes a note (service check and RLS);
// - a viewer reads but cannot add (RLS);
// - another workspace never reads, adds to or deletes them; deleting the deal deletes its notes.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { addDealNote, DealNoteError, deleteDealNote, listDealNotes } from './deal-notes';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const dealA = randomUUID(), dealB = randomUUID();
let db: pg.Client;
const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const agent2 = { accountId: A, userId: agent2A, role: 'agent' as const };
const admin = { accountId: A, userId: ownerA, role: 'owner' as const };
const viewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
const other = { accountId: B, userId: ownerB, role: 'owner' as const };
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => (e instanceof DealNoteError ? e.code : 'error'));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('deal team notes', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [ownerA, agentA, agent2A, viewerA, ownerB])
      await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Notes','test-only-hash')", [id, `${id}@example.invalid`]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Notes A',$2),($3,'Notes B',$4)", [A, ownerA, B, ownerB]);
    await db.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'agent'),
      ($1,$5,'viewer'),($6,$7,'owner')`, [A, ownerA, agentA, agent2A, viewerA, B, ownerB]);
    for (const [account, user, deal] of [[A, ownerA, dealA], [B, ownerB, dealB]]) {
      const pipeline = (await db.query("INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'P') RETURNING id", [account, user])).rows[0].id;
      const stage = (await db.query("INSERT INTO pipeline_stages(account_id,pipeline_id,name) VALUES($1,$2,'S') RETURNING id", [account, pipeline])).rows[0].id;
      await db.query("INSERT INTO deals(id,account_id,user_id,pipeline_id,stage_id,title) VALUES($1,$2,$3,$4,$5,'Deal')", [deal, account, user, pipeline, stage]);
    }
  });
  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, agent2A, viewerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('an agent adds notes, newest first, author-stamped and audited with ids only', async () => {
    const first = await addDealNote(agent, dealA, '  Asked for a demo  ');
    const second = await addDealNote(agent, dealA, 'Sent the quote');
    expect(first).toMatchObject({ body: 'Asked for a demo', created_by: agentA, deal_id: dealA });
    const notes = await listDealNotes(viewer, dealA);
    expect(notes.map((n) => n.id)).toEqual([second.id, first.id]);
    const audit = (await db.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='deal.note_added' AND resource_id=$2", [A, first.id])).rows[0];
    expect(audit.metadata).toEqual({ deal_id: dealA });
  });

  it('refuses an empty or too long note', async () => {
    expect(await code(addDealNote(agent, dealA, '   '))).toBe('invalid');
    expect(await code(addDealNote(agent, dealA, 'x'.repeat(2001)))).toBe('invalid');
  });

  it('only the author or an admin deletes a note', async () => {
    const note = await addDealNote(agent, dealA, 'Mine');
    expect(await code(deleteDealNote(agent2, dealA, note.id))).toBe('forbidden');
    // RLS refuses it too, even without the service check.
    const removed = await withTenant(agent2, (tx) => tx.$executeRaw`DELETE FROM deal_notes WHERE id=${note.id}::uuid`);
    expect(removed).toBe(0);
    expect(await code(deleteDealNote(admin, dealA, note.id))).toBe('ok');
    const own = await addDealNote(agent2, dealA, 'Own');
    expect(await code(deleteDealNote(agent2, dealA, own.id))).toBe('ok');
  });

  it('a viewer cannot add a note', async () => {
    expect(await code(addDealNote(viewer, dealA, 'Viewer note'))).toBe('error');
  });

  it('another workspace never reads, adds to or deletes the notes', async () => {
    const note = await addDealNote(agent, dealA, 'Private');
    expect(await code(listDealNotes(other, dealA))).toBe('not_found');
    expect(await code(addDealNote(other, dealA, 'Intruder'))).toBe('not_found');
    expect(await code(deleteDealNote(other, dealA, note.id))).toBe('not_found');
    const leaked = await withTenant(other, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM deal_notes WHERE id=${note.id}::uuid`);
    expect(leaked[0].n).toBe(0);
    expect((await listDealNotes(other, dealB))).toEqual([]);
  });

  it('deleting the deal deletes its notes', async () => {
    await addDealNote(agent, dealA, 'Gone with the deal');
    await db.query('DELETE FROM deals WHERE id=$1', [dealA]);
    expect((await db.query('SELECT count(*)::int AS n FROM deal_notes WHERE deal_id=$1', [dealA])).rows[0].n).toBe(0);
  });
});
