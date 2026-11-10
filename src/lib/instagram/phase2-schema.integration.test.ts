// Instagram Phase 2 (Stage 3A) schema on PostgreSQL: the Live comment and ref
// link triggers, the persistent menu, the contact's last ref, the AI comment
// settings and approval queue, and the comment funnel marks. Checks defaults,
// CHECK constraints, column grants for the app and worker roles, the admin-only
// approval rules, and that RLS keeps each workspace to its own rows.
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
import { markCommentFunnelStep } from './comment-funnel';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminUser = randomUUID(), agentUser = randomUUID(), ownerUserB = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: adminUser, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agentUser, role: 'agent' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerUserB, role: 'owner' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };
const workerB: TenantContext = { accountId: accountB, role: 'owner' };
const asWorker = <T>(context: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(context, op, getWorkerPrisma());

let owner: pg.Client;
const ids = { igA: '', igB: '', identityA: '', flowA: '', runA: '', runB: '', eventA: '', eventA2: '', eventB: '' };
const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 18);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram Phase 2 schema on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'IG phase 2 test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, agentUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'IG phase 2 A',$2),($3,'IG phase 2 B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, adminUser, agentUser, accountB, ownerUserB]);
    const ig = (account: string, user: string) => owner.query<{ id: string }>(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id)
      VALUES($1,$2,'phase2','enc-test-only-token',$3) RETURNING id`, [account, digits(), user]).then((r) => r.rows[0].id);
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
    const event = (account: string, igAccount: string, runId: string | null) => owner.query<{ id: string }>(
      `INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,media_id,from_igsid,flow_run_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [account, igAccount, digits(), digits(), digits(), runId]).then((r) => r.rows[0].id);
    ids.eventA = await event(accountA, ids.igA, ids.runA);
    ids.eventA2 = await event(accountA, ids.igA, null);
    ids.eventB = await event(accountB, ids.igB, ids.runB);
  });

  afterAll(async () => {
    if (owner) {
      // The live Instagram accounts and their placeholder tokens must not reach later suites (token sweep, ingest).
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, agentUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('accepts the Live comment and ref link triggers (validated) and nothing unknown', async () => {
    const def = (await owner.query<{ def: string; valid: boolean }>(
      "SELECT pg_get_constraintdef(oid) AS def, convalidated AS valid FROM pg_constraint WHERE conname='flows_trigger_type_check'")).rows[0];
    for (const trigger of FLOW_TRIGGER_TYPES) expect(def.def, trigger).toContain(`'${trigger}'`);
    expect(def.valid).toBe(true);
    await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,channel_scope)
      VALUES($1,$2,'Live','ig_live_comment','{}','instagram'),($1,$2,'Ref','ig_ref','{"refs":["bio"]}','instagram')`, [accountA, adminUser]);
    await expect(owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'Bad','ig_not_a_trigger')", [accountA, adminUser]))
      .rejects.toThrow(/flows_trigger_type_check/);
  });

  it('lets members read the persistent menu but never the token; only the worker writes it, at most 20 items', async () => {
    const menu = JSON.stringify([{ type: 'postback', title: 'Book a call', flow_id: ids.flowA }, { type: 'web_url', title: 'Shop', url: 'https://shop.example.test' }]);
    expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET persistent_menu=${menu}::jsonb,
      persistent_menu_synced_at=now() WHERE id=${ids.igA}::uuid`)).toBe(1);
    const rows = await withTenant(agentA, (tx) => tx.$queryRaw<{ id: string; persistent_menu: unknown }[]>`
      SELECT id, persistent_menu FROM instagram_accounts`);
    expect(rows).toEqual([{ id: ids.igA, persistent_menu: JSON.parse(menu) }]);
    await expect(withTenant(adminA, (tx) => tx.$queryRaw`SELECT access_token_enc FROM instagram_accounts`)).rejects.toThrow(/permission denied/);
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET persistent_menu='[]'::jsonb`)).rejects.toThrow(/permission denied/);
    const big = JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ type: 'postback', title: `Item ${i}`, flow_id: ids.flowA })));
    await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET persistent_menu=${big}::jsonb
      WHERE id=${ids.igA}::uuid`)).rejects.toThrow();
    await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET persistent_menu='{}'::jsonb
      WHERE id=${ids.igA}::uuid`)).rejects.toThrow();
    expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE instagram_accounts SET persistent_menu='[]'::jsonb
      WHERE id=${ids.igA}::uuid`)).toBe(0);
  });

  it('stores the last ref link from the worker; members read it and cannot set it; odd refs are refused', async () => {
    expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET last_ref='summer-sale',
      last_ref_at=now() WHERE id=${ids.identityA}::uuid`)).toBe(1);
    const seen = await withTenant(agentA, (tx) => tx.$queryRaw<{ last_ref: string }[]>`
      SELECT last_ref FROM contact_channel_identities WHERE id=${ids.identityA}::uuid`);
    expect(seen).toEqual([{ last_ref: 'summer-sale' }]);
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET last_ref='x'
      WHERE id=${ids.identityA}::uuid`)).rejects.toThrow(/permission denied/);
    for (const bad of ['', 'has space', '<script>', 'x'.repeat(251)])
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET last_ref=${bad}
        WHERE id=${ids.identityA}::uuid`), bad).rejects.toThrow();
    expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE contact_channel_identities SET last_ref='bio'
      WHERE id=${ids.identityA}::uuid`)).toBe(0);
  });

  it('defaults AI comments off with approval required and a 50 a day cap (1-500)', async () => {
    await owner.query("INSERT INTO ai_configs(account_id,provider,model,api_key) VALUES($1,'openai','gpt-test','encrypted-placeholder')", [accountA]);
    const row = (await owner.query(`SELECT instagram_ai_comments_enabled AS enabled, instagram_ai_comments_auto_approve AS auto,
      instagram_ai_comments_daily_cap AS cap FROM ai_configs WHERE account_id=$1`, [accountA])).rows[0];
    expect(row).toEqual({ enabled: false, auto: false, cap: 50 });
    for (const cap of [0, 501])
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE ai_configs SET instagram_ai_comments_daily_cap=${cap}`), String(cap)).rejects.toThrow();
    // Admins change the switches (server routes run as them); agents cannot.
    expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE ai_configs SET instagram_ai_comments_enabled=true,
      instagram_ai_comments_daily_cap=10`)).toBe(1);
    expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_configs SET instagram_ai_comments_auto_approve=true`)).toBe(0);
  });

  describe('AI comment approval queue', () => {
    const queueId = { a: '', b: '' };
    const insert = (context: TenantContext, account: string, igAccount: string, eventId: string, reply = 'Thank you!') =>
      asWorker(context, (tx) => tx.$queryRaw<{ id: string; status: string; auto_approved: boolean }[]>`
        INSERT INTO instagram_ai_comment_queue(account_id,instagram_account_id,comment_event_id,comment_id,sentiment,intent,reply_text)
        VALUES(${account}::uuid,${igAccount}::uuid,${eventId}::uuid,${digits()},'positive','praise',${reply})
        RETURNING id, status, auto_approved`).then((rows) => rows[0]);

    beforeAll(async () => {
      const a = await insert(workerA, accountA, ids.igA, ids.eventA);
      expect(a).toMatchObject({ status: 'pending', auto_approved: false });
      queueId.a = a.id;
      queueId.b = (await insert(workerB, accountB, ids.igB, ids.eventB)).id;
    });

    it('queues a comment once, in its own workspace only, with the reply within the comment cap', async () => {
      await expect(insert(workerA, accountA, ids.igA, ids.eventA)).rejects.toThrow();
      // Another workspace's comment event or account is refused by the composite foreign keys.
      await expect(insert(workerA, accountA, ids.igA, ids.eventB)).rejects.toThrow();
      await expect(insert(workerA, accountA, ids.igB, ids.eventA2)).rejects.toThrow();
      for (const reply of [' ', 'x'.repeat(2201)])
        await expect(insert(workerA, accountA, ids.igA, ids.eventA2, reply)).rejects.toThrow();
      // Members never insert queue rows.
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`INSERT INTO instagram_ai_comment_queue(account_id,instagram_account_id,
        comment_event_id,comment_id,sentiment,reply_text) VALUES(${accountA}::uuid,${ids.igA}::uuid,${ids.eventA2}::uuid,'1','positive','Hi')`))
        .rejects.toThrow(/permission denied/);
    });

    it('lets members read only their workspace’s queue', async () => {
      const a = await withTenant(agentA, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM instagram_ai_comment_queue`);
      expect(a.map((r) => r.id)).toEqual([queueId.a]);
      const b = await withTenant(ownerB, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM instagram_ai_comment_queue`);
      expect(b.map((r) => r.id)).toEqual([queueId.b]);
    });

    it('refuses agents, other users’ names, other statuses and other columns', async () => {
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='approved',
        decided_by=${agentUser}::uuid, decided_at=now() WHERE id=${queueId.a}::uuid`)).toBe(0);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='approved',
        decided_by=${agentUser}::uuid, decided_at=now() WHERE id=${queueId.a}::uuid`)).rejects.toThrow(/row-level security/);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='sent',
        decided_by=${adminUser}::uuid, decided_at=now() WHERE id=${queueId.a}::uuid`)).rejects.toThrow(/row-level security/);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='approved'
        WHERE id=${queueId.a}::uuid`)).rejects.toThrow(/row-level security/);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET public_reply_id='1'
        WHERE id=${queueId.a}::uuid`)).rejects.toThrow(/permission denied/);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET auto_approved=true
        WHERE id=${queueId.a}::uuid`)).rejects.toThrow(/permission denied/);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`DELETE FROM instagram_ai_comment_queue`)).rejects.toThrow(/permission denied/);
      // Another workspace's admin cannot see or decide A's draft.
      expect(await withTenant(ownerB, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='rejected',
        decided_by=${ownerUserB}::uuid, decided_at=now() WHERE id=${queueId.a}::uuid`)).toBe(0);
      expect((await owner.query('SELECT status FROM instagram_ai_comment_queue WHERE id=$1', [queueId.a])).rows[0].status).toBe('pending');
    });

    it('lets an admin approve a pending draft once, as themselves, with an edited reply; the worker records the post', async () => {
      expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='approved',
        reply_text='Thanks so much!', decided_by=${adminUser}::uuid, decided_at=now() WHERE id=${queueId.a}::uuid`)).toBe(1);
      // Decided rows are no longer the admin's to change.
      expect(await withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='rejected',
        decided_by=${adminUser}::uuid, decided_at=now() WHERE id=${queueId.a}::uuid`)).toBe(0);
      // A posted reply records its id.
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='sent'
        WHERE id=${queueId.a}::uuid`)).rejects.toThrow();
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='sent',
        public_reply_id='17890000000000009' WHERE id=${queueId.a}::uuid`)).toBe(1);
      expect(await asWorker(workerB, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='failed'
        WHERE id=${queueId.a}::uuid`)).toBe(0);
      const row = (await owner.query('SELECT status, reply_text, decided_by FROM instagram_ai_comment_queue WHERE id=$1', [queueId.a])).rows[0];
      expect(row).toEqual({ status: 'sent', reply_text: 'Thanks so much!', decided_by: adminUser });
    });

    it('needs a decision time on every decided row and drops the draft with its comment', async () => {
      const id = (await insert(workerA, accountA, ids.igA, ids.eventA2)).id;
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='approved', auto_approved=true
        WHERE id=${id}::uuid`)).rejects.toThrow();
      expect(await asWorker(workerA, (tx) => tx.$executeRaw`UPDATE instagram_ai_comment_queue SET status='approved', auto_approved=true,
        decided_at=now() WHERE id=${id}::uuid`)).toBe(1);
      await owner.query('DELETE FROM instagram_comment_events WHERE id=$1', [ids.eventA2]);
      expect((await owner.query('SELECT count(*)::int AS n FROM instagram_ai_comment_queue WHERE id=$1', [id])).rows[0].n).toBe(0);
    });
  });

  it('marks each funnel step once on the comment whose run it is, never another workspace’s', async () => {
    expect(await markCommentFunnelStep(accountA, ids.runA, 'lead_captured')).toBe(true);
    expect(await markCommentFunnelStep(accountA, ids.runA, 'lead_captured')).toBe(false);
    expect(await markCommentFunnelStep(accountA, ids.runA, 'followed')).toBe(true);
    // A's workspace cannot mark B's run; malformed ids are ignored.
    expect(await markCommentFunnelStep(accountA, ids.runB, 'link_clicked')).toBe(false);
    expect(await markCommentFunnelStep(accountA, 'not-a-uuid', 'link_clicked')).toBe(false);
    const a = (await owner.query('SELECT lead_captured_at, followed_at, link_clicked_at FROM instagram_comment_events WHERE id=$1', [ids.eventA])).rows[0];
    expect(a.lead_captured_at).toBeInstanceOf(Date);
    expect(a.followed_at).toBeInstanceOf(Date);
    expect(a.link_clicked_at).toBeNull();
    expect((await owner.query('SELECT link_clicked_at FROM instagram_comment_events WHERE id=$1', [ids.eventB])).rows[0].link_clicked_at).toBeNull();
    // Members read the marks but never write them.
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE instagram_comment_events SET link_clicked_at=now()`)).rejects.toThrow();
    const indexes = (await owner.query<{ name: string; valid: boolean }>(`SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i
      JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('instagram_comment_events_run_idx','instagram_comment_events_received_idx')
      ORDER BY 1`)).rows;
    expect(indexes).toEqual([{ name: 'instagram_comment_events_received_idx', valid: true }, { name: 'instagram_comment_events_run_idx', valid: true }]);
  });
});
