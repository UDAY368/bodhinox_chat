// Instagram Phase 1 (Stage 2A) schema on PostgreSQL: the new flow trigger and
// step values, the comment-to-flow link, the profile facts, the conversation
// starters column, the per-channel reply switches and webhook endpoint
// channels. Checks defaults, CHECK constraints, column grants for the app and
// worker roles, and that RLS keeps each workspace to its own rows.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/types';
import { IMPLEMENTED_NODE_TYPES } from '@/lib/flows/node-registry';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminUser = randomUUID(), ownerUserB = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: adminUser, role: 'admin' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };
const workerB: TenantContext = { accountId: accountB, role: 'owner' };
const asWorker = <T>(context: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(context, op, getWorkerPrisma());

let owner: pg.Client;
const ids = { igA: '', igB: '', identityA: '', flowA: '', runA: '', runB: '', eventA: '' };
const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 18);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram Phase 1 schema on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG phase 1 test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG phase 1 A',$2),($3,'IG phase 1 B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'owner')", [accountA, adminUser, accountB, ownerUserB]);
    const ig = (account: string, user: string) => owner.query<{ id: string }>(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id)
      VALUES($1,$2,'phase1','enc-test-only-token',$3) RETURNING id`, [account, digits(), user]).then((r) => r.rows[0].id);
    ids.igA = await ig(accountA, adminUser);
    ids.igB = await ig(accountB, ownerUserB);
    const contact = (await owner.query<{ id: string }>("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'','Commenter') RETURNING id",
      [accountA, adminUser])).rows[0].id;
    ids.identityA = (await owner.query<{ id: string }>(`INSERT INTO contact_channel_identities(account_id,contact_id,instagram_account_id,external_id)
      VALUES($1,$2,$3,$4) RETURNING id`, [accountA, contact, ids.igA, digits()])).rows[0].id;
    const flow = (account: string, user: string) => owner.query<{ id: string }>(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,channel_scope)
      VALUES($1,$2,'Comment flow','ig_comment','{"post_scope":"any"}','instagram') RETURNING id`, [account, user]).then((r) => r.rows[0].id);
    ids.flowA = await flow(accountA, adminUser);
    const flowB = await flow(accountB, ownerUserB);
    const run = (account: string, flowId: string, user: string) => owner.query<{ id: string }>(
      "INSERT INTO flow_runs(account_id,flow_id,user_id,status) VALUES($1,$2,$3,'active') RETURNING id", [account, flowId, user]).then((r) => r.rows[0].id);
    ids.runA = await run(accountA, ids.flowA, adminUser);
    ids.runB = await run(accountB, flowB, ownerUserB);
    ids.eventA = (await owner.query<{ id: string }>(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,from_igsid)
      VALUES($1,$2,$3,$4,$5) RETURNING id`, [accountA, ids.igA, digits(), digits(), digits()])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      // The live Instagram accounts and their placeholder tokens must not reach later suites (token sweep, ingest).
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('accepts every trigger and step type the code knows, and nothing else', async () => {
    const triggers = (await owner.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='flows_trigger_type_check'")).rows[0].def;
    for (const trigger of FLOW_TRIGGER_TYPES) expect(triggers, trigger).toContain(`'${trigger}'`);
    const nodes = (await owner.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='flow_nodes_node_type_check'")).rows[0].def;
    for (const node of IMPLEMENTED_NODE_TYPES) expect(nodes, node).toContain(`'${node}'`);
    const valid = (await owner.query<{ convalidated: boolean }>(
      "SELECT bool_and(convalidated) AS convalidated FROM pg_constraint WHERE conname IN ('flows_trigger_type_check','flow_nodes_node_type_check')")).rows[0];
    expect(valid.convalidated).toBe(true);
    // ig_live_comment became a real trigger in Stage 3; an unknown one is still refused.
    await expect(owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'Bad','ig_not_a_trigger')", [accountA, adminUser]))
      .rejects.toThrow(/flows_trigger_type_check/);
    await owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type) VALUES($1,$2,'reply','ig_private_reply'),($1,$2,'card','send_gallery')",
      [accountA, ids.flowA]);
    await expect(owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type) VALUES($1,$2,'x','send_carousel')", [accountA, ids.flowA]))
      .rejects.toThrow(/flow_nodes_node_type_check/);
  });

  it('links a comment to a run of the same workspace only, and keeps ids digits-only', async () => {
    await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET flow_run_id=${ids.runA}::uuid,
      public_reply_id='17890000000000001', opted_in_at=now() WHERE id=${ids.eventA}::uuid`);
    const row = (await owner.query('SELECT flow_run_id, public_reply_id FROM instagram_comment_events WHERE id=$1', [ids.eventA])).rows[0];
    expect(row).toEqual({ flow_run_id: ids.runA, public_reply_id: '17890000000000001' });
    // Another workspace's run is refused by the composite foreign key.
    await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET flow_run_id=${ids.runB}::uuid
      WHERE id=${ids.eventA}::uuid`)).rejects.toThrow();
    await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET public_reply_id='not-an-id'
      WHERE id=${ids.eventA}::uuid`)).rejects.toThrow();
    // Members read the link but never write it; B's worker cannot see A's event.
    const seen = await withTenant(adminA, (tx) => tx.$queryRaw<{ flow_run_id: string }[]>`SELECT flow_run_id FROM instagram_comment_events`);
    expect(seen.map((r) => r.flow_run_id)).toEqual([ids.runA]);
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET opted_in_at=now()`)).rejects.toThrow();
    expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET opted_in_at=now() WHERE id=${ids.eventA}::uuid`)).toBe(0);
  });

  it('stores profile facts written by the worker; members read them and cannot set them', async () => {
    expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET follows_business=true,
      business_follows=false, is_verified=false, ig_follower_count=120, profile_checked_at=now() WHERE id=${ids.identityA}::uuid`)).toBe(1);
    const facts = await withTenant(adminA, (tx) => tx.$queryRaw<{ follows_business: boolean; ig_follower_count: number }[]>`
      SELECT follows_business, ig_follower_count FROM contact_channel_identities WHERE id=${ids.identityA}::uuid`);
    expect(facts).toEqual([{ follows_business: true, ig_follower_count: 120 }]);
    // The app role's column grant is UPDATE (contact_id, updated_at) only.
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET follows_business=false
      WHERE id=${ids.identityA}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET ig_follower_count=-1
      WHERE id=${ids.identityA}::uuid`)).rejects.toThrow();
    expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET is_verified=true
      WHERE id=${ids.identityA}::uuid`)).toBe(0);
  });

  it('lets members read conversation starters but never the token; only the worker writes them', async () => {
    const starters = JSON.stringify([{ question: 'Opening hours?', flow_id: ids.flowA }]);
    expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET ice_breakers=${starters}::jsonb,
      profile_synced_at=now() WHERE id=${ids.igA}::uuid`)).toBe(1);
    const rows = await withTenant(adminA, (tx) => tx.$queryRaw<{ id: string; ice_breakers: unknown }[]>`
      SELECT id, ice_breakers FROM instagram_accounts`);
    expect(rows).toEqual([{ id: ids.igA, ice_breakers: [{ question: 'Opening hours?', flow_id: ids.flowA }] }]);
    await expect(withTenant(adminA, (tx) => tx.$queryRaw`SELECT access_token_enc FROM instagram_accounts`)).rejects.toThrow(/permission denied/);
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET ice_breakers='[]'::jsonb`)).rejects.toThrow(/permission denied/);
    const five = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, flow_id: ids.flowA })));
    await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET ice_breakers=${five}::jsonb
      WHERE id=${ids.igA}::uuid`)).rejects.toThrow();
    expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET ice_breakers='[]'::jsonb
      WHERE id=${ids.igA}::uuid`)).toBe(0);
  });

  it('defaults the Instagram reply switches off and the webhook channels to WhatsApp', async () => {
    await owner.query("INSERT INTO ai_configs(account_id,provider,model,api_key) VALUES($1,'openai','gpt-test','encrypted-placeholder')", [accountA]);
    const ai = (await owner.query('SELECT auto_reply_enabled, instagram_auto_reply_enabled FROM ai_configs WHERE account_id=$1', [accountA])).rows[0];
    expect(ai).toEqual({ auto_reply_enabled: false, instagram_auto_reply_enabled: false });

    await owner.query('INSERT INTO workspace_inbox_settings(account_id) VALUES($1)', [accountA]);
    expect((await owner.query('SELECT instagram_away_message_enabled FROM workspace_inbox_settings WHERE account_id=$1', [accountA])).rows[0])
      .toEqual({ instagram_away_message_enabled: false });
    // Like the WhatsApp switch, it needs the away message text; admins set it through RLS.
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE workspace_inbox_settings SET instagram_away_message_enabled=true`)).rejects.toThrow();
    expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE workspace_inbox_settings
      SET away_message='We are away', instagram_away_message_enabled=true`)).toBe(1);

    const endpoint = (await owner.query<{ channels: string[] }>(
      "INSERT INTO webhook_endpoints(account_id,url,secret) VALUES($1,'https://hooks.example.invalid/a','enc-test-secret') RETURNING channels", [accountA])).rows[0];
    expect(endpoint.channels).toEqual(['whatsapp']);
    await owner.query("INSERT INTO webhook_endpoints(account_id,url,secret,channels) VALUES($1,'https://hooks.example.invalid/b','enc-test-secret','{whatsapp,instagram}')", [accountA]);
    for (const bad of ['{}', '{sms}', '{whatsapp,instagram,whatsapp}'])
      await expect(owner.query("INSERT INTO webhook_endpoints(account_id,url,secret,channels) VALUES($1,'https://hooks.example.invalid/c','enc-test-secret',$2)",
        [accountA, bad])).rejects.toThrow(/webhook_endpoints_channels_check/);
  });
});
