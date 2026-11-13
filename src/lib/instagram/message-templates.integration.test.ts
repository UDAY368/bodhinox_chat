// Instagram message templates on PostgreSQL:
// - An agent creates, lists, edits and deletes the workspace's templates; names
//   are unique per workspace regardless of case.
// - Another workspace never sees, reads, edits or deletes them (RLS + account filter).
// - A viewer can list but cannot write (row-level security).
// - readInstagramTemplate (the send path) only returns this workspace's rows, and
//   a stored row that no longer fits Instagram's limits is never returned.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import {
  createInstagramTemplate,
  deleteInstagramTemplate,
  InstagramTemplateError,
  listInstagramTemplates,
  readInstagramTemplate,
  updateInstagramTemplate,
} from './message-templates';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID();
const agentA = randomUUID(), viewerA = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const agent = { accountId: A, userId: agentA, role: 'agent' as const };
const other = { accountId: B, userId: ownerB, role: 'owner' as const };
const cards = (title: string) => ({ name: title, kind: 'cards', payload: { cards: [{ title, buttons: [{ type: 'reply', title: 'More' }] }] } });
const code = async (work: Promise<unknown>) => work.then(() => 'ok', (e) => (e instanceof InstagramTemplateError ? e.code : 'error'));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram message templates', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    for (const id of [agentA, viewerA, ownerA, ownerB])
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Templates','test-only-hash')", [id, `${id}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Templates A',$2),($3,'Templates B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [A, ownerA, agentA, viewerA, B, ownerB]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agentA, viewerA, ownerA, ownerB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('an agent creates, lists, edits and deletes templates; names are unique ignoring case', async () => {
    const created = await createInstagramTemplate(agent, cards('Spring sale'));
    expect(created.kind).toBe('cards');
    expect(await code(createInstagramTemplate(agent, cards('SPRING SALE')))).toBe('duplicate_name');
    const button = await createInstagramTemplate(agent, { name: 'Book', kind: 'button', payload: { text: 'Pick a time', buttons: [{ type: 'reply', title: 'Today' }] } });
    expect((await listInstagramTemplates(agent)).map((t) => t.name)).toEqual(['Book', 'Spring sale']);

    const edited = await updateInstagramTemplate(agent, button.id, { name: 'Booking', kind: 'button', payload: { text: 'When?', buttons: [{ type: 'reply', title: 'Now' }] } });
    expect(edited).toMatchObject({ name: 'Booking', payload: { text: 'When?' } });
    await deleteInstagramTemplate(agent, button.id);
    expect((await listInstagramTemplates(agent)).map((t) => t.name)).toEqual(['Spring sale']);
    expect(await code(deleteInstagramTemplate(agent, button.id))).toBe('not_found');
  });

  it("never shows or changes another workspace's templates", async () => {
    const [mine] = await listInstagramTemplates(agent);
    expect(await listInstagramTemplates(other)).toEqual([]);
    expect(await code(updateInstagramTemplate(other, mine.id, cards('Taken over')))).toBe('not_found');
    expect(await code(deleteInstagramTemplate(other, mine.id))).toBe('not_found');
    expect(await code(withTenant(other, (tx) => readInstagramTemplate(tx, B, mine.id), getWorkerPrisma()))).toBe('not_found');
    // Even naming this workspace's id in another workspace's transaction finds nothing.
    expect(await code(withTenant(other, (tx) => readInstagramTemplate(tx, A, mine.id)))).toBe('not_found');
    expect((await listInstagramTemplates(agent))[0].name).toBe('Spring sale');
  });

  it('a viewer reads but cannot write', async () => {
    const viewer = { accountId: A, userId: viewerA, role: 'viewer' as const };
    expect((await listInstagramTemplates(viewer)).length).toBe(1);
    expect(await code(createInstagramTemplate(viewer, cards('Viewer made')))).not.toBe('ok');
    expect((await listInstagramTemplates(agent)).map((t) => t.name)).toEqual(['Spring sale']);
  });

  it('the send path never returns a stored row that no longer fits Instagram', async () => {
    const id = (await q(`INSERT INTO instagram_message_templates(account_id,name,kind,payload)
      VALUES($1,'Broken','cards','{"cards":[]}'::jsonb) RETURNING id`, [A])).rows[0].id;
    expect(await code(withTenant({ accountId: A, role: 'owner' }, (tx) => readInstagramTemplate(tx, A, id), getWorkerPrisma()))).toBe('not_found');
    expect((await listInstagramTemplates(agent)).map((t) => t.name)).not.toContain('Broken');
  });
});
