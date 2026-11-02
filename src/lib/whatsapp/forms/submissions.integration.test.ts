import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { ingestInboundMessage, type IngestInboundInput } from '../ingest';
import { createFormSession } from './sessions';
import { templateFlowTokens } from './send';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), otherContactA = randomUUID(), conversationA = randomUUID(), contactB = randomUUID(), conversationB = randomUUID();
const asWorker = (accountId: string): TenantContext => ({ accountId, role: 'owner' });
const definition = JSON.stringify({ version: 1, screens: [{ id: 'MAIN', title: 'Details', button_label: 'Send', fields: [
  { id: 'full_name', type: 'short_text', label: 'Name' },
  { id: 'plan', type: 'radio', label: 'Plan', options: [{ id: 'pro', title: 'Pro plan' }] },
] }] });
let owner: pg.Client;
let formA = '';

const session = (contactId: string | null, ttlHours = 24, accountId = accountA, formId = formA) =>
  withTenant(asWorker(accountId), (tx) => createFormSession(tx, { accountId, formId, contactId, conversationId: null,
    flowRunId: null, nodeKey: 'ask', ttlHours }), getWorkerPrisma());

const submit = (flowToken: string | null, patch: Partial<IngestInboundInput> = {}) => ingestInboundMessage({
  accountId: accountA, userId: ownerA, contactId: contactA, conversationId: conversationA, metaMessageId: `wamid.${randomUUID()}`,
  contentType: 'interactive', contentText: '[Form]', mediaUrl: null, mediaType: null, interactiveReplyId: null,
  replyToMessageId: null, createdAt: new Date(), wasContactCreated: false, wasConversationCreated: false,
  formReply: { flowToken, answers: { full_name: 'Ana', plan: 'pro' } }, ...patch,
});

const responseFor = async (messageId: string) => (await owner.query(
  'SELECT account_id,form_id,session_id,contact_id,response FROM whatsapp_form_responses WHERE message_id=$1', [messageId])).rows;
