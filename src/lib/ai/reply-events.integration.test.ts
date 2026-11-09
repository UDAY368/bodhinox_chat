// AI activity log (ai_reply_events) on PostgreSQL: the worker records rows,
// admins of the same workspace read them, agents and other workspaces never
// do, the app role cannot write, a deleted conversation takes its rows, and
// the retention sweep deletes rows older than 90 days in one workspace only.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL) or .env.test; the suite is
// skipped without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { AI_RETENTION, runAiRetentionSweep } from './retention';
import { MAX_CUSTOMER_TEXT_CHARS, decodeActivityCursor, getReplyEvent, listReplyEvents, recordReplyEvent } from './reply-events';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), ownerBUser = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerBUser, role: 'owner' };
const phone = `+9198${String(Date.now()).slice(-8)}`;
let owner: pg.Client;
let contactA = '', contactA2 = '', conversationA = '', conversationA2 = '';

const rowsOf = async (account: string) =>
  (await owner.query('SELECT id::text, outcome, reason, customer_text FROM ai_reply_events WHERE account_id=$1 ORDER BY created_at', [account])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('AI activity log on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Activity test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[admin, agent, ownerBUser]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Activity A',$2),($3,'Activity B',$4)", [accountA, admin, accountB, ownerBUser]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, admin, agent, accountB, ownerBUser]);
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [accountA, admin, phone])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, admin, contactA])).rows[0].id;
    // One conversation per contact and number (idx_conversations_wa_contact_number), so the second needs its own contact.
    contactA2 = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Ravi') RETURNING id", [accountA, admin, phone.slice(0, -1) + (Number(phone.slice(-1)) + 1) % 10])).rows[0].id;
    conversationA2 = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, admin, contactA2])).rows[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, ownerBUser]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('records a capped row on the worker role and lets an admin of the workspace read it', async () => {
    await recordReplyEvent({
      accountId: accountA, conversationId: conversationA, contactId: contactA, inboundMessageId: 'wamid.test-1',
      outcome: 'replied', reason: 'answered', customerText: 'q'.repeat(MAX_CUSTOMER_TEXT_CHARS + 500), replyText: 'We ship worldwide.',
      sources: [{ document_id: randomUUID(), title: 'Shipping FAQ' }], confidence: 0.8, provider: 'openai', model: 'gpt-test',
      promptTokens: 100, completionTokens: 20, totalTokens: 120, latencyMs: 1500,
    });
    const [stored] = await rowsOf(accountA);
    expect(stored).toMatchObject({ outcome: 'replied', reason: 'answered' });
    expect(stored.customer_text).toHaveLength(MAX_CUSTOMER_TEXT_CHARS);

    const page = await listReplyEvents(adminA, { limit: 10 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      contact: { id: contactA, name: 'Asha', phone }, outcome: 'replied', has_reply: true, total_tokens: 120, latency_ms: 1500,
    });
    expect(page.events[0].preview).toHaveLength(160);
    const detail = await getReplyEvent(adminA, stored.id);
    expect(detail).toMatchObject({ reply_text: 'We ship worldwide.', confidence: 0.8, prompt_tokens: 100, sources: [{ title: 'Shipping FAQ' }] });
  });

  it('pages with a keyset cursor and filters by outcome and reason', async () => {
    await recordReplyEvent({ accountId: accountA, conversationId: conversationA, contactId: contactA, outcome: 'handed_off', reason: 'guard_blocked', guardFlags: ['claim_refund'] });
    await recordReplyEvent({ accountId: accountA, conversationId: conversationA, contactId: contactA, outcome: 'skipped', reason: 'reply_cap' });
    const first = await listReplyEvents(adminA, { limit: 2 });
    expect(first.events.map((e) => e.reason)).toEqual(['reply_cap', 'guard_blocked']);
    const next = await listReplyEvents(adminA, { limit: 2, cursor: decodeActivityCursor(first.next_cursor!) });
    expect(next.events.map((e) => e.reason)).toEqual(['answered']);
    expect(next.next_cursor).toBeNull();
    expect((await listReplyEvents(adminA, { limit: 10, outcome: 'handed_off' })).events.map((e) => e.reason)).toEqual(['guard_blocked']);
    expect((await listReplyEvents(adminA, { limit: 10, reason: 'reply_cap' })).events).toHaveLength(1);
  });

  it('hides the log from agents and from another workspace', async () => {
    const [anyRow] = await rowsOf(accountA);
    expect((await listReplyEvents(agentA, { limit: 10 })).events).toEqual([]);
    expect(await getReplyEvent(agentA, anyRow.id)).toBeNull();
    expect((await listReplyEvents(ownerB, { limit: 10 })).events).toEqual([]);
    expect(await getReplyEvent(ownerB, anyRow.id)).toBeNull();
    // Even naming A's account in B's scope finds nothing (RLS, not just the WHERE clause).
    const leaked = await withTenant(ownerB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM ai_reply_events WHERE account_id=${accountA}::uuid`);
    expect(leaked[0].n).toBe(0);
  });

  it('refuses writes from the app role, even for an admin', async () => {
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`INSERT INTO ai_reply_events(account_id, outcome, reason)
      VALUES (${accountA}::uuid, 'replied', 'answered')`)).rejects.toThrow();
    await expect(withTenant(adminA, (tx) => tx.$executeRaw`DELETE FROM ai_reply_events WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
  });

  it('refuses a worker write into another workspace', async () => {
    await expect(withTenant({ accountId: accountB, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO ai_reply_events(account_id, outcome, reason)
      VALUES (${accountA}::uuid, 'replied', 'answered')`, getWorkerPrisma())).rejects.toThrow();
  });

  it('removes the rows with their conversation', async () => {
    await recordReplyEvent({ accountId: accountA, conversationId: conversationA2, contactId: contactA2, outcome: 'skipped', reason: 'stale' });
    expect((await owner.query('SELECT count(*)::int AS n FROM ai_reply_events WHERE conversation_id=$1', [conversationA2])).rows[0].n).toBe(1);
    await owner.query('DELETE FROM conversations WHERE id=$1', [conversationA2]);
    expect((await owner.query('SELECT count(*)::int AS n FROM ai_reply_events WHERE conversation_id=$1', [conversationA2])).rows[0].n).toBe(0);
  });

  it('lists the workspace as due and deletes rows older than 90 days in that workspace only', async () => {
    const old = `${AI_RETENTION.replyEventDays + 1} days`;
    const oldA = (await owner.query(`INSERT INTO ai_reply_events(account_id, conversation_id, outcome, reason, created_at)
      VALUES ($1,$2,'skipped','stale', now() - $3::interval) RETURNING id::text`, [accountA, conversationA, old])).rows[0].id;
    const oldB = (await owner.query(`INSERT INTO ai_reply_events(account_id, outcome, reason, created_at)
      VALUES ($1,'skipped','stale', now() - $2::interval) RETURNING id::text`, [accountB, old])).rows[0].id;
    const due = (await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`SELECT account_id::text FROM crm_accounts_with_ai_retention_due()`)
      .map((r) => r.account_id);
    expect(due).toEqual(expect.arrayContaining([accountA, accountB]));

    const before = (await rowsOf(accountA)).length;
    const result = await runAiRetentionSweep(accountA);
    expect(result.replyEventsDeleted).toBe(1);
    const after = await rowsOf(accountA);
    expect(after).toHaveLength(before - 1);
    expect(after.map((r) => r.id)).not.toContain(oldA);
    expect((await owner.query('SELECT 1 FROM ai_reply_events WHERE id=$1', [oldB])).rowCount).toBe(1);
  });
});
