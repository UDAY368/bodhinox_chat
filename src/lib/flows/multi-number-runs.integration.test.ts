import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';

// Meta is the only fake: the engine, run rows, unique index and outbound intents are real.
const h = vi.hoisted(() => {
  let n = 0;
  type Sent = { conversationId: string; text?: string; bodyText?: string };
  const send = vi.fn<(args: Sent) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: `wamid.${++n}` }));
  return { send };
});
vi.mock('./meta-send', () => ({
  engineSendText: h.send,
  engineSendMedia: h.send,
  engineSendInteractiveButtons: h.send,
  engineSendInteractiveList: h.send,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

import { dispatchInboundToFlows, startFlowById } from './engine';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), user = randomUUID(), contact = randomUUID();
const flowAny = randomUUID(), flowB = randomUUID(), flowManual = randomUUID(), runA = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let numberA = '', numberB = '', convA = '', convB = '';

const scope = { accountId: account, role: 'owner' as const };
const dispatch = (conversationId: string, text: string) => withJobScope(scope, () => dispatchInboundToFlows({
  accountId: account, userId: user, contactId: contact, conversationId,
  message: { kind: 'text', text, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false,
}));
const runRow = async (id: string) => (await owner.query('SELECT status,current_node_key,vars,conversation_id FROM flow_runs WHERE id=$1', [id])).rows[0];
const activeRuns = async () => (await owner.query(
  "SELECT id,flow_id,conversation_id FROM flow_runs WHERE account_id=$1 AND status='active' ORDER BY started_at", [account])).rows;
const sentFrom = () => h.send.mock.calls.map(([args]) => [args.conversationId, args.text ?? args.bodyText]);

async function addNumber(phoneNumberId: string, wabaId: string): Promise<string> {
  return (await owner.query(
    `INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status)
     VALUES($1,$2,$3,$4,$5,'connected') RETURNING id`,
    [account, user, phoneNumberId, wabaId, encrypt('test-only-token')],
  )).rows[0].id;
}
async function addConversation(numberId: string): Promise<string> {
  return (await owner.query(
    "INSERT INTO conversations(account_id,user_id,contact_id,status,whatsapp_config_id) VALUES($1,$2,$3,'open',$4) RETURNING id",
    [account, user, contact, numberId],
  )).rows[0].id;
}
// start -> ask (collect_input) -> thanks (send_message) -> done
async function addFlow(id: string, name: string, trigger: string, keyword: string, numberId: string | null) {
  await owner.query(
    `INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id,whatsapp_config_id)
     VALUES($1,$2,$3,$4,'active',$5,$6,'start',$7)`,
    [id, account, user, name, trigger, JSON.stringify({ keywords: [keyword], match_type: 'exact' }), numberId],
  );
  await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
    ($1,$2,'start','start','{"next_node_key":"ask"}'),
    ($1,$2,'ask','collect_input',$3),
    ($1,$2,'thanks','send_message',$4),
    ($1,$2,'done','end','{}')`, [account, id,
    JSON.stringify({ prompt_text: `${name}: your answer?`, var_key: 'answer', next_node_key: 'thanks' }),
    JSON.stringify({ text: `${name}: got {{vars.answer}}`, next_node_key: 'done' })]);
}

describe.skipIf(!ownerUrl || !workerUrl)('flow runs across WhatsApp numbers on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Runs test','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Runs',$2)", [account, user]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'X',$4)", [contact, account, user, `14155${seed.slice(-6)}`]);
    numberA = await addNumber(`74${seed}`, `84${seed}`);
    numberB = await addNumber(`75${seed}`, `85${seed}`);
    convA = await addConversation(numberA);
    convB = await addConversation(numberB);
    await addFlow(flowAny, 'Any', 'keyword', 'hello', null);
    await addFlow(flowB, 'OnB', 'keyword', 'order', numberB);
    await addFlow(flowManual, 'Manual', 'manual', 'unused', null);
    // Flow "Any" waits for an answer on number A's conversation.
    await owner.query(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,transition_seq)
      VALUES($1,$2,$3,$4,$5,$6,'active','ask',1)`, [runA, account, flowAny, user, contact, convA]);
  });
  beforeEach(() => h.send.mockClear());
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('an inbound on B does not answer the run waiting on A', async () => {
    const result = await dispatch(convB, 'some text for B');
    expect(result).toMatchObject({ consumed: false, outcome: 'no_match' });
    expect(await runRow(runA)).toMatchObject({ status: 'active', current_node_key: 'ask', vars: {}, conversation_id: convA });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a flow tied to B starts on B while A is still waiting, and prompts from B', async () => {
    const result = await dispatch(convB, 'order');
    expect(result).toMatchObject({ consumed: true });
    const runs = await activeRuns();
    expect(runs).toEqual([
      { id: runA, flow_id: flowAny, conversation_id: convA },
      { id: result.flow_run_id, flow_id: flowB, conversation_id: convB },
    ]);
    expect(sentFrom()).toEqual([[convB, 'OnB: your answer?']]);
    expect(await runRow(runA)).toMatchObject({ status: 'active', current_node_key: 'ask', vars: {} });
  });

  it('each conversation answers its own run, and replies go out from that number', async () => {
    await dispatch(convA, 'alpha');
    await dispatch(convB, 'beta');
    expect(sentFrom()).toEqual([[convA, 'Any: got alpha'], [convB, 'OnB: got beta']]);
    expect(await runRow(runA)).toMatchObject({ status: 'completed', vars: { answer: 'alpha' } });
    expect(await activeRuns()).toEqual([]);
  });

  it('an explicit start on B is not blocked by a run on A, but is by a run on B', async () => {
    await dispatch(convA, 'hello');
    const start = (conversationId: string) => withJobScope(scope, () =>
      startFlowById({ accountId: account, userId: user, contactId: contact, conversationId, flowId: flowManual,
        message: { kind: 'text', text: '', meta_message_id: `manual.${randomUUID()}` } }));
    expect(await start(convB)).toEqual({ outcome: 'started' });
    expect(await start(convB)).toEqual({ outcome: 'conflict' });
    expect((await activeRuns()).map((r) => r.conversation_id)).toEqual([convA, convB]);
  });

  it('the database allows one active run per conversation, not per contact', async () => {
    const insert = (conversationId: string | null) => owner.query(
      `INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
       VALUES($1,$2,$3,$4,$5,'active','ask')`, [account, flowAny, user, contact, conversationId]);
    await expect(insert(convA)).rejects.toMatchObject({ code: '23505' });
    await expect(insert(convB)).rejects.toMatchObject({ code: '23505' });
    // Legacy rows without a conversation stay at one active run per contact.
    await insert(null);
    await expect(insert(null)).rejects.toMatchObject({ code: '23505' });
    const indexes = (await owner.query("SELECT indexname FROM pg_indexes WHERE tablename='flow_runs' AND indexname LIKE 'idx_one_active_run%'")).rows;
    expect(indexes).toEqual([{ indexname: 'idx_one_active_run_per_conversation' }]);
  });
});
