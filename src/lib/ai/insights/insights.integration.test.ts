// Phase 13 insights and knowledge access on PostgreSQL (real database, no AI
// provider: the deployment switch is off, so narratives come from the template).
// Requests commit their run and job together; runs are visible to their
// requester and admins only and never across workspaces; the worker rechecks
// the requester's live role; the app role cannot write results; source access
// changes keep the pairing CHECK and hide admin-only sources from agents.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { getSource, listSources, updateSourceAccess, KnowledgeSourceError } from '../knowledge-sources';
import { handleInsightRunJob } from './job';
import { getInsightRun, InsightError, listInsightRuns, requestInsight } from './runs';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), agent2 = randomUUID(), ownerBUser = randomUUID();
const adminA = { accountId: accountA, userId: admin, role: 'admin' as const };
const agentA = { accountId: accountA, userId: agent, role: 'agent' as const };
const agent2A = { accountId: accountA, userId: agent2, role: 'agent' as const };
const ownerB = { accountId: accountB, userId: ownerBUser, role: 'owner' as const };
const source = randomUUID();
let owner: pg.Client;

const code = async (p: Promise<unknown>) => {
  try { await p; return null } catch (e) { return e instanceof InsightError || e instanceof KnowledgeSourceError ? e.code : (e as Error).name }
};
const runRow = async (id: string) => (await owner.query('SELECT status, error_code, narrative_source, narrative, data, caveats FROM ai_insight_runs WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('phase 13 insights and knowledge access on PostgreSQL', { timeout: 120_000 }, () => {
  const savedSwitch = process.env.AI_ENABLED;

  beforeAll(async () => {
    process.env.AI_ENABLED = 'false';
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [admin, agent, agent2, ownerBUser];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Insight test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Ins A',$2),($3,'Ins B',$4)", [accountA, admin, accountB, ownerBUser]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent'),($5,$6,'owner')`,
      [accountA, admin, agent, agent2, accountB, ownerBUser]);
    await owner.query('INSERT INTO ai_workspace_settings(account_id, insights_enabled) VALUES($1,true),($2,true)', [accountA, accountB]);
    await owner.query(`INSERT INTO ai_knowledge_sources(id,account_id,kind,title,status) VALUES($1,$2,'text','Pricing notes','ready')`, [source, accountA]);
    await owner.query(`INSERT INTO ai_knowledge_documents(account_id,title,content,source_id) VALUES($1,'Pricing','internal margins',$2)`, [accountA, source]);
  });

  afterAll(async () => {
    if (savedSwitch === undefined) delete process.env.AI_ENABLED;
    else process.env.AI_ENABLED = savedSwitch;
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, agent2, ownerBUser]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('commits the run and its job together, visible to the requester and admins only', async () => {
    const run = await requestInsight(agentA, { key: 'conversation_volume', range: { preset: '30d' } });
    expect(run).toMatchObject({ status: 'queued', mine: true, data: null });
    const job = (await owner.query('SELECT type, payload, max_attempts FROM jobs WHERE dedupe_key=$1', [`ai-insight:${run.id}`])).rows[0];
    expect(job).toMatchObject({ type: 'ai.insight_run', payload: { runId: run.id }, max_attempts: 2 });
    expect((await owner.query("SELECT 1 FROM audit_logs WHERE account_id=$1 AND action='ai.insight_requested' AND resource_id=$2", [accountA, run.id])).rowCount).toBe(1);

    expect((await getInsightRun(adminA, run.id)).mine).toBe(false);
    expect(await code(getInsightRun(agent2A, run.id))).toBe('not_found');
    expect(await code(getInsightRun(ownerB, run.id))).toBe('not_found');
    expect((await listInsightRuns(agent2A)).map((r) => r.id)).not.toContain(run.id);
    expect((await listInsightRuns(ownerB))).toHaveLength(0);
  });

  it('never lets the app role write results or forge another requester', async () => {
    const run = await requestInsight(agentA, { key: 'flow_outcomes', range: { preset: '7d' } });
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_insight_runs SET status='done', narrative='x' WHERE id=${run.id}::uuid`))
      .rejects.toThrow();
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_insight_runs(account_id, requested_by, insight_key, range_from, range_to)
      VALUES (${accountA}::uuid, ${agent2}::uuid, 'flow_outcomes', '2026-10-01', '2026-10-02')`)).rejects.toThrow();
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_insight_runs(account_id, requested_by, insight_key, range_from, range_to)
      VALUES (${accountB}::uuid, ${agent}::uuid, 'flow_outcomes', '2026-10-01', '2026-10-02')`)).rejects.toThrow();
  });

  it('caps queued runs per workspace', async () => {
    // Two runs from the tests above are still queued.
    await requestInsight(adminA, { key: 'campaign_funnel', range: { preset: '7d' } });
    expect(await code(requestInsight(adminA, { key: 'campaign_funnel', range: { preset: '7d' } }))).toBe('too_many_pending');
    await owner.query("UPDATE ai_insight_runs SET status='done' WHERE account_id=$1", [accountA]);
  });

  it('expires orphaned queued/running runs so they never block new requests', async () => {
    // Three runs whose jobs were lost (worker crash on the last attempt), an hour old.
    await owner.query(`INSERT INTO ai_insight_runs(account_id, requested_by, insight_key, range_from, range_to, status, created_at)
      SELECT $1, $2, 'campaign_funnel', current_date - 7, current_date, s, now() - interval '1 hour'
      FROM unnest(ARRAY['running','running','queued']) s`, [accountA, adminA.userId]);
    const run = await requestInsight(adminA, { key: 'campaign_funnel', range: { preset: '7d' } });
    expect(run.status).toBe('queued');
    const stale = (await owner.query("SELECT status, error_code FROM ai_insight_runs WHERE account_id=$1 AND created_at < now() - interval '30 minutes'", [accountA])).rows;
    expect(stale).toHaveLength(3);
    expect(stale.every((r) => r.status === 'failed' && r.error_code === 'stale')).toBe(true);
    await owner.query("UPDATE ai_insight_runs SET status='done' WHERE account_id=$1 AND status IN ('queued','running')", [accountA]);
  });

  it('runs the fixed query on the worker and completes from the numbers with AI switched off', async () => {
    const run = await requestInsight(agentA, { key: 'agent_workload', range: { preset: '30d' } });
    await handleInsightRunJob(accountA, { runId: run.id });
    const row = await runRow(run.id);
    expect(row).toMatchObject({ status: 'done', error_code: 'deployment_off', narrative_source: 'template' });
    expect(row.data).toMatchObject({ rowCount: 0, metrics: { conversations_handled: 0 } });
    expect(row.caveats).toEqual(expect.arrayContaining(['csat_not_collected', 'low_sample']));
    expect((await getInsightRun(agentA, run.id)).status).toBe('done');
  });

  it('skips a requester demoted below agent before running anything', async () => {
    const run = await requestInsight(agent2A, { key: 'conversation_volume', range: { preset: '7d' } });
    await owner.query("UPDATE account_memberships SET role='viewer' WHERE account_id=$1 AND user_id=$2", [accountA, agent2]);
    await handleInsightRunJob(accountA, { runId: run.id });
    expect(await runRow(run.id)).toMatchObject({ status: 'skipped', error_code: 'no_permission', data: null, narrative: null });
    await owner.query("UPDATE account_memberships SET role='agent' WHERE account_id=$1 AND user_id=$2", [accountA, agent2]);
  });

  it('refuses requests while the workspace switch is off', async () => {
    await owner.query('UPDATE ai_workspace_settings SET insights_enabled=false WHERE account_id=$1', [accountA]);
    expect(await code(requestInsight(agentA, { key: 'conversation_volume', range: {} }))).toBe('feature_off');
    await owner.query('UPDATE ai_workspace_settings SET insights_enabled=true WHERE account_id=$1', [accountA]);
  });

  it('makes a knowledge source admin-only: hidden from agents, never customer-facing, audited', async () => {
    const updated = await updateSourceAccess(adminA, source, { min_role: 'admin' });
    expect(updated).toMatchObject({ min_role: 'admin', customer_facing: false });
    expect((await listSources(agentA)).map((s) => s.id)).not.toContain(source);
    expect(await getSource(agentA, source)).toBeNull();
    expect((await getSource(adminA, source))?.pages).toHaveLength(1);
    expect(await code(updateSourceAccess(adminA, source, { customer_facing: true }))).toBe('invalid_input');
    expect(await code(updateSourceAccess(agentA, source, { min_role: 'agent' }))).toBe('forbidden');
    // Another workspace's admin cannot touch it.
    expect(await code(updateSourceAccess(ownerB, source, { min_role: 'agent' }))).toBe('not_found');
    expect((await owner.query("SELECT 1 FROM audit_logs WHERE account_id=$1 AND action='ai.knowledge_access_updated'", [accountA])).rowCount).toBe(1);
    // The database refuses the invalid pair even past the app check.
    await expect(owner.query('UPDATE ai_knowledge_sources SET customer_facing=true WHERE id=$1', [source])).rejects.toThrow();
  });
});
