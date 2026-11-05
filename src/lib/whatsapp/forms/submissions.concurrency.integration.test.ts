import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { ingestInboundMessage, type IngestInboundInput } from '../ingest';
import { createFormSession } from './sessions';

// One WhatsApp form token submitted several times at once (Meta redelivery, or a customer
// tapping Send twice). Local Docker database only (scripts/test-db-local.cjs); no .env file is loaded.
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountId = randomUUID(), ownerId = randomUUID(), contactId = randomUUID(), conversationId = randomUUID();
const definition = JSON.stringify({ version: 1, screens: [{ id: 'MAIN', title: 'Details', button_label: 'Send', fields: [
  { id: 'full_name', type: 'short_text', label: 'Name' },
] }] });
let owner: pg.Client;
let formId = '';

const session = () => withTenant({ accountId, role: 'owner' }, (tx) => createFormSession(tx, { accountId, formId, contactId, conversationId: null,
  flowRunId: null, nodeKey: 'ask', ttlHours: 24 }), getWorkerPrisma());
const submit = (flowToken: string, metaMessageId: string) => ingestInboundMessage({
  accountId, userId: ownerId, contactId, conversationId, metaMessageId,
  contentType: 'interactive', contentText: '[Form]', mediaUrl: null, mediaType: null, interactiveReplyId: null,
  replyToMessageId: null, createdAt: new Date(), wasContactCreated: false, wasConversationCreated: false,
  formReply: { flowToken, answers: { full_name: 'Ana' } },
} satisfies IngestInboundInput);
const responses = async (sessionId: string) => (await owner.query(
  'SELECT message_id FROM whatsapp_form_responses WHERE account_id=$1 AND session_id=$2', [accountId, sessionId])).rows;

describe.skipIf(!ownerUrl || !workerUrl)('[WA-03] WhatsApp form submissions under concurrency on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Form concurrency','test-only-hash')", [ownerId, `${ownerId}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Form concurrency',$2)", [accountId, ownerId]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [accountId, ownerId]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,phone) VALUES($1,$2,$3,'15550004444')", [contactId, accountId, ownerId]);
    await owner.query('INSERT INTO conversations(id,account_id,user_id,contact_id) VALUES($1,$2,$3,$4)', [conversationId, accountId, ownerId, contactId]);
    formId = (await owner.query("INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition,status,meta_flow_id) VALUES($1,$2,'Concurrency form','LEAD_GENERATION',$3::jsonb,'published','5550009') RETURNING id::text",
      [accountId, ownerId, definition])).rows[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountId]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountId]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [ownerId]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('the same delivery five times at once: one message, one submission row, one inbound job', async () => {
    const { flowToken, sessionId } = await session();
    const metaMessageId = `wamid.${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(flowToken, metaMessageId)));
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
    expect(await responses(sessionId)).toHaveLength(1);
    const messages = (await owner.query('SELECT count(*)::int AS n FROM messages WHERE account_id=$1 AND message_id=$2', [accountId, metaMessageId])).rows[0].n;
    expect(messages).toBe(1);
    const jobs = (await owner.query('SELECT count(*)::int AS n FROM jobs WHERE dedupe_key=$1', [`inbound:${results[0].messageId}`])).rows[0].n;
    expect(jobs).toBe(1);
  });

  it('five different submissions of one token at once: all are kept, exactly one is trusted and the session completes once', async () => {
    const { flowToken, sessionId } = await session();
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(flowToken, `wamid.${randomUUID()}`)));
    expect(results.every((r) => r.inserted)).toBe(true);
    const forms = (await owner.query("SELECT interactive_payload->'form' AS form FROM messages WHERE id = ANY($1::uuid[])",
      [results.map((r) => r.messageId)])).rows.map((r) => r.form as { trusted: boolean; node_key: string | null });
    expect(forms.filter((f) => f.trusted)).toHaveLength(1);
    expect(forms.find((f) => f.trusted)?.node_key).toBe('ask');
    // Every submission is kept (the existing rule for a second submission on one session), but only one is trusted.
    expect(await responses(sessionId)).toHaveLength(5);
    const completed = (await owner.query('SELECT completed_at FROM whatsapp_form_sessions WHERE id=$1', [sessionId])).rows[0].completed_at;
    expect(completed).not.toBeNull();
  });
});
