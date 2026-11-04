// Advisory assessments on PostgreSQL (real database, no AI provider): the job
// end to end on the worker with the deployment switch off (keyword result,
// zero provider calls), the supersede-and-insert contract and its race, RLS
// for agents, viewers and other tenants, the app role's lack of write access,
// and the manual refresh's tenant-scoped jobs row.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL), as test-db-local.cjs sets
// them; the suite is skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { writeAiSettings } from '../settings';
import { createFakeTransport, fakeCalls, resetFakeCalls, setAiTransportForTests } from '../providers/fake';
import { assessJobSlot, handleAssessConversationJob } from './job';
import { enqueueAssessmentForInbound } from './enqueue';
import {
  isUniqueViolation, queueAssessmentRefresh, readContactAssessments, readCrmFacts, readCurrentAssessment,
  replaceAssessment, type NewAssessment,
} from './repo';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), ownerBUser = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerBUser, role: 'owner' };
const workerA: TenantContext = { accountId: accountA, role: 'owner' };

let owner: pg.Client;
let contactA = '', conversationA = '', contactB = '', conversationB = '';

const row = (patch: Partial<NewAssessment> = {}): NewAssessment => ({
  accountId: accountA, contactId: contactA, conversationId: conversationA, intent: 'pricing', intentConfidence: 70,
  leadScore: 40, rationale: 'asks for prices', sourceMessageIds: [], source: 'model', model: 'test-model', promptVersion: 'assess.v1',
  qualification: {
    asked_price: true, purchase_intent: false, booking_intent: false, timeline_mentioned: false, budget_mentioned: false,
    decision_maker: false, complaint: false, evidence_message_ids: [], sensitive_categories: [], route_to_staff: false, flags: [],
  },
  ...patch,
});
const workerWrite = (r: NewAssessment) => withTenant(workerA, (tx) => replaceAssessment(tx, r), getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('advisory assessments on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const users = [admin, agent, viewer, ownerBUser];
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Assess test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Assess A',$2),($3,'Assess B',$4)", [accountA, admin, accountB, ownerBUser]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')`,
      [accountA, admin, agent, viewer, accountB, ownerBUser]);
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+919800000011','Asha') RETURNING id", [accountA, admin])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, admin, contactA])).rows[0].id;
    contactB = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+919800000012','Bo') RETURNING id", [accountB, ownerBUser])).rows[0].id;
    conversationB = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountB, ownerBUser, contactB])).rows[0].id;
    await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,status,created_at) VALUES
      ($1,$2,'agent','text','Hi! How can we help?','sent',now()-interval '2 minutes'),
      ($1,$2,'customer','text','How much is the blue mug? I want to buy two by Friday.','delivered',now()-interval '1 minute')`, [accountA, conversationA]);
  });

  afterAll(async () => {
    setAiTransportForTests(null);
    delete process.env.AI_ENABLED;
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, viewer, ownerBUser]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('the job does nothing while the workspace switch is off', async () => {
    await handleAssessConversationJob(accountA, { conversationId: conversationA });
    expect((await owner.query('SELECT count(*)::int AS n FROM ai_assessments WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
  });

  it('with the switch on and the deployment switch off, stores the keyword result with zero provider calls', async () => {
    await withTenant(adminA, (tx) => writeAiSettings(tx, { accountId: accountA, userId: admin }, { assessment_enabled: true }));
    process.env.AI_ENABLED = 'false';
    resetFakeCalls();
    setAiTransportForTests(createFakeTransport());
    try {
      await handleAssessConversationJob(accountA, { conversationId: conversationA });
    } finally {
      delete process.env.AI_ENABLED;
    }
    expect(fakeCalls()).toHaveLength(0);
    const current = await withTenant(agentA, (tx) => readCurrentAssessment(tx, accountA, conversationA));
    expect(current).toMatchObject({ source: 'deterministic', lead_score: null, contact_id: contactA, conversation_id: conversationA });
    expect(['purchase', 'pricing']).toContain(current!.intent);
    expect(current!.qualification).toMatchObject({ asked_price: true, purchase_intent: true, timeline_mentioned: true, route_to_staff: false });
    expect(current!.qualification.flags).toContain('fallback_deployment_off');
  });

  it('keeps exactly one current row per conversation; a racing insert is a unique violation', async () => {
    await workerWrite(row({ intent: 'booking' }));
    await workerWrite(row({ intent: 'purchase', leadScore: 66 }));
    const counts = (await owner.query(`SELECT count(*) FILTER (WHERE superseded_at IS NULL)::int AS current, count(*)::int AS total
      FROM ai_assessments WHERE account_id=$1 AND conversation_id=$2`, [accountA, conversationA])).rows[0];
    expect(counts.current).toBe(1);
    expect(counts.total).toBeGreaterThanOrEqual(3);
    expect(await withTenant(agentA, (tx) => readCurrentAssessment(tx, accountA, conversationA))).toMatchObject({ intent: 'purchase', lead_score: 66 });
    // A second writer that skipped the supersede (as a concurrent transaction would) hits the partial unique index.
    const error = await withTenant(workerA, (tx) => tx.$executeRaw`INSERT INTO ai_assessments(account_id, contact_id, conversation_id,
      intent, intent_confidence, qualification, rationale, source_message_ids, source, prompt_version)
      VALUES(${accountA}::uuid, ${contactA}::uuid, ${conversationA}::uuid, 'other', 10, '{}'::jsonb, '', '{}'::uuid[], 'deterministic', 'assess.v1')`,
    getWorkerPrisma()).catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
  });

  it('agents read their workspace\'s scores; viewers and other tenants read nothing', async () => {
    expect((await withTenant(agentA, (tx) => readContactAssessments(tx, accountA, [contactA, contactB]))).map((r) => r.contact_id)).toEqual([contactA]);
    expect(await withTenant(viewerA, (tx) => readCurrentAssessment(tx, accountA, conversationA))).toBeNull();
    expect(await withTenant(viewerA, (tx) => readContactAssessments(tx, accountA, [contactA]))).toEqual([]);
    expect(await withTenant(ownerB, (tx) => readContactAssessments(tx, accountA, [contactA]))).toEqual([]);
    expect(await withTenant(ownerB, (tx) => readCurrentAssessment(tx, accountB, conversationA))).toBeNull();
  });

  it('the app role cannot write assessments, even as an admin', async () => {
    await expect(withTenant(adminA, (tx) => replaceAssessment(tx, row()))).rejects.toThrow();
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`UPDATE ai_assessments SET lead_score=100 WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
  });

  it('the worker cannot write another tenant\'s assessment', async () => {
    await expect(workerWrite(row({ accountId: accountB, contactId: contactB, conversationId: conversationB }))).rejects.toThrow();
  });

  it('a manual refresh queues one tenant-scoped job per slot', async () => {
    const now = Date.now();
    expect(await withTenant(agentA, (tx) => queueAssessmentRefresh(tx, accountA, conversationA, now))).toBe('queued');
    expect(await withTenant(agentA, (tx) => queueAssessmentRefresh(tx, accountA, conversationA, now))).toBe('already_queued');
    const jobs = (await owner.query(`SELECT tenant_id::text AS tenant, payload, status FROM jobs WHERE type='ai.assess_conversation'
      AND dedupe_key LIKE $1`, [`ai-assess-manual:${conversationA}:%`])).rows;
    expect(jobs).toEqual([{ tenant: accountA, payload: { conversationId: conversationA }, status: 'pending' }]);
    // Another tenant cannot queue into this workspace.
    await expect(withTenant(ownerB, (tx) => queueAssessmentRefresh(tx, accountA, conversationA, now + 3_600_000))).rejects.toThrow();
    await owner.query("DELETE FROM jobs WHERE type='ai.assess_conversation' AND tenant_id=$1", [accountA]);
  });

  it('the inbound enqueue collapses a burst into one job per slot, run at the slot end', async () => {
    const now = Date.now();
    expect(await enqueueAssessmentForInbound(accountA, conversationA, now)).toBe(true);
    expect(await enqueueAssessmentForInbound(accountA, conversationA, now + 1)).toBe(true);
    const { dedupeKey, runAt } = assessJobSlot(conversationA, now);
    const jobs = (await owner.query('SELECT tenant_id::text AS tenant, run_at FROM jobs WHERE dedupe_key=$1', [dedupeKey])).rows;
    expect(jobs).toEqual([{ tenant: accountA, run_at: runAt }]);
    await owner.query('DELETE FROM jobs WHERE dedupe_key=$1', [dedupeKey]);
  });

  it('reads CRM facts for the lead score', async () => {
    const facts = await withTenant(workerA, (tx) => readCrmFacts(tx, accountA, contactA, conversationA), getWorkerPrisma());
    expect(facts.openDeal).toBe(false);
    expect(facts.customerMessages).toBe(1);
    expect(facts.lastInboundAt).toBeInstanceOf(Date);
  });
});
