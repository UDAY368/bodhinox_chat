// Phase 13 tenancy, RLS and grants on PostgreSQL (real database, no AI provider).
// T1 part: audience-aware knowledge RPCs and the document policy, the new
// assistant tables' row security and column grants for the app and worker
// roles, usage metering and the availability/budget checks. T5 part: the
// library writes under RLS (suggestion use, assessment replace), the insight
// job's live-membership recheck and the retention sweep, which never crosses
// workspaces.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { createScopedClient } from '@/lib/data/server';
import { createAdminClient } from '@/lib/data/admin';
import { retrieveKnowledge, retrieveKnowledgeScored } from './knowledge';
import { isAiFeatureAvailable, readAiSettings, writeAiSettings } from './settings';
import { AiWorkspaceCapError, requireAiBudget } from './budget';
import { incrementUsage } from '@/lib/billing/usage';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { insertSuggestions, recordSuggestionUse } from './assist/suggestions';
import { readCurrentAssessment, replaceAssessment, type NewAssessment } from './assess/repo';
import { handleInsightRunJob } from './insights/job';
import { AI_RETENTION, runAiRetentionSweep } from './retention';
import { aiUsageGroups } from './usage-summary';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), agent2 = randomUUID(), viewer = randomUUID(), ownerBUser = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const agent2A: TenantContext = { accountId: accountA, userId: agent2, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerBUser, role: 'owner' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };

let owner: pg.Client;
const src = { pub: randomUUID(), staff: randomUUID(), adminOnly: randomUUID(), disabled: randomUUID(), b: randomUUID() };
const chunk = { pub: randomUUID(), staff: randomUUID(), adminOnly: randomUUID(), disabled: randomUUID(), legacy: randomUUID(), b: randomUUID() };
const doc = { pub: randomUUID(), staff: randomUUID(), adminOnly: randomUUID(), disabled: randomUUID(), legacy: randomUUID(), b: randomUUID() };
let contactA = '', conversationA = '', messageA = '';
const vector = (v: number) => `[${Array(1536).fill(v).join(',')}]`;

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const fts = (ctx: TenantContext, audience: string, account = ctx.accountId, db = getPrisma()) =>
  withTenant(ctx, (tx) => tx.$queryRaw<{ id: string; document_id: string; source_id: string | null }[]>`
    SELECT id::text, document_id::text, source_id::text FROM match_ai_knowledge_fts_v2(${account}::uuid, 'warranty terms', 50, ${audience})`, db);