const message = async (id: string) => (await owner.query('SELECT content_text,interactive_payload FROM messages WHERE id=$1', [id])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp form submissions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Form submissions test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Submissions A',$2),($3,'Submissions B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [accountA, ownerA, agentA, viewerA, accountB, ownerB]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,phone) VALUES($1,$2,$3,'15550002222'),($4,$2,$3,'15550002223'),($5,$6,$7,'15550003333')",
      [contactA, accountA, ownerA, otherContactA, contactB, accountB, ownerB]);
    await owner.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4),($5,$6,$7,$8)',
      [conversationA, accountA, ownerA, contactA, conversationB, accountB, ownerB, contactB]);
    formA = (await owner.query("INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition,status,meta_flow_id) VALUES($1,$2,'Lead form','LEAD_GENERATION',$3::jsonb,'published','5550001') RETURNING id::text",
      [accountA, ownerA, definition])).rows[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores a submission once, completes its session and writes a readable inbox summary', async () => {
    const { flowToken, sessionId } = await session(contactA);
    const metaMessageId = `wamid.${randomUUID()}`;
    const first = await submit(flowToken, { metaMessageId });
    const again = await submit(flowToken, { metaMessageId });
    expect(first.inserted).toBe(true);
    expect(again).toMatchObject({ inserted: false, messageId: first.messageId });
    const rows = await responseFor(metaMessageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: accountA, form_id: formA, session_id: sessionId, contact_id: contactA, response: { full_name: 'Ana', plan: 'pro' } });
    expect(JSON.stringify(rows[0].response)).not.toContain(flowToken);
    const stored = await message(first.messageId);
    expect(stored.content_text.split('\n').slice(1)).toEqual(['Name: Ana', 'Plan: Pro plan']);
    expect(stored.interactive_payload.form).toMatchObject({ form_id: formA, form_name: 'Lead form', trusted: true, node_key: 'ask' });
    expect(JSON.stringify(stored.interactive_payload)).not.toContain(flowToken);
    const sessionRow = (await owner.query('SELECT completed_at FROM whatsapp_form_sessions WHERE id=$1', [sessionId])).rows[0];
    expect(sessionRow.completed_at).not.toBeNull();
    // One job for the stored message, with the summary as its text.
    const jobs = (await owner.query("SELECT payload FROM jobs WHERE dedupe_key=$1", [`inbound:${first.messageId}`])).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.contentText).toBe(stored.content_text);
  });

  it('keeps a second submission on the same session but does not trust it', async () => {
    const { flowToken } = await session(contactA);
    await submit(flowToken);
    const second = await submit(flowToken);
    expect((await message(second.messageId)).interactive_payload.form).toMatchObject({ form_id: formA, trusted: false, flow_run_id: null, node_key: null });
  });

  it('does not trust an expired session or another contact\'s token, and stores an unknown token without a form', async () => {
    const expired = await session(contactA, 1);
    await owner.query("UPDATE whatsapp_form_sessions SET expires_at=now() - interval '1 minute' WHERE flow_token=$1", [expired.flowToken]);
    const late = await submit(expired.flowToken);
    expect((await message(late.messageId)).interactive_payload.form).toMatchObject({ form_id: formA, trusted: false });

    const someoneElse = await session(otherContactA);
    const forwarded = await submit(someoneElse.flowToken);
    expect((await message(forwarded.messageId)).interactive_payload.form).toMatchObject({ trusted: false });

    const unknownId = `wamid.${randomUUID()}`;
    const unknown = await submit('x'.repeat(43), { metaMessageId: unknownId });
    expect((await message(unknown.messageId)).interactive_payload.form).toMatchObject({ form_id: null, form_name: null, trusted: false });
    expect((await responseFor(unknownId))[0]).toMatchObject({ form_id: null, session_id: null, contact_id: contactA });
  });

  it('never resolves another account\'s token', async () => {
    const formB = (await owner.query("INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition) VALUES($1,$2,'B form','OTHER',$3::jsonb) RETURNING id::text",
      [accountB, ownerB, definition])).rows[0].id;
    const foreign = await session(contactB, 24, accountB, formB);
    const messageId = `wamid.${randomUUID()}`;
    await submit(foreign.flowToken, { metaMessageId: messageId });
    expect((await responseFor(messageId))[0]).toMatchObject({ account_id: accountA, form_id: null, session_id: null });
    const untouched = (await owner.query('SELECT completed_at FROM whatsapp_form_sessions WHERE flow_token=$1', [foreign.flowToken])).rows[0];
    expect(untouched.completed_at).toBeNull();
  });

  it('lets agents but not viewers issue sessions through the app role', async () => {
    const issue = (ctx: TenantContext) => withTenant(ctx, (tx) => createFormSession(tx, { accountId: accountA, formId: formA, contactId: contactA, ttlHours: 1 }), getPrisma());
    await expect(issue({ accountId: accountA, userId: agentA, role: 'agent' })).resolves.toMatchObject({ sessionId: expect.any(String) });
    await expect(issue({ accountId: accountA, userId: viewerA, role: 'viewer' })).rejects.toThrow();
  });

  it('creates a template FLOW button session only for this account\'s form', async () => {
    const tokens = await templateFlowTokens({ accountId: accountA, contactId: contactA, conversationId: conversationA,
      buttons: [{ type: 'QUICK_REPLY' }, { type: 'FLOW', flow_id: '5550001' }] });
    expect(Object.keys(tokens ?? {})).toEqual(['1']);
    const row = (await owner.query('SELECT form_id::text,contact_id::text,expires_at > now() + interval \'29 days\' AS long_lived FROM whatsapp_form_sessions WHERE flow_token=$1', [tokens![1]])).rows[0];
    expect(row).toEqual({ form_id: formA, contact_id: contactA, long_lived: true });
    expect(await templateFlowTokens({ accountId: accountB, contactId: null, conversationId: null, buttons: [{ type: 'FLOW', flow_id: '5550001' }] })).toBeUndefined();
  });
});
