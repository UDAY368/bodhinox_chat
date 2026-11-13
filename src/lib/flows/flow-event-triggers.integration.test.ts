// The automation list's flow triggers on PostgreSQL: the validated trigger check
// takes contact_created, tag_added and outside_hours and still refuses anything
// unknown; an agent saves such a flow through the app role in their own
// workspace only, and another workspace never sees it.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL), as test-db-local.cjs sets them; the suite is skipped
// without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;

const accountA = randomUUID(), accountB = randomUUID();
const agentUser = randomUUID(), ownerUserA = randomUUID(), ownerUserB = randomUUID();
const agentA: TenantContext = { accountId: accountA, userId: agentUser, role: 'agent' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerUserB, role: 'owner' };
const TAG = randomUUID();

let owner: pg.Client;

const insertFlow = (context: TenantContext, triggerType: string, config: Record<string, unknown>) =>
  withTenant(context, (tx) => tx.$queryRaw<{ id: string }[]>`
    INSERT INTO flows(account_id, user_id, name, trigger_type, trigger_config, channel_scope)
    VALUES(${context.accountId}::uuid, ${context.userId}::uuid, ${`Event ${triggerType}`}, ${triggerType}, ${JSON.stringify(config)}::jsonb, 'whatsapp')
    RETURNING id::text AS id`).then((rows) => rows[0].id);

describe.skipIf(!ownerUrl || !appUrl)('flow event triggers on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Event trigger test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[agentUser, ownerUserA, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Event triggers A',$2),($3,'Event triggers B',$4)", [accountA, ownerUserA, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, ownerUserA, agentUser, accountB, ownerUserB]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[agentUser, ownerUserA, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('validates a trigger check that takes the three event triggers and nothing unknown', async () => {
    const def = (await owner.query<{ def: string; valid: boolean }>(
      "SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid FROM pg_constraint WHERE conname='flows_trigger_type_check'")).rows[0];
    expect(def.valid).toBe(true);
    for (const type of ['contact_created', 'tag_added', 'outside_hours', 'ig_share_to_story', 'keyword']) expect(def.def).toContain(`'${type}'`);
    await expect(owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'Bad','cart_left')", [accountA, ownerUserA]))
      .rejects.toThrow(/flows_trigger_type_check/);
  });

  it('lets an agent save event-trigger flows in their own workspace', async () => {
    const ids = [
      await insertFlow(agentA, 'contact_created', {}),
      await insertFlow(agentA, 'tag_added', { tag_id: TAG }),
      await insertFlow(agentA, 'outside_hours', { frequency: 'once_per_24h' }),
    ];
    const rows = (await owner.query<{ trigger_type: string; account_id: string }>('SELECT trigger_type, account_id::text FROM flows WHERE id=ANY($1::uuid[]) ORDER BY trigger_type', [ids])).rows;
    expect(rows.map((r) => r.trigger_type)).toEqual(['contact_created', 'outside_hours', 'tag_added']);
    expect(new Set(rows.map((r) => r.account_id))).toEqual(new Set([accountA]));
  });

  it('keeps each workspace to its own event-trigger flows', async () => {
    const seen = await withTenant(ownerB, (tx) => tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM flows WHERE trigger_type IN ('contact_created','tag_added','outside_hours')`);
    expect(seen[0].n).toBe(0);
    // An agent cannot write a flow into another workspace.
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`
      INSERT INTO flows(account_id, user_id, name, trigger_type, trigger_config)
      VALUES(${accountB}::uuid, ${agentUser}::uuid, 'Cross', 'tag_added', ${JSON.stringify({ tag_id: TAG })}::jsonb)`))
      .rejects.toThrow(/row-level security|permission denied|violates/);
  });
});
