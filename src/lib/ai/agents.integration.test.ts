import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminClient } from '@/lib/data/admin';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { AgentProfileError, loadAgentProfile, loadAgentProfileTx, saveAgentProfile } from './agent-profile';
import { answerUnanswered, dismissUnanswered, listUnanswered, promoteToKnowledge, recordUnanswered } from './unanswered';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const contact = randomUUID(), conversation = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const viewerA: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const ownerB: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
const workerA = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: accountA }, fn, getWorkerPrisma());
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('AI agent profile, knowledge sources and unanswered questions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'AI agent test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Agents A',$2),($3,'Agents B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, admin, agent, viewer, accountB, outsider]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','14155550301')", [contact, accountA, agent]);
    await owner.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [conversation, accountA, agent, contact]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets admins write the agent profile and every member read it, per workspace', async () => {
    expect(await loadAgentProfile(viewerA)).toBeNull();
    const saved = await saveAgentProfile(adminA, {
      business_name: 'Chai Point', instructions: 'Be kind.', tone: 'friendly',
      handoff_rules: { keywords: ['Refund'], confidence_threshold: 0.6 }, complete_setup: true,
    });
    expect(saved).toMatchObject({ business_name: 'Chai Point', tone: 'friendly', handoff_rules: { keywords: ['refund'], confidence_threshold: 0.6, on_low_confidence: true } });
    expect(saved.setup_completed_at).not.toBeNull();
    // A partial update keeps other fields, merges rules and keeps the first setup time.
    const again = await saveAgentProfile(adminA, { greeting: 'Hi!', handoff_rules: { max_turns_before_handoff: 4 }, complete_setup: true });
    expect(again).toMatchObject({ business_name: 'Chai Point', greeting: 'Hi!', handoff_rules: { keywords: ['refund'], max_turns_before_handoff: 4 } });
    expect(again.setup_completed_at).toBe(saved.setup_completed_at);

    expect((await loadAgentProfile(viewerA))?.business_name).toBe('Chai Point');
    expect(await loadAgentProfile(ownerB)).toBeNull();
    expect((await workerA((tx) => loadAgentProfileTx(tx, accountA)))?.greeting).toBe('Hi!');

    await expect(saveAgentProfile(agentA, { business_name: 'Hijack' })).rejects.toBeInstanceOf(AgentProfileError);
    // RLS refuses the write even if a route forgot the role check.
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_agent_profiles SET business_name='Hijack' WHERE account_id=${accountA}::uuid`))
      .resolves.toBe(0);
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_agent_profiles(account_id) VALUES(${accountB}::uuid)`)).rejects.toThrow();
    await expect(owner.query("INSERT INTO ai_agent_profiles(account_id,instructions) VALUES($1,$2)", [accountB, 'x'.repeat(4001)])).rejects.toThrow();
  });

  it('keeps knowledge sources admin-write, member-read, and re-crawls pages in place', async () => {
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`
      INSERT INTO ai_knowledge_sources(account_id,kind,url,title) VALUES(${accountA}::uuid,'website','https://a.example','A')`)).rejects.toThrow();
    const [source] = await withTenant(adminA, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_knowledge_sources(account_id,kind,url,title,page_limit) VALUES(${accountA}::uuid,'website','https://a.example','A',10) RETURNING id::text`);
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`
      INSERT INTO ai_knowledge_sources(account_id,kind,title,page_limit) VALUES(${accountA}::uuid,'website','No url',10)`)).rejects.toThrow();
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`
      INSERT INTO ai_knowledge_sources(account_id,kind,url,title,page_limit) VALUES(${accountA}::uuid,'website','https://b.example','B',501)`)).rejects.toThrow();
    expect(await withTenant(viewerA, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM ai_knowledge_sources`)).toEqual([{ id: source.id }]);
    expect(await withTenant(ownerB, (tx) => tx.$queryRaw`SELECT id FROM ai_knowledge_sources`)).toEqual([]);

    // The worker crawls: the same page upserts into one document.
    const upsert = (content: string) => workerA((tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO ai_knowledge_documents(account_id,title,content,source_id,source_url,content_hash,fetched_at)
      VALUES(${accountA}::uuid,'Home',${content},${source.id}::uuid,'https://a.example/',${'a'.repeat(64)},now())
      ON CONFLICT (account_id,source_id,source_url) DO UPDATE SET content=EXCLUDED.content RETURNING id::text`);
    const [first] = await upsert('v1');
    const [second] = await upsert('v2');
    expect(second.id).toBe(first.id);
    await workerA((tx) => tx.$executeRaw`UPDATE ai_knowledge_sources SET status='ready', pages_indexed=1 WHERE id=${source.id}::uuid`);
    // Another workspace cannot attach a document to this source.
    await expect(withTenant(ownerB, (tx) => tx.$executeRaw`
      INSERT INTO ai_knowledge_documents(account_id,title,content,source_id) VALUES(${accountB}::uuid,'x','x',${source.id}::uuid)`)).rejects.toThrow();
    await withTenant(adminA, (tx) => tx.$executeRaw`DELETE FROM ai_knowledge_sources WHERE id=${source.id}::uuid`);
    expect((await owner.query('SELECT count(*)::int AS n FROM ai_knowledge_documents WHERE id=$1', [first.id])).rows[0].n).toBe(0);
  });

  it('records unanswered questions once per open question and only from the worker', async () => {
    const one = await workerA((tx) => recordUnanswered(tx, { accountId: accountA, question: 'Do you open on Sunday?', conversationId: conversation, contactId: contact }));
    const two = await workerA((tx) => recordUnanswered(tx, { accountId: accountA, question: 'do you OPEN on sunday ' }));
    expect(two).toEqual({ id: one!.id, occurrences: 2 });
    expect(await workerA((tx) => recordUnanswered(tx, { accountId: accountA, question: '🙏 !!' }))).toBeNull();
    await expect(withTenant(agentA, (tx) => recordUnanswered(tx, { accountId: accountA, question: 'Agent insert?' }))).rejects.toThrow();

    const list = await listUnanswered(agentA);
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: one!.id, occurrences: 2, question: 'do you OPEN on sunday', conversation_id: conversation, contact_id: contact });
    await expect(listUnanswered(viewerA)).rejects.toMatchObject({ status: 403 });
    // RLS hides the queue from viewers and from other workspaces even without the lib check.
    expect(await withTenant(viewerA, (tx) => tx.$queryRaw`SELECT id FROM ai_unanswered_questions`)).toEqual([]);
    expect(await withTenant(ownerB, (tx) => tx.$queryRaw`SELECT id FROM ai_unanswered_questions`)).toEqual([]);
    expect(await answerUnanswered(ownerB, one!.id, { answer: 'stolen' })).toBeNull();
    // The app role may not rewrite the question itself.
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`UPDATE ai_unanswered_questions SET question='x' WHERE id=${one!.id}::uuid`)).rejects.toThrow();

    const answered = await answerUnanswered(agentA, one!.id, { answer: 'Yes, 10 to 6.' });
    expect(answered).toMatchObject({ status: 'answered', answer: 'Yes, 10 to 6.', answered_by: agent });
    // Asked again after answering: a fresh open question.
    const three = await workerA((tx) => recordUnanswered(tx, { accountId: accountA, question: 'Do you open on Sunday?' }));
    expect(three!.id).not.toBe(one!.id);
    expect(await dismissUnanswered(agentA, three!.id)).toBe(true);
    expect(await dismissUnanswered(agentA, three!.id)).toBe(false);
    expect(await answerUnanswered(agentA, three!.id, { answer: 'late' })).toBeNull();
    expect((await listUnanswered(agentA, { status: 'dismissed' })).items.map((q) => q.id)).toEqual([three!.id]);

    // Deleting the conversation keeps the question.
    await owner.query('DELETE FROM conversations WHERE id=$1', [conversation]);
    expect((await listUnanswered(agentA, { status: 'answered' })).items[0]).toMatchObject({ id: one!.id, conversation_id: null });
  });

  it('promotes an answered question into the learning source and indexes it', async () => {
    const [q] = (await listUnanswered(agentA, { status: 'answered' })).items;
    const db = createAdminClient(adminA);
    await expect(promoteToKnowledge(agentA, q.id, db, q.answer)).rejects.toMatchObject({ status: 403 });
    const first = await promoteToKnowledge(adminA, q.id, db, q.answer);
    expect(first).toMatchObject({ indexed: true });
    const doc = (await owner.query('SELECT d.content, d.source_id::text, s.kind, s.pages_indexed FROM ai_knowledge_documents d JOIN ai_knowledge_sources s ON s.id=d.source_id WHERE d.id=$1', [first!.documentId])).rows[0];
    expect(doc).toEqual({ content: 'Question: do you OPEN on sunday\nAnswer: Yes, 10 to 6.', source_id: first!.sourceId, kind: 'learning', pages_indexed: 1 });
    expect((await owner.query('SELECT count(*)::int AS n FROM ai_knowledge_chunks WHERE document_id=$1', [first!.documentId])).rows[0].n).toBeGreaterThan(0);

    // Editing the answer and promoting again updates the same document.
    await answerUnanswered(agentA, q.id, { answer: 'Yes, 9 to 5.' });
    // The admin reviewed the old text: promoting it is refused and nothing changes.
    await expect(promoteToKnowledge(adminA, q.id, db, q.answer)).rejects.toMatchObject({ status: 409 });
    expect((await owner.query('SELECT content FROM ai_knowledge_documents WHERE id=$1', [first!.documentId])).rows[0].content).toContain('10 to 6');
    const second = await promoteToKnowledge(adminA, q.id, db, 'Yes, 9 to 5.');
    expect(second).toMatchObject({ documentId: first!.documentId, sourceId: first!.sourceId });
    expect((await owner.query('SELECT content FROM ai_knowledge_documents WHERE id=$1', [first!.documentId])).rows[0].content).toContain('9 to 5');
    expect((await owner.query("SELECT count(*)::int AS n FROM ai_knowledge_sources WHERE account_id=$1 AND kind='learning'", [accountA])).rows[0].n).toBe(1);
    expect(await promoteToKnowledge(ownerB, q.id, createAdminClient(ownerB), 'Yes, 9 to 5.')).toBeNull();
  });

  it('accepts the AI reply flow node and its run events', async () => {
    const flow = (await owner.query("INSERT INTO flows(account_id,user_id,name,trigger_type) VALUES($1,$2,'AI','manual') RETURNING id", [accountA, admin])).rows[0].id;
    await owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type) VALUES($1,$2,'ai','ai_reply')", [accountA, flow]);
    await expect(owner.query("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type) VALUES($1,$2,'bad','ai_magic')", [accountA, flow])).rejects.toThrow();
  });
});
