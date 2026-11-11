// Stage 5 (5F) conversion events on a real PostgreSQL: admins name, rename,
// archive and restore types (an agent cannot), names are unique without case
// among active types, logConversion writes one row per run, step and type (a
// replayed step counts once), writes nothing for an archived, unknown or other
// workspace's type, and counts stay inside the workspace.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRange } from '@/lib/analytics/range';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createConversionEventType, listConversionEventTypes, updateConversionEventType } from './conversion-events';
import { conversionCounts, logConversion } from './conversion-log';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const flow = randomUUID(), runX = randomUUID(), runY = randomUUID(), contact = randomUUID();
const admin: TenantContext = { accountId: A, userId: adminA, role: 'admin' };
const agent: TenantContext = { accountId: A, userId: agentA, role: 'agent' };
const other: TenantContext = { accountId: B, userId: ownerB, role: 'owner' };
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const today = () => parseRange({ preset: 'today' }, 'UTC');
const input = (eventTypeId: string, runId = runX, nodeKey = 'actions_1') =>
  ({ eventTypeId, contactId: contact, flowId: flow, runId, nodeKey, channel: 'instagram' as const });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('conversion events on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Conversions', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Conv A',$2),($3,'Conv B',$4)", [A, adminA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [A, adminA, agentA, B, ownerB]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'C','919800000021')", [contact, A, adminA]);
    await q("INSERT INTO flows(id,account_id,user_id,name,trigger_type,channel_scope) VALUES($1,$2,$3,'Booking','keyword','instagram')", [flow, A, adminA]);
    await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,status,started_at) VALUES
      ($1,$3,$4,$5,$6,'completed',now()),($2,$3,$4,$5,$6,'completed',now())`, [runX, runY, A, flow, adminA, contact]);
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('lets admins manage types, with unique names among active ones, and agents only read', async () => {
    const booked = await createConversionEventType(admin, 'Booked call');
    await expect(createConversionEventType(admin, 'booked CALL')).rejects.toMatchObject({ code: 'name_taken' });
    await expect(createConversionEventType(admin, ' ')).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(createConversionEventType(agent, 'Agent type')).rejects.toThrow();
    await updateConversionEventType(admin, booked.id, { name: 'Call booked' });
    expect((await listConversionEventTypes(agent)).map((t) => t.name)).toEqual(['Call booked']);
    // Archived names free up: a new active type may reuse one.
    await updateConversionEventType(admin, booked.id, { archived: true });
    const again = await createConversionEventType(admin, 'Call booked');
    await expect(updateConversionEventType(admin, booked.id, { archived: false })).rejects.toMatchObject({ code: 'name_taken' });
    await updateConversionEventType(admin, again.id, { name: 'Sign-up' });
    await updateConversionEventType(admin, booked.id, { archived: false });
    expect((await listConversionEventTypes(admin)).map((t) => [t.name, t.archived])).toEqual([['Call booked', false], ['Sign-up', false]]);
    await expect(updateConversionEventType(agent, booked.id, { archived: true })).rejects.toThrow();
  });

  it('writes one row per run, step and type: a replayed step counts once', async () => {
    const [type] = await listConversionEventTypes(admin);
    expect(await logConversion(A, input(type.id))).toBe(true);
    expect(await logConversion(A, input(type.id))).toBe(false);
    expect(await logConversion(A, input(type.id, runY))).toBe(true);
    expect(await logConversion(A, input(type.id, runY, 'actions_2'))).toBe(true);
    expect((await q('SELECT count(*)::int AS n FROM conversion_event_log WHERE event_type_id=$1', [type.id])).rows[0].n).toBe(3);
    // No run or step: nothing a replay could be told apart from, so nothing is written.
    expect(await logConversion(A, { ...input(type.id), runId: null })).toBe(false);
    expect(await logConversion(A, { ...input(type.id), nodeKey: null })).toBe(false);
  });

  it('writes nothing for an archived, unknown or other workspace’s type', async () => {
    const theirs = await createConversionEventType(other, 'Their event');
    const archived = await createConversionEventType(admin, 'Old event');
    await updateConversionEventType(admin, archived.id, { archived: true });
    expect(await logConversion(A, input(archived.id))).toBe(false);
    expect(await logConversion(A, input(randomUUID()))).toBe(false);
    expect(await logConversion(A, input(theirs.id))).toBe(false);
    expect((await q('SELECT count(*)::int AS n FROM conversion_event_log WHERE event_type_id=ANY($1::uuid[])', [[theirs.id, archived.id]])).rows[0].n).toBe(0);
  });

  it('counts per type inside the workspace, and the app role cannot write the log', async () => {
    const counts = await withTenant(admin, (tx) => conversionCounts(tx, A, today(), 'instagram'));
    expect(counts.find((c) => c.name === 'Call booked')?.count).toBe(3);
    expect(counts.some((c) => c.name === 'Their event')).toBe(false);
    expect((await withTenant(admin, (tx) => conversionCounts(tx, A, today(), 'whatsapp'))).every((c) => c.count === 0)).toBe(true);
    const [type] = await listConversionEventTypes(admin);
    await expect(withTenant(admin, (tx) => tx.$executeRaw`INSERT INTO conversion_event_log(account_id,event_type_id,channel)
      VALUES(${A}::uuid,${type.id}::uuid,'instagram')`)).rejects.toThrow();
    expect((await listConversionEventTypes(other)).map((t) => t.name)).toEqual(['Their event']);
  });
});