const semantic = (ctx: TenantContext, audience: string, db = getPrisma()) =>
  withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM match_ai_knowledge_semantic_v2(${ctx.accountId}::uuid, ${vector(0.1)}, 50, ${audience})`, db);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 13 AI tenancy on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [admin, agent, agent2, viewer, ownerBUser];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'AI test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'AI A',$2),($3,'AI B',$4)", [accountA, admin, accountB, ownerBUser]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($1,$5,'viewer'),($6,$7,'owner')`,
      [accountA, admin, agent, agent2, viewer, accountB, ownerBUser]);
    // Knowledge: one source per access class in A, one in B, and a legacy source-less document.
    await owner.query(`INSERT INTO ai_knowledge_sources(id,account_id,kind,title,status,min_role,customer_facing) VALUES
      ($1,$6,'text','Public','ready','agent',true), ($2,$6,'text','Staff notes','ready','agent',false),
      ($3,$6,'text','Admin only','ready','admin',false), ($4,$6,'text','Disabled','disabled','agent',true),
      ($5,$7,'text','Other tenant','ready','agent',true)`, [src.pub, src.staff, src.adminOnly, src.disabled, src.b, accountA, accountB]);
    for (const key of ['pub', 'staff', 'adminOnly', 'disabled', 'legacy', 'b'] as const) {
      const account = key === 'b' ? accountB : accountA;
      const source = key === 'legacy' ? null : src[key];
      await owner.query('INSERT INTO ai_knowledge_documents(id,account_id,title,content,source_id) VALUES($1,$2,$3,$4,$5)',
        [doc[key], account, `Doc ${key}`, `${key} warranty terms`, source]);
      await owner.query('INSERT INTO ai_knowledge_chunks(id,document_id,account_id,content,embedding) VALUES($1,$2,$3,$4,$5::vector)',
        [chunk[key], doc[key], account, `${key}: our warranty terms cover two years`, vector(0.1)]);
    }
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+919800000001','Asha') RETURNING id", [accountA, admin])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, admin, contactA])).rows[0].id;
    messageA = (await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status)
      VALUES($1,$2,'agent','text','Hello','sent') RETURNING id`, [accountA, conversationA])).rows[0].id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, agent2, viewer, ownerBUser]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('knowledge retrieval RPCs (v2)', () => {
    it('customer audience: only customer-facing agent sources and legacy documents, never another tenant', async () => {
      expect(ids(await fts(agentA, 'customer'))).toEqual([chunk.pub, chunk.legacy].sort());
      expect(ids(await fts(adminA, 'customer'))).toEqual([chunk.pub, chunk.legacy].sort());
      expect(ids(await semantic(agentA, 'customer'))).toEqual([chunk.pub, chunk.legacy].sort());
    });

    it('staff audience follows the live role: agents see staff notes, only admins see admin-only sources', async () => {
      expect(ids(await fts(agentA, 'staff'))).toEqual([chunk.pub, chunk.staff, chunk.legacy].sort());
      expect(ids(await fts(adminA, 'staff'))).toEqual([chunk.pub, chunk.staff, chunk.adminOnly, chunk.legacy].sort());
      expect(ids(await semantic(adminA, 'staff'))).toEqual([chunk.pub, chunk.staff, chunk.adminOnly, chunk.legacy].sort());
    });

    it('returns each chunk with its document and source', async () => {
      const row = (await fts(agentA, 'customer')).find((r) => r.id === chunk.pub)!;
      expect(row).toEqual({ id: chunk.pub, document_id: doc.pub, source_id: src.pub });
      expect((await fts(agentA, 'customer')).find((r) => r.id === chunk.legacy)?.source_id).toBeNull();
    });

    it('never crosses tenants, even when p_account_id names the other account', async () => {
      expect(await fts(agentA, 'customer', accountB)).toEqual([]);
      expect(await fts(adminA, 'staff', accountB)).toEqual([]);
      expect(ids(await fts(ownerB, 'customer'))).toEqual([chunk.b]);
    });

    it('refuses the staff audience on the worker and any unknown audience', async () => {
      await expect(fts(workerA, 'staff', accountA, getWorkerPrisma())).rejects.toThrow();
      expect(ids(await fts(workerA, 'customer', accountA, getWorkerPrisma()))).toEqual([chunk.pub, chunk.legacy].sort());
      await expect(fts(adminA, 'admin')).rejects.toThrow();
      await expect(fts(adminA, '')).rejects.toThrow();
    });

    it('the legacy v1 RPCs return only customer-facing knowledge, for the worker and an admin alike', async () => {
      // A rolled-back or still-draining old release grounds customer text through v1.
      const v1 = (ctx: TenantContext, db = getPrisma()) => withTenant(ctx, async (tx) => ({
        fts: await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM match_ai_knowledge_fts(${accountA}::uuid, 'warranty terms', 50)`,
        sem: await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM match_ai_knowledge_semantic(${accountA}::uuid, ${vector(0.1)}, 50)`,
      }), db);
      for (const out of [await v1(workerA, getWorkerPrisma()), await v1(agentA), await v1(adminA)]) {
        expect(ids(out.fts)).toEqual([chunk.pub, chunk.legacy].sort());
        expect(ids(out.sem)).toEqual([chunk.pub, chunk.legacy].sort());
      }
    });

    it('the library passes the audience through the RPC contract, with citations', async () => {
      const agentDb = createScopedClient(agentA);
      const out = await retrieveKnowledgeScored(agentDb, accountA, { embeddingsApiKey: null }, 'warranty terms', 10, 'staff');
      expect(out.chunks.map((c) => c.id).sort()).toEqual([chunk.pub, chunk.staff, chunk.legacy].sort());
      expect(out.citations.find((c) => c.chunk_id === chunk.pub)).toEqual({ chunk_id: chunk.pub, document_id: doc.pub, source_id: src.pub, title: 'Doc pub', source_url: null });
      // Auto-reply and flow-reply run on the worker with the (default) customer audience.
      const worker = createAdminClient({ accountId: accountA, role: 'owner' });
      expect((await retrieveKnowledge(worker, accountA, { embeddingsApiKey: null }, 'warranty terms', 10)).length).toBe(2);
      // A worker asking for staff knowledge gets nothing (the database refuses, retrieval degrades).
      expect(await retrieveKnowledge(worker, accountA, { embeddingsApiKey: null }, 'warranty terms', 10, 'staff')).toEqual([]);
    });
  });

  describe('document policy', () => {
    const docs = (ctx: TenantContext) => withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM ai_knowledge_documents`);
    it('hides admin-only sources from agents and viewers, as before for everything else', async () => {
      const agentDocs = ids(await docs(agentA));
      expect(agentDocs).toEqual([doc.pub, doc.staff, doc.disabled, doc.legacy].sort());
      expect(ids(await docs(viewerA))).toEqual(agentDocs);
      expect(ids(await docs(adminA))).toEqual([doc.pub, doc.staff, doc.adminOnly, doc.disabled, doc.legacy].sort());
      expect(ids(await docs(ownerB))).toEqual([doc.b]);
    });

    it('rejects an admin-only source that grounds customer text', async () => {
      await expect(owner.query("UPDATE ai_knowledge_sources SET customer_facing=true WHERE id=$1", [src.adminOnly])).rejects.toThrow(/customer_role_check/);
    });
  });

  describe('ai_workspace_settings', () => {
    it('is off by default, admin-written, worker read-only and per tenant', async () => {
      expect(await withTenant(agentA, (tx) => readAiSettings(tx, accountA))).toMatchObject({ summaries_enabled: false, monthly_token_cap: null });
      await expect(withTenant(agentA, (tx) => writeAiSettings(tx, { accountId: accountA, userId: agent }, { summaries_enabled: true }))).rejects.toThrow();
      const saved = await withTenant(adminA, (tx) => writeAiSettings(tx, { accountId: accountA, userId: admin }, { summaries_enabled: true, monthly_token_cap: 1000 }));
      expect(saved).toMatchObject({ summaries_enabled: true, suggestions_enabled: false, monthly_token_cap: 1000 });
      expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='ai.settings_updated'", [accountA])).rows[0].n).toBe(1);
      // An admin cannot record someone else as the editor.
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE ai_workspace_settings SET updated_by=${agent}::uuid WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
      expect(await withTenant(workerA, (tx) => readAiSettings(tx, accountA), getWorkerPrisma())).toMatchObject({ summaries_enabled: true });
      await expect(withTenant(workerA, (tx) => tx.$executeRaw`UPDATE ai_workspace_settings SET insights_enabled=true WHERE account_id=${accountA}::uuid`, getWorkerPrisma())).rejects.toThrow();
      expect(await withTenant(ownerB, (tx) => readAiSettings(tx, accountB))).toMatchObject({ summaries_enabled: false });
      expect(await withTenant(ownerB, (tx) => tx.$queryRaw<unknown[]>`SELECT 1 FROM ai_workspace_settings WHERE account_id=${accountA}::uuid`)).toEqual([]);
    });
  });

  describe('ai_suggestions', () => {
    const insert = (ctx: TenantContext, createdBy: string, extra = '') => withTenant(ctx, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ai_suggestions(account_id,conversation_id,kind,output,prompt_version,created_by${extra ? ',' + extra.split('=')[0] : ''})
       VALUES($1::uuid,$2::uuid,'reply','{"text":"Hi"}'::jsonb,'suggest.v1',$3::uuid${extra ? ',' + extra.split('=')[1] : ''}) RETURNING id::text`,
      accountA, conversationA, createdBy));

    it('agents insert as themselves only; viewers and other tenants cannot', async () => {
      const [row] = await insert(agentA, agent);
      expect(row.id).toBeTruthy();
      await expect(insert(agentA, agent2)).rejects.toThrow();
      await expect(insert(viewerA, viewer)).rejects.toThrow();
      await expect(insert(agentA, agent, "status='accepted'")).rejects.toThrow();
      expect(await withTenant(viewerA, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_suggestions`)).toEqual([]);
      expect(await withTenant(ownerB, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_suggestions`)).toEqual([]);
    });

    it('agents decide a shown suggestion as themselves, never rewrite output, never re-decide', async () => {
      const [row] = await insert(agentA, agent);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_suggestions SET output='{"text":"forged"}'::jsonb WHERE id=${row.id}::uuid`)).rejects.toThrow(/permission/);
      await expect(withTenant(agent2A, (tx) => tx.$executeRaw`UPDATE ai_suggestions SET status='rejected', decided_by=${agent}::uuid, decided_at=now() WHERE id=${row.id}::uuid`)).rejects.toThrow();
      expect(await withTenant(agent2A, (tx) => tx.$executeRaw`UPDATE ai_suggestions SET status='accepted', decided_by=${agent2}::uuid, decided_at=now(),
        sent_message_id=${messageA}::uuid, edit_distance=0 WHERE id=${row.id}::uuid`)).toBe(1);
      // Already decided: the USING clause no longer matches.
      expect(await withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_suggestions SET status='rejected', decided_by=${agent}::uuid WHERE id=${row.id}::uuid`)).toBe(0);
      // Deleting the sent message clears the link (ON DELETE SET NULL).
      expect((await owner.query('SELECT sent_message_id FROM ai_suggestions WHERE id=$1', [row.id])).rows[0].sent_message_id).toBe(messageA);
    });

    it('the worker has full access in its tenant only', async () => {
      const [row] = await withTenant(workerA, (tx) => tx.$queryRaw<{ id: string }[]>`INSERT INTO ai_suggestions(account_id,conversation_id,kind,output,prompt_version,created_by)
        VALUES(${accountA}::uuid,${conversationA}::uuid,'summary','{}'::jsonb,'summary.v1',${admin}::uuid) RETURNING id::text`, getWorkerPrisma());
      expect(await withTenant(workerA, (tx) => tx.$executeRaw`UPDATE ai_suggestions SET output='{}'::jsonb, citations='[]'::jsonb WHERE id=${row.id}::uuid`, getWorkerPrisma())).toBe(1);
      expect(await withTenant({ accountId: accountB, role: 'owner' }, (tx) => tx.$executeRaw`DELETE FROM ai_suggestions WHERE id=${row.id}::uuid`, getWorkerPrisma())).toBe(0);
      expect(await withTenant(workerA, (tx) => tx.$executeRaw`DELETE FROM ai_suggestions WHERE id=${row.id}::uuid`, getWorkerPrisma())).toBe(1);
    });
  });

  describe('ai_assessments', () => {
    const write = (db = getWorkerPrisma(), ctx: TenantContext = workerA) => withTenant(ctx, (tx) => tx.$executeRaw`INSERT INTO ai_assessments(account_id,contact_id,conversation_id,intent,intent_confidence,
      lead_score,qualification,rationale,source_message_ids,source,prompt_version)
      VALUES(${accountA}::uuid,${contactA}::uuid,${conversationA}::uuid,'pricing',80,60,'{}'::jsonb,'asked for price',ARRAY[]::uuid[],'deterministic','assess.v1')`, db);

    it('only the worker writes; agents read; viewers and other tenants see nothing; one current row per conversation', async () => {
      await expect(write(getPrisma(), agentA)).rejects.toThrow();
      expect(await write()).toBe(1);
      await expect(write()).rejects.toThrow(/ai_assessments_current_key/);
      expect(await withTenant(agentA, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_assessments`)).toHaveLength(1);
      expect(await withTenant(viewerA, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_assessments`)).toEqual([]);
      expect(await withTenant(ownerB, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_assessments`)).toEqual([]);
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE ai_assessments SET lead_score=100`)).rejects.toThrow(/permission/);
      // Supersede then insert in one transaction.
      await withTenant(workerA, async (tx) => {
        await tx.$executeRaw`UPDATE ai_assessments SET superseded_at=now() WHERE account_id=${accountA}::uuid AND conversation_id=${conversationA}::uuid AND superseded_at IS NULL`;
        await tx.$executeRaw`INSERT INTO ai_assessments(account_id,contact_id,conversation_id,intent,intent_confidence,qualification,rationale,source_message_ids,source,prompt_version)
          VALUES(${accountA}::uuid,${contactA}::uuid,${conversationA}::uuid,'booking',70,'{}'::jsonb,'r',ARRAY[]::uuid[],'model','assess.v1')`;
      }, getWorkerPrisma());
      expect(await withTenant(agentA, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_assessments WHERE superseded_at IS NULL`)).toHaveLength(1);
    });
  });

  describe('ai_insight_runs', () => {
    const request = (ctx: TenantContext, by: string, extra = '') => withTenant(ctx, (tx) => tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ai_insight_runs(account_id,requested_by,insight_key,range_from,range_to${extra ? ',data' : ''})
       VALUES($1::uuid,$2::uuid,'conversation_volume','2026-10-01','2026-10-31'${extra ? `,'${extra}'::jsonb` : ''}) RETURNING id::text`, accountA, by));

    it('members request their own queued runs; requesters and admins read them; the worker completes them', async () => {
      const [mine] = await request(agentA, agent);
      await expect(request(agentA, agent2)).rejects.toThrow();
      await expect(request(viewerA, viewer)).rejects.toThrow();
      await expect(request(agentA, agent, '{"x":1}')).rejects.toThrow(/permission/);
      expect(ids(await withTenant(agentA, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM ai_insight_runs`))).toEqual([mine.id]);
      expect(await withTenant(agent2A, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_insight_runs`)).toEqual([]);
      expect(ids(await withTenant(adminA, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM ai_insight_runs`))).toEqual([mine.id]);
      expect(await withTenant(ownerB, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM ai_insight_runs`)).toEqual([]);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_insight_runs SET status='done' WHERE id=${mine.id}::uuid`)).rejects.toThrow(/permission/);
      expect(await withTenant(workerA, (tx) => tx.$executeRaw`UPDATE ai_insight_runs SET status='skipped', error_code='feature_off', completed_at=now() WHERE id=${mine.id}::uuid`, getWorkerPrisma())).toBe(1);
      await expect(owner.query("INSERT INTO ai_insight_runs(account_id,requested_by,insight_key,range_from,range_to) VALUES($1,$2,'free_sql','2026-10-01','2026-10-02')", [accountA, agent])).rejects.toThrow();
    });
  });

  describe('usage metering, availability and budget', () => {
    it('logs the new modes and meters ai_tokens', async () => {
      await withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_usage_log(account_id,mode,provider,model,total_tokens) VALUES(${accountA}::uuid,'summary','openai','gpt-x',10)`);
      await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_usage_log(account_id,mode,provider,model) VALUES(${accountA}::uuid,'flow_reply','openai','m')`)).rejects.toThrow();
      expect(await withTenant(workerA, (tx) => incrementUsage(tx, 'ai_tokens', 600), getWorkerPrisma())).toBe(600);
    });

    it('reports feature_off, not_configured, then ok; and refuses over the caps before any call', async () => {
      const check = (feature: 'summary' | 'insights') => withTenant(agentA, (tx) => isAiFeatureAvailable(tx, agentA, feature), getWorkerPrisma());
      expect(await check('insights')).toEqual({ ok: false, reason: 'feature_off' });
      expect(await check('summary')).toEqual({ ok: false, reason: 'not_configured' });
      await owner.query("INSERT INTO ai_configs(account_id,provider,model,api_key,is_active) VALUES($1,'openai','gpt-x','encrypted-placeholder',true)", [accountA]);
      // 600 used of the workspace cap of 1000 set above.
      expect(await check('summary')).toEqual({ ok: true });
      await expect(requireAiBudget(accountA, 'summary', 300)).resolves.toBeUndefined();
      await expect(requireAiBudget(accountA, 'summary', 500)).rejects.toBeInstanceOf(AiWorkspaceCapError);
      // A plan limit below the usage refuses too (workspace on the enterprise default plan here).
      await owner.query("INSERT INTO account_subscriptions(account_id,plan_id,status) VALUES($1,'free','active') ON CONFLICT DO NOTHING", [accountA]).catch(() => undefined);
      await owner.query(`UPDATE plans SET limits = limits || '{"ai_tokens_monthly":500}'::jsonb WHERE id IN ('free','enterprise')`);
      try {
        await expect(requireAiBudget(accountA, 'summary', 1)).rejects.toBeInstanceOf(PlanLimitError);
        expect(await check('summary')).toEqual({ ok: false, reason: 'quota' });
      } finally {
        await owner.query(`UPDATE plans SET limits = limits || '{"ai_tokens_monthly":null}'::jsonb WHERE id IN ('free','enterprise')`);
      }
      // A restricted role is refused without reading anything else.
      await owner.query("INSERT INTO role_permission_restrictions(account_id,role,permission) VALUES($1,'agent','ai.assist')", [accountA]);
      expect(await check('summary')).toEqual({ ok: false, reason: 'no_permission' });
    });

    it('aggregates usage in SQL per local day, mode and model, for admins of the workspace only', async () => {
      // Ten days ago (well inside retention), at fixed UTC times of day.
      const base = new Date(Date.now() - 10 * 86_400_000);
      const day = (offset: number) => new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offset)).toISOString().slice(0, 10);
      const at = (time: string) => new Date(`${time.startsWith('+') ? day(1) : day(0)}T${time.replace('+', '')}:00Z`);
      const insert = (ctx: TenantContext, mode: string, total: number, created: string) => withTenant(ctx, (tx) => tx.$executeRaw`
        INSERT INTO ai_usage_log(account_id,mode,provider,model,prompt_tokens,completion_tokens,total_tokens,created_at)
        VALUES(${ctx.accountId}::uuid,${mode},'grouptest','gpt-g',${total - 1},1,${total},${at(created)})`, getWorkerPrisma());
      await insert(workerA, 'auto_reply', 10, '23:30');
      await insert(workerA, 'auto_reply', 20, '23:40');
      await insert(workerA, 'draft', 5, '23:50');
      await insert(workerA, 'auto_reply', 7, '+00:10');
      await insert(ownerB, 'auto_reply', 1000, '23:30');
      const mine = (rows: Awaited<ReturnType<typeof aiUsageGroups>>) => rows.filter((r) => r.provider === 'grouptest');
      const since = new Date(`${day(-1)}T00:00:00Z`);
      expect(mine(await withTenant(adminA, (tx) => aiUsageGroups(tx, accountA, since, 'UTC')))).toEqual([
        { day: day(0), mode: 'auto_reply', provider: 'grouptest', model: 'gpt-g', calls: 2, prompt_tokens: 28, completion_tokens: 2, total_tokens: 30 },
        { day: day(0), mode: 'draft', provider: 'grouptest', model: 'gpt-g', calls: 1, prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        { day: day(1), mode: 'auto_reply', provider: 'grouptest', model: 'gpt-g', calls: 1, prompt_tokens: 6, completion_tokens: 1, total_tokens: 7 },
      ]);
      // Days follow the requested zone: 23:30 UTC is already the next day in Kolkata (UTC+5:30).
      const kolkata = mine(await withTenant(adminA, (tx) => aiUsageGroups(tx, accountA, since, 'Asia/Kolkata')));
      expect(kolkata.map((r) => [r.day, r.mode, r.calls])).toEqual([[day(1), 'auto_reply', 3], [day(1), 'draft', 1]]);
      // Another workspace's rows never count, even when its id is passed, and an agent reads nothing.
      expect(mine(await withTenant(adminA, (tx) => aiUsageGroups(tx, accountB, since, 'UTC')))).toEqual([]);
      expect(mine(await withTenant(agentA, (tx) => aiUsageGroups(tx, accountA, since, 'UTC')))).toEqual([]);
    });

    it('the retention scheduler function runs for the worker only', async () => {
      await expect(getWorkerPrisma().$queryRaw`SELECT * FROM crm_accounts_with_ai_retention_due()`).resolves.toBeInstanceOf(Array);
      await expect(getPrisma().$queryRaw`SELECT * FROM crm_accounts_with_ai_retention_due()`).rejects.toThrow();
    });
  });

  describe('library writes under RLS (T5)', () => {
    it('records a suggestion use as the sending agent only, in its own workspace', async () => {
      const [id] = await withTenant(agentA, (tx) => insertSuggestions(tx, { accountId: accountA, userId: agent },
        [{ conversationId: conversationA, kind: 'reply', output: { text: 'Hello there' }, promptVersion: 'replies.v1' }]));
      const use = (ctx: TenantContext & { userId: string }) =>
        recordSuggestionUse(ctx, { suggestionId: id, conversationId: conversationA, messageId: messageA, sentText: 'Hello there!' });
      expect(await use({ ...ownerB, userId: ownerBUser })).toBeNull();
      expect(await use({ ...viewerA, userId: viewer })).toBeNull();
      expect(await use({ ...agent2A, userId: agent2 })).toEqual({ status: 'edited', editDistance: expect.any(Number) });
      const row = (await owner.query('SELECT status, decided_by, sent_message_id FROM ai_suggestions WHERE id=$1', [id])).rows[0];
      expect(row).toEqual({ status: 'edited', decided_by: agent2, sent_message_id: messageA });
      // Decided once: a second use matches nothing.
      expect(await use({ ...agentA, userId: agent })).toBeNull();
      expect((await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='ai.suggestion_used'", [accountA])).rows[0].n).toBe(1);
    });

    it('replaces an assessment on the worker; agents read the current one, other workspaces none', async () => {
      const row = (intent: NewAssessment['intent']): NewAssessment => ({
        accountId: accountA, contactId: contactA, conversationId: conversationA, intent, intentConfidence: 70, leadScore: 40,
        qualification: { asked_price: true, purchase_intent: false, booking_intent: false, timeline_mentioned: false, budget_mentioned: false,
          decision_maker: false, complaint: false, evidence_message_ids: [], sensitive_categories: [], route_to_staff: false, flags: [] },
        rationale: 'Asked for a price.', sourceMessageIds: [messageA], source: 'model', model: 'gpt-x', promptVersion: 'assess.v1',
      });
      await withTenant(workerA, (tx) => replaceAssessment(tx, row('pricing')), getWorkerPrisma());
      await withTenant(workerA, (tx) => replaceAssessment(tx, row('purchase')), getWorkerPrisma());
      expect(await withTenant(agentA, (tx) => readCurrentAssessment(tx, accountA, conversationA))).toMatchObject({ intent: 'purchase', lead_score: 40 });
      expect(await withTenant(ownerB, (tx) => readCurrentAssessment(tx, accountA, conversationA))).toBeNull();
      await expect(withTenant(adminA, (tx) => replaceAssessment(tx, row('other')))).rejects.toThrow();
    });

    it('the insight job skips a requester demoted since the request, with no provider call', async () => {
      const [run] = await withTenant(agent2A, (tx) => tx.$queryRaw<{ id: string }[]>`INSERT INTO ai_insight_runs(account_id,requested_by,insight_key,range_from,range_to)
        VALUES(${accountA}::uuid,${agent2}::uuid,'conversation_volume','2026-10-01','2026-10-31') RETURNING id::text`);
      await owner.query("UPDATE account_memberships SET role='viewer' WHERE account_id=$1 AND user_id=$2", [accountA, agent2]);
      const runTask = async (): Promise<never> => { throw new Error('no provider call expected'); };
      try {
        await handleInsightRunJob(accountA, { runId: run.id }, { attempts: 1, maxAttempts: 2 }, { runTask });
      } finally {
        await owner.query("UPDATE account_memberships SET role='agent' WHERE account_id=$1 AND user_id=$2", [accountA, agent2]);
      }
      expect((await owner.query('SELECT status, error_code, narrative FROM ai_insight_runs WHERE id=$1', [run.id])).rows[0])
        .toEqual({ status: 'skipped', error_code: 'no_permission', narrative: null });
    });
  });

  describe('retention sweep (T5)', () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    const workerB: TenantContext = { accountId: accountB, role: 'owner' };
    let contactA2 = '', conversationA2 = '', conversationB = '';
    const seeded: Record<string, string> = {};

    const suggestion = (ctx: TenantContext, conversation: string, by: string, created: Date) => withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_suggestions(account_id,conversation_id,kind,output,citations,guard_flags,prompt_version,created_by,created_at)
      VALUES(${ctx.accountId}::uuid,${conversation}::uuid,'reply','{"text":"Old suggestion"}'::jsonb,
        '[{"chunk_id":"c","document_id":"d","source_id":null,"title":"t","source_url":null}]'::jsonb,ARRAY['pii_redacted'],'replies.v1',${by}::uuid,${created})
      RETURNING id::text`, getWorkerPrisma()).then((r) => r[0].id);
    const assessment = (created: Date, superseded: Date | null) => withTenant(workerA, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_assessments(account_id,contact_id,conversation_id,intent,intent_confidence,qualification,rationale,source_message_ids,source,prompt_version,created_at,superseded_at)
      VALUES(${accountA}::uuid,${contactA2}::uuid,${conversationA2}::uuid,'pricing',60,'{}'::jsonb,'',ARRAY[]::uuid[],'deterministic','assess.v1',${created},${superseded}::timestamptz)
      RETURNING id::text`, getWorkerPrisma()).then((r) => r[0].id);
    const insight = (ctx: TenantContext, by: string, created: Date) => withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_insight_runs(account_id,requested_by,insight_key,range_from,range_to,status,created_at)
      VALUES(${ctx.accountId}::uuid,${by}::uuid,'flow_outcomes','2026-01-01','2026-01-31','done',${created}) RETURNING id::text`, getWorkerPrisma()).then((r) => r[0].id);
    const usage = (ctx: TenantContext, created: Date) => withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_usage_log(account_id,mode,provider,model,total_tokens,created_at)
      VALUES(${ctx.accountId}::uuid,'draft','openai','gpt-x',5,${created}) RETURNING id::text`, getWorkerPrisma()).then((r) => r[0].id);
    const exists = async (table: string, id: string) =>
      (await owner.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount === 1;

    beforeAll(async () => {
      contactA2 = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+919800000003','Chitra') RETURNING id", [accountA, admin])).rows[0].id;
      conversationA2 = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, admin, contactA2])).rows[0].id;
      const contactB = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+919800000002','Bina') RETURNING id", [accountB, ownerBUser])).rows[0].id;
      conversationB = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountB, ownerBUser, contactB])).rows[0].id;
      seeded.sRecent = await suggestion(workerA, conversationA2, agent, daysAgo(1));
      seeded.sMid = await suggestion(workerA, conversationA2, agent, daysAgo(AI_RETENTION.suggestionContentDays + 10));
      seeded.sOld = await suggestion(workerA, conversationA2, agent, daysAgo(AI_RETENTION.suggestionRowDays + 20));
      seeded.aCurrentOld = await assessment(daysAgo(AI_RETENTION.assessmentDays + 5), null);
      seeded.aSupersededOld = await assessment(daysAgo(60), daysAgo(AI_RETENTION.supersededAssessmentDays + 5));
      seeded.aSupersededRecent = await assessment(daysAgo(10), daysAgo(5));
      seeded.iOld = await insight(workerA, agent, daysAgo(AI_RETENTION.insightRunDays + 5));
      seeded.iRecent = await insight(workerA, agent, daysAgo(3));
      seeded.uOld = await usage(workerA, daysAgo(AI_RETENTION.usageLogDays + 5));
      seeded.uRecent = await usage(workerA, daysAgo(2));
      seeded.bSuggestionOld = await suggestion(workerB, conversationB, ownerBUser, daysAgo(AI_RETENTION.suggestionRowDays + 20));
      seeded.bInsightOld = await insight(workerB, ownerBUser, daysAgo(AI_RETENTION.insightRunDays + 5));
      seeded.bUsageOld = await usage(workerB, daysAgo(AI_RETENTION.usageLogDays + 5));
    });

    it('lists both workspaces as due, through the worker-only definer function', async () => {
      const due = (await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text FROM crm_accounts_with_ai_retention_due()`)
        .map((r) => r.account_id);
      expect(due).toEqual(expect.arrayContaining([accountA, accountB]));
    });

    it('applies every rule to one workspace and never touches another', async () => {
      const result = await runAiRetentionSweep(accountA);
      expect(result).toMatchObject({ suggestionsDeleted: 1, suggestionsCleared: 1, assessmentsDeleted: 2, insightRunsDeleted: 1, usageLogDeleted: 1 });
      expect(await exists('ai_suggestions', seeded.sOld)).toBe(false);
      const mid = (await owner.query('SELECT output, citations, status, guard_flags FROM ai_suggestions WHERE id=$1', [seeded.sMid])).rows[0];
      expect(mid).toEqual({ output: {}, citations: [], status: 'shown', guard_flags: ['pii_redacted'] });
      expect((await owner.query('SELECT output FROM ai_suggestions WHERE id=$1', [seeded.sRecent])).rows[0].output).toEqual({ text: 'Old suggestion' });
      expect(await exists('ai_assessments', seeded.aCurrentOld)).toBe(false);
      expect(await exists('ai_assessments', seeded.aSupersededOld)).toBe(false);
      expect(await exists('ai_assessments', seeded.aSupersededRecent)).toBe(true);
      expect(await exists('ai_insight_runs', seeded.iOld)).toBe(false);
      expect(await exists('ai_insight_runs', seeded.iRecent)).toBe(true);
      expect(await exists('ai_usage_log', seeded.uOld)).toBe(false);
      expect(await exists('ai_usage_log', seeded.uRecent)).toBe(true);
      // Workspace B's equally old rows are untouched.
      for (const [table, id] of [['ai_suggestions', seeded.bSuggestionOld], ['ai_insight_runs', seeded.bInsightOld], ['ai_usage_log', seeded.bUsageOld]])
        expect(await exists(table, id), table).toBe(true);
      // Nothing left to do: a second sweep changes nothing, and A is no longer due while B still is.
      expect(await runAiRetentionSweep(accountA)).toEqual({ suggestionsDeleted: 0, suggestionsCleared: 0, assessmentsDeleted: 0, insightRunsDeleted: 0, usageLogDeleted: 0, replyEventsDeleted: 0 });
      const due = (await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text FROM crm_accounts_with_ai_retention_due()`).map((r) => r.account_id);
      expect(due).not.toContain(accountA);
      expect(due).toContain(accountB);
    });

    it('the app role cannot run the sweep statements', async () => {
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`DELETE FROM ai_usage_log WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
      await expect(withTenant(adminA, (tx) => tx.$executeRaw`DELETE FROM ai_insight_runs WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
      expect(await exists('ai_insight_runs', seeded.iRecent)).toBe(true);
    });
  });
});
