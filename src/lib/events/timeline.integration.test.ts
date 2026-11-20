import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { encodeTimelineCursor, TIMELINE_PAGE_SIZE } from './store';
import { contactTimeline, TimelineCursorError } from './timeline';

// The contact timeline on PostgreSQL: tenancy, keyset paging with no gap or repeat, and a
// viewer's view without orders and payments.
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const asA = { accountId: accountA, userId: ownerA, role: 'owner' as const };
const asB = { accountId: accountB, userId: ownerB, role: 'owner' as const };
const contactA = randomUUID(), contactB = randomUUID();
let db: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('contact timeline on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Timeline', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Timeline A',$2),($3,'Timeline B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'A','14155550601'),($4,$5,$6,'B','14155550602')",
      [contactA, accountA, ownerA, contactB, accountB, ownerB]);
    // 35 events for A's contact, one minute apart (newest last), alternating deals and payments; one for B's.
    for (let i = 0; i < 35; i++) {
      const payment = i % 2 === 1;
      await db.query(`INSERT INTO domain_events(account_id,type,subject_kind,subject_id,contact_id,data,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,now() - make_interval(mins => $7))`,
      [accountA, payment ? 'payment.received' : 'deal.stage_changed', payment ? 'payment' : 'deal', randomUUID(), contactA,
        JSON.stringify({ n: i }), 35 - i]);
    }
    await db.query(`INSERT INTO domain_events(account_id,type,subject_kind,subject_id,contact_id,data)
      VALUES($1,'deal.stage_changed','deal',$2,$3,'{}')`, [accountB, randomUUID(), contactB]);
  });

  afterAll(async () => {
    await db.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
    await db.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, ownerB]]);
    await db.end();
    await disconnectDatabases();
  });

  it('pages newest first with no gap or repeat', async () => {
    const first = (await contactTimeline(asA, contactA, null))!;
    expect(first.events).toHaveLength(TIMELINE_PAGE_SIZE);
    expect(first.events[0]).toMatchObject({ data: { n: 34 }, subject: { kind: 'deal' } });
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = (await contactTimeline(asA, contactA, first.next_cursor))!;
    expect(second.next_cursor).toBeNull();
    const seen = [...first.events, ...second.events].map((e) => e.data.n);
    expect(seen).toEqual(Array.from({ length: 35 }, (_, i) => 34 - i));
  });

  it("keeps each workspace's timeline to itself", async () => {
    expect(await contactTimeline(asB, contactA, null)).toBeNull();
    expect(await contactTimeline(asA, contactB, null)).toBeNull();
    const own = (await contactTimeline(asB, contactB, null))!;
    expect(own.events).toHaveLength(1);
    // A cursor from A's timeline used in B finds only B's contact rows (none older than it).
    const first = (await contactTimeline(asA, contactA, null))!;
    expect((await contactTimeline(asB, contactB, first.next_cursor))!.events.every((e) => e.subject.kind === 'deal')).toBe(true);
  });

  it("gives a viewer no payment events, and refuses a malformed cursor", async () => {
    const viewer = { ...asA, role: 'viewer' as const };
    const page = (await contactTimeline(viewer, contactA, null))!;
    expect(page.events.length).toBe(18);
    expect(page.events.every((e) => e.type === 'deal.stage_changed')).toBe(true);
    await expect(contactTimeline(asA, contactA, 'not-a-cursor')).rejects.toBeInstanceOf(TimelineCursorError);
    // A well-formed cursor is just a position: it cannot widen the query.
    const cursor = encodeTimelineCursor({ occurred_at: new Date(Date.now() + 60_000), id: randomUUID() });
    expect((await contactTimeline(asA, contactA, cursor))!.events).toHaveLength(TIMELINE_PAGE_SIZE);
  });
});
