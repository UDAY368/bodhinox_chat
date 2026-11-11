// Stage 5A schema on PostgreSQL: the new columns keep today's behaviour by
// default, the checks hold (NULL-safe), the new tables keep each workspace to
// its own rows under FORCE RLS, the role rules hold (viewers read, agents or
// admins write, favourites per member), the Google Sheets token and the link
// token are hidden from the app role, the label cap holds, and the two
// SECURITY DEFINER functions are executable by the worker only.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminUser = randomUUID(), agentUser = randomUUID(), agent2User = randomUUID(), viewerUser = randomUUID(), ownerUserB = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: adminUser, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agentUser, role: 'agent' };
const agent2A: TenantContext = { accountId: accountA, userId: agent2User, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewerUser, role: 'viewer' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerUserB, role: 'owner' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };
const asWorker = <T>(context: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(context, op, getWorkerPrisma());
const asApp = <T>(context: TenantContext, op: (tx: TenantTransaction) => Promise<T>) => withTenant(context, op);
const digits = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`.slice(0, 15);

let owner: pg.Client;
const ids = { contactA: '', contactB: '', convA: '', convB: '', flowA: '', flowB: '' };

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Stage 5A schema on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Stage 5 test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, agentUser, agent2User, viewerUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Stage 5 A',$2),($3,'Stage 5 B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')",
      [accountA, adminUser, agentUser, agent2User, viewerUser, accountB, ownerUserB]);
    const contact = (account: string, user: string) => owner.query<{ id: string }>("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Stage 5') RETURNING id",
      [account, user, `+1555${digits()}`]).then((r) => r.rows[0].id);
    ids.contactA = await contact(accountA, adminUser);
    ids.contactB = await contact(accountB, ownerUserB);
    const conversation = (account: string, user: string, contactId: string) => owner.query<{ id: string }>(
      'INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [account, user, contactId]).then((r) => r.rows[0].id);
    ids.convA = await conversation(accountA, adminUser, ids.contactA);
    ids.convB = await conversation(accountB, ownerUserB, ids.contactB);
    const flow = (account: string, user: string) => owner.query<{ id: string }>(
      "INSERT INTO flows(account_id,user_id,name,trigger_type,channel_scope) VALUES($1,$2,'Stage 5 flow','manual','instagram') RETURNING id",
      [account, user]).then((r) => r.rows[0].id);
    ids.flowA = await flow(accountA, adminUser);
    ids.flowB = await flow(accountB, ownerUserB);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, agentUser, agent2User, viewerUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('new columns on existing tables', () => {
    it('default to the behaviour before Stage 5', async () => {
      const flow = (await owner.query('SELECT extra_triggers, test_usernames, canvas_notes, folder_id FROM flows WHERE id=$1', [ids.flowA])).rows[0];
      expect(flow).toEqual({ extra_triggers: [], test_usernames: [], canvas_notes: [], folder_id: null });
      const conv = (await owner.query('SELECT bot_paused_until, bot_paused_by FROM conversations WHERE id=$1', [ids.convA])).rows[0];
      expect(conv).toEqual({ bot_paused_until: null, bot_paused_by: null });
      const contact = (await owner.query('SELECT instagram_opted_out_at, instagram_opted_in_at FROM contacts WHERE id=$1', [ids.contactA])).rows[0];
      expect(contact).toEqual({ instagram_opted_out_at: null, instagram_opted_in_at: null });
      await asApp(adminA, (tx) => tx.$executeRaw`INSERT INTO workspace_inbox_settings(account_id) VALUES(${accountA}::uuid) ON CONFLICT DO NOTHING`);
      const settings = (await owner.query('SELECT agent_reply_pause_minutes, auto_assign_mode, agent_visibility FROM workspace_inbox_settings WHERE account_id=$1', [accountA])).rows[0];
      expect(settings).toEqual({ agent_reply_pause_minutes: null, auto_assign_mode: 'rules', agent_visibility: 'all' });
      const member = (await owner.query('SELECT max_open_conversations FROM account_memberships WHERE account_id=$1 AND user_id=$2', [accountA, agentUser])).rows[0];
      expect(member).toEqual({ max_open_conversations: null });
    });

    it('refuses bad values, NULL-safe', async () => {
      const bad = (sqlText: string, params: unknown[]) => expect(owner.query(sqlText, params)).rejects.toThrow(/check|violates/);
      await bad("UPDATE flows SET test_usernames='{@shop}' WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET test_usernames='{a,b,c,d}' WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET test_usernames=ARRAY[NULL]::text[] WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET test_usernames=ARRAY['shop',NULL]::text[] WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET test_usernames=ARRAY['']::text[] WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET test_usernames=ARRAY['a,b']::text[] WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET test_usernames=ARRAY['Shop']::text[] WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET extra_triggers='[1,2,3,4,5]' WHERE id=$1", [ids.flowA]);
      await bad("UPDATE flows SET extra_triggers='{}' WHERE id=$1", [ids.flowA]);
      await bad("UPDATE workspace_inbox_settings SET auto_assign_mode='smart' WHERE account_id=$1", [accountA]);
      await bad("UPDATE workspace_inbox_settings SET agent_visibility='mine' WHERE account_id=$1", [accountA]);
      await bad('UPDATE workspace_inbox_settings SET agent_reply_pause_minutes=0 WHERE account_id=$1', [accountA]);
      await bad('UPDATE account_memberships SET max_open_conversations=0 WHERE account_id=$1 AND user_id=$2', [accountA, agentUser]);
      await owner.query('INSERT INTO ai_workspace_settings(account_id) VALUES($1) ON CONFLICT DO NOTHING', [accountA]);
      expect((await owner.query('SELECT instagram_goals FROM ai_workspace_settings WHERE account_id=$1', [accountA])).rows[0]).toEqual({ instagram_goals: [] });
      await bad("UPDATE ai_workspace_settings SET instagram_goals='[1,2,3,4]' WHERE account_id=$1", [accountA]);
      await bad("UPDATE ai_workspace_settings SET instagram_goals='{}' WHERE account_id=$1", [accountA]);
      await owner.query("UPDATE flows SET test_usernames='{shop.owner,a_b}', extra_triggers='[{\"trigger_type\":\"keyword\",\"config\":{}}]' WHERE id=$1", [ids.flowA]);
      await owner.query("UPDATE flows SET test_usernames='{}', extra_triggers='[]' WHERE id=$1", [ids.flowA]);
    });

    it('accepts the new step types in flow_nodes', async () => {
      for (const type of ['actions', 'randomizer', 'smart_delay', 'google_sheets'])
        await owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,$3,$4,'{}')", [accountA, ids.flowA, `n_${type}`, type]);
      await expect(owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,'bad','nope','{}')", [accountA, ids.flowA]))
        .rejects.toThrow(/check/);
    });

    it('lets admins, and only admins, set an agent capacity', async () => {
      await asApp(adminA, (tx) => tx.$executeRaw`UPDATE account_memberships SET max_open_conversations=5 WHERE account_id=${accountA}::uuid AND user_id=${agentUser}::uuid`);
      expect((await owner.query('SELECT max_open_conversations FROM account_memberships WHERE account_id=$1 AND user_id=$2', [accountA, agentUser])).rows[0].max_open_conversations).toBe(5);
      const changed = await asApp(agentA, (tx) => tx.$executeRaw`UPDATE account_memberships SET max_open_conversations=50 WHERE account_id=${accountA}::uuid AND user_id=${agentUser}::uuid`);
      expect(changed).toBe(0);
      await expect(asApp(adminA, (tx) => tx.$executeRaw`UPDATE account_memberships SET role='owner' WHERE account_id=${accountA}::uuid AND user_id=${agentUser}::uuid`))
        .rejects.toThrow(/permission denied/);
    });
  });

  describe('flow folders', () => {
    let folder = '';
    it('lets agents create folders, not viewers, and keeps names unique per channel without case', async () => {
      folder = (await asApp(agentA, (tx) => tx.$queryRaw<{ id: string }[]>`INSERT INTO flow_folders(account_id,channel,name,created_by)
        VALUES(${accountA}::uuid,'instagram','Launch',${agentUser}::uuid) RETURNING id`))[0].id;
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO flow_folders(account_id,channel,name) VALUES(${accountA}::uuid,'instagram','launch')`))
        .rejects.toThrow(/unique|duplicate/);
      await asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO flow_folders(account_id,channel,name) VALUES(${accountA}::uuid,'whatsapp','launch')`);
      await expect(asApp(viewerA, (tx) => tx.$executeRaw`INSERT INTO flow_folders(account_id,channel,name) VALUES(${accountA}::uuid,'instagram','Other')`))
        .rejects.toThrow(/row-level security|permission denied/);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO flow_folders(account_id,channel,name) VALUES(${accountA}::uuid,'sms','x')`)).rejects.toThrow(/check/);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO flow_folders(account_id,channel,name) VALUES(${accountA}::uuid,'instagram','   ')`)).rejects.toThrow(/check/);
    });

    it('files a flow only in a folder of its own workspace, and deleting the folder keeps the flow', async () => {
      await expect(owner.query('UPDATE flows SET folder_id=$1 WHERE id=$2', [folder, ids.flowB])).rejects.toThrow(/foreign key/);
      await owner.query('UPDATE flows SET folder_id=$1 WHERE id=$2', [folder, ids.flowA]);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM flow_folders`)).toEqual([]);
      await asApp(agentA, (tx) => tx.$executeRaw`DELETE FROM flow_folders WHERE id=${folder}::uuid`);
      expect((await owner.query('SELECT folder_id FROM flows WHERE id=$1', [ids.flowA])).rows[0]).toEqual({ folder_id: null });
    });
  });

  describe('tracked links', () => {
    const token = 'a'.repeat(32);
    it('is written by the worker; the app reads it without the token; the public lookup is worker-only', async () => {
      const runId = randomUUID();
      await asWorker(workerA, (tx) => tx.$executeRaw`INSERT INTO flow_tracked_links(account_id,token,flow_id,flow_run_id,node_key,slot,url)
        VALUES(${accountA}::uuid,${token},${ids.flowA}::uuid,${runId}::uuid,'card','button:0','https://example.test/offer')`);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`INSERT INTO flow_tracked_links(account_id,token,flow_id,flow_run_id,node_key,slot,url)
        VALUES(${accountA}::uuid,${'b'.repeat(32)},${ids.flowA}::uuid,${runId}::uuid,'card','button:0','https://example.test/x')`)).rejects.toThrow(/unique|duplicate/);
      await expect(asWorker(workerA, (tx) => tx.$executeRaw`INSERT INTO flow_tracked_links(account_id,token,flow_id,flow_run_id,node_key,slot,url)
        VALUES(${accountA}::uuid,${'c'.repeat(32)},${ids.flowA}::uuid,${randomUUID()}::uuid,'card','button:0','javascript:alert(1)')`)).rejects.toThrow(/check/);
      await expect(asApp(adminA, (tx) => tx.$queryRaw`SELECT token FROM flow_tracked_links`)).rejects.toThrow(/permission denied/);
      expect(await asApp(viewerA, (tx) => tx.$queryRaw<{ click_count: number }[]>`SELECT click_count FROM flow_tracked_links`)).toEqual([{ click_count: 0 }]);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw`SELECT id FROM flow_tracked_links`)).toEqual([]);
      await expect(asApp(adminA, (tx) => tx.$executeRaw`UPDATE flow_tracked_links SET click_count=1`)).rejects.toThrow(/permission denied/);
      const resolved = await asWorker({ accountId: accountB, role: 'owner' }, (tx) => tx.$queryRaw<{ account_id: string; url: string }[]>`SELECT account_id, url FROM resolve_flow_link_token(${token})`);
      expect(resolved).toEqual([{ account_id: accountA, url: 'https://example.test/offer' }].map((r) => expect.objectContaining(r)));
      expect(await asWorker(workerA, (tx) => tx.$queryRaw`SELECT * FROM resolve_flow_link_token('not-a-token')`)).toEqual([]);
      await expect(asApp(adminA, (tx) => tx.$queryRaw`SELECT * FROM resolve_flow_link_token(${token})`)).rejects.toThrow(/permission denied/);
    });
  });

  describe('Instagram consent settings', () => {
    it('are admin-written, member-read, NULL-safe and link only flows of the same workspace', async () => {
      await asApp(adminA, (tx) => tx.$executeRaw`INSERT INTO instagram_consent_settings(account_id,opt_out_keywords,opt_in_keywords,opt_out_reply,opt_out_flow_id)
        VALUES(${accountA}::uuid,ARRAY['para','alto']::text[],ARRAY['volver']::text[],'Done, no more automated messages.',${ids.flowA}::uuid)`);
      expect(await asApp(viewerA, (tx) => tx.$queryRaw<{ opt_out_keywords: string[] }[]>`SELECT opt_out_keywords FROM instagram_consent_settings`))
        .toEqual([{ opt_out_keywords: ['para', 'alto'] }]);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw`SELECT account_id FROM instagram_consent_settings`)).toEqual([]);
      const write = (context: TenantContext, column: string, value: unknown) =>
        asApp(context, (tx) => tx.$executeRawUnsafe(`UPDATE instagram_consent_settings SET ${column}=$1 WHERE account_id=$2::uuid`, value, accountA));
      expect(await write(agentA, 'opt_in_reply', 'hi')).toBe(0);
      await expect(write(adminA, 'opt_out_keywords', ['Para'])).rejects.toThrow(/check/);
      await expect(write(adminA, 'opt_out_keywords', [' para'])).rejects.toThrow(/check/);
      await expect(write(adminA, 'opt_out_keywords', [null])).rejects.toThrow(/check/);
      await expect(write(adminA, 'opt_out_keywords', Array.from({ length: 21 }, (_, i) => `w${i}`))).rejects.toThrow(/check/);
      await expect(write(adminA, 'opt_out_reply', '   ')).rejects.toThrow(/check/);
      await expect(owner.query('UPDATE instagram_consent_settings SET opt_in_flow_id=$1 WHERE account_id=$2', [ids.flowB, accountA])).rejects.toThrow(/foreign key/);
    });
  });

  describe('labels and favourites', () => {
    it('keeps labels to the workspace and to 20, links only same-workspace conversations', async () => {
      const label = (await asApp(agentA, (tx) => tx.$queryRaw<{ id: string }[]>`INSERT INTO conversation_labels(account_id,name,color)
        VALUES(${accountA}::uuid,'VIP','violet') RETURNING id`))[0].id;
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_labels(account_id,name) VALUES(${accountA}::uuid,'vip')`)).rejects.toThrow(/unique|duplicate/);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_labels(account_id,name,color) VALUES(${accountA}::uuid,'Hot','#ff0000')`)).rejects.toThrow(/check/);
      await asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_label_links(account_id,conversation_id,label_id) VALUES(${accountA}::uuid,${ids.convA}::uuid,${label}::uuid)`);
      await expect(owner.query('INSERT INTO conversation_label_links(account_id,conversation_id,label_id) VALUES($1,$2,$3)', [accountA, ids.convB, label]))
        .rejects.toThrow(/foreign key/);
      await expect(asApp(viewerA, (tx) => tx.$executeRaw`INSERT INTO conversation_labels(account_id,name) VALUES(${accountA}::uuid,'Viewer')`))
        .rejects.toThrow(/row-level security|permission denied/);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw`SELECT id FROM conversation_labels`)).toEqual([]);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw`SELECT label_id FROM conversation_label_links`)).toEqual([]);
      for (let i = 1; i < 20; i++) await asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_labels(account_id,name) VALUES(${accountA}::uuid,${`Label ${i}`})`);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_labels(account_id,name) VALUES(${accountA}::uuid,'One too many')`))
        .rejects.toThrow(/conversation_labels_limit/);
      // Workspace B has its own 20.
      await asApp(ownerB, (tx) => tx.$executeRaw`INSERT INTO conversation_labels(account_id,name) VALUES(${accountB}::uuid,'B label')`);
    });

    it('keeps favourites per member', async () => {
      await asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_favourites(account_id,user_id,conversation_id) VALUES(${accountA}::uuid,${agentUser}::uuid,${ids.convA}::uuid)`);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversation_favourites(account_id,user_id,conversation_id) VALUES(${accountA}::uuid,${agent2User}::uuid,${ids.convA}::uuid)`))
        .rejects.toThrow(/row-level security/);
      expect(await asApp(agentA, (tx) => tx.$queryRaw<{ user_id: string }[]>`SELECT user_id FROM conversation_favourites`)).toEqual([{ user_id: agentUser }]);
      expect(await asApp(agent2A, (tx) => tx.$queryRaw`SELECT user_id FROM conversation_favourites`)).toEqual([]);
      expect(await asApp(adminA, (tx) => tx.$queryRaw`SELECT user_id FROM conversation_favourites`)).toEqual([]);
      expect(await asApp(agent2A, (tx) => tx.$executeRaw`DELETE FROM conversation_favourites`)).toBe(0);
      await expect(owner.query('INSERT INTO conversation_favourites(account_id,user_id,conversation_id) VALUES($1,$2,$3)', [accountA, agentUser, ids.convB]))
        .rejects.toThrow(/foreign key/);
    });
  });

  describe('conversion events', () => {
    it('lets admins name types, the worker log once per run, step and type, and nobody else write the log', async () => {
      const type = (await asApp(adminA, (tx) => tx.$queryRaw<{ id: string }[]>`INSERT INTO conversion_event_types(account_id,name) VALUES(${accountA}::uuid,'Booked a call') RETURNING id`))[0].id;
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO conversion_event_types(account_id,name) VALUES(${accountA}::uuid,'Agent event')`))
        .rejects.toThrow(/row-level security|permission denied/);
      await expect(asApp(adminA, (tx) => tx.$executeRaw`DELETE FROM conversion_event_types WHERE id=${type}::uuid`)).rejects.toThrow(/permission denied/);
      const runId = randomUUID();
      const log = () => asWorker(workerA, (tx) => tx.$executeRaw`INSERT INTO conversion_event_log(account_id,event_type_id,flow_run_id,node_key,channel)
        VALUES(${accountA}::uuid,${type}::uuid,${runId}::uuid,'act','instagram') ON CONFLICT DO NOTHING`);
      expect(await log()).toBe(1);
      expect(await log()).toBe(0);
      await expect(asApp(adminA, (tx) => tx.$executeRaw`INSERT INTO conversion_event_log(account_id,event_type_id,channel) VALUES(${accountA}::uuid,${type}::uuid,'instagram')`))
        .rejects.toThrow(/permission denied/);
      await expect(owner.query("INSERT INTO conversion_event_log(account_id,event_type_id,channel) VALUES($1,$2,'instagram')", [accountB, type])).rejects.toThrow(/foreign key/);
      expect(await asApp(viewerA, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM conversion_event_log`)).toEqual([{ n: 1 }]);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM conversion_event_log`)).toEqual([{ n: 0 }]);
    });
  });

  describe('Google Sheets connections', () => {
    it('hides the refresh token from the app role, keeps one active per workspace and admin-only writes', async () => {
      await asApp(adminA, (tx) => tx.$executeRaw`INSERT INTO google_sheets_connections(account_id,google_email,refresh_token_encrypted,connected_by)
        VALUES(${accountA}::uuid,'owner@example.invalid','enc-test-only-token',${adminUser}::uuid)`);
      await expect(asApp(adminA, (tx) => tx.$queryRaw`SELECT refresh_token_encrypted FROM google_sheets_connections`)).rejects.toThrow(/permission denied/);
      await expect(asApp(adminA, (tx) => tx.$queryRaw`SELECT * FROM google_sheets_connections`)).rejects.toThrow(/permission denied/);
      expect(await asApp(viewerA, (tx) => tx.$queryRaw<{ google_email: string; status: string }[]>`SELECT google_email, status FROM google_sheets_connections`))
        .toEqual([{ google_email: 'owner@example.invalid', status: 'active' }]);
      expect(await asWorker(workerA, (tx) => tx.$queryRaw<{ refresh_token_encrypted: string }[]>`SELECT refresh_token_encrypted FROM google_sheets_connections`))
        .toEqual([{ refresh_token_encrypted: 'enc-test-only-token' }]);
      await expect(asApp(adminA, (tx) => tx.$executeRaw`INSERT INTO google_sheets_connections(account_id,google_email,refresh_token_encrypted)
        VALUES(${accountA}::uuid,'second@example.invalid','enc-test-only-token-2')`)).rejects.toThrow(/unique|duplicate/);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO google_sheets_connections(account_id,google_email,refresh_token_encrypted)
        VALUES(${accountA}::uuid,'agent@example.invalid','enc')`)).rejects.toThrow(/row-level security|permission denied/);
      await expect(asApp(adminA, (tx) => tx.$executeRaw`UPDATE google_sheets_connections SET refresh_token_encrypted='x'`)).rejects.toThrow(/permission denied/);
      expect(await asApp(ownerB, (tx) => tx.$queryRaw`SELECT id FROM google_sheets_connections`)).toEqual([]);
    });
  });

  describe('sequences', () => {
    it('keeps sequences, messages and subscriptions to the workspace, with the delay cap and the worker-only due function', async () => {
      const seq = (await asApp(agentA, (tx) => tx.$queryRaw<{ id: string }[]>`INSERT INTO sequences(account_id,channel,name,status)
        VALUES(${accountA}::uuid,'instagram','Welcome series','active') RETURNING id`))[0].id;
      await asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO sequence_messages(account_id,sequence_id,position,delay_amount,delay_unit,flow_id)
        VALUES(${accountA}::uuid,${seq}::uuid,0,1,'days',${ids.flowA}::uuid)`);
      await expect(asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO sequence_messages(account_id,sequence_id,position,delay_amount,delay_unit)
        VALUES(${accountA}::uuid,${seq}::uuid,1,366,'days')`)).rejects.toThrow(/check/);
      await expect(owner.query("INSERT INTO sequence_messages(account_id,sequence_id,position,delay_amount,delay_unit,flow_id) VALUES($1,$2,2,1,'hours',$3)",
        [accountA, seq, ids.flowB])).rejects.toThrow(/foreign key/);
      // Reorder by swapping positions inside one transaction (the unique key is checked at commit).
      await asApp(agentA, async (tx) => {
        await tx.$executeRaw`INSERT INTO sequence_messages(account_id,sequence_id,position,delay_amount,delay_unit) VALUES(${accountA}::uuid,${seq}::uuid,1,2,'hours')`;
        await tx.$executeRaw`UPDATE sequence_messages SET position = 1 - position WHERE sequence_id=${seq}::uuid`;
      });
      await asApp(agentA, (tx) => tx.$executeRaw`INSERT INTO sequence_subscriptions(account_id,sequence_id,contact_id,next_due_at)
        VALUES(${accountA}::uuid,${seq}::uuid,${ids.contactA}::uuid,now() - interval '1 minute')`);
      await expect(owner.query('INSERT INTO sequence_subscriptions(account_id,sequence_id,contact_id) VALUES($1,$2,$3)', [accountA, seq, ids.contactB]))
        .rejects.toThrow(/foreign key/);
      await expect(owner.query("UPDATE sequence_subscriptions SET status='sending' WHERE sequence_id=$1", [seq])).rejects.toThrow(/check/);
      await expect(owner.query("UPDATE sequence_subscriptions SET status='unsubscribed' WHERE sequence_id=$1", [seq])).rejects.toThrow(/check/);
      await expect(asApp(viewerA, (tx) => tx.$executeRaw`INSERT INTO sequences(account_id,channel,name) VALUES(${accountA}::uuid,'instagram','Viewer')`))
        .rejects.toThrow(/row-level security|permission denied/);
      for (const table of ['sequences', 'sequence_messages', 'sequence_subscriptions'])
        expect(await asApp(ownerB, (tx) => tx.$queryRawUnsafe(`SELECT id FROM ${table}`)), table).toEqual([]);
      const due = await asWorker(workerA, (tx) => tx.$queryRaw<{ account_id: string }[]>`SELECT account_id FROM crm_due_sequence_accounts()`);
      expect(due.map((r) => r.account_id)).toContain(accountA);
      await expect(asApp(adminA, (tx) => tx.$queryRaw`SELECT account_id FROM crm_due_sequence_accounts()`)).rejects.toThrow(/permission denied/);
    });
  });
});
