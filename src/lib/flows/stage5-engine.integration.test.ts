// Stage 5 (5B) on a real PostgreSQL. Proves: a flow with a comment trigger
// next to a keyword starts once per comment and, from a DM, sends its private
// reply as an ordinary message inside the window; a comment reply delay is a
// durable flow.timer queued before the comment job returns, and a fresh
// worker carries the run on from it; a draft runs only for its test
// usernames; an Actions step retried after a failure never repeats a
// finished action; a secret workspace field is never written; a send after a
// long wait with a closed window is refused with no outbound intent; a stale
// autosave writes nothing; publishing snapshots extra triggers; node stats,
// segments, workspace fields and stop_flow stay in their workspace; and a
// WhatsApp flow runs exactly as before. Meta is never called: fetch is
// stubbed for Instagram and the WhatsApp sender is a fake.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';

const h = vi.hoisted(() => {
  let n = 0;
  const waSend = vi.fn<(args: { conversationId: string; text?: string; bodyText?: string }) => Promise<{ whatsapp_message_id: string }>>(
    async () => ({ whatsapp_message_id: `wamid.s5.${++n}` }));
  return { waSend, failRemoveOnce: false };
});
vi.mock('./meta-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./meta-send')>()),
  engineSendText: h.waSend,
  engineSendMedia: h.waSend,
  engineSendInteractiveButtons: h.waSend,
  engineSendInteractiveList: h.waSend,
}));
vi.mock('@/lib/webhooks/deliver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/deliver')>()),
  dispatchWebhookEvent: vi.fn(async () => {}),
}));
vi.mock('@/lib/contacts/tag-write', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/contacts/tag-write')>();
  return {
    ...real,
    removeContactTag: async (...args: Parameters<typeof real.removeContactTag>) => {
      if (h.failRemoveOnce) {
        h.failRemoveOnce = false;
        throw new Error('connection reset');
      }
      return real.removeContactTag(...args);
    },
  };
});

import { dispatchInboundToFlows, handleFlowTimer } from './engine';
import { persistInstagramWebhook } from '@/lib/instagram/webhook';
import { processInstagramWebhookJob } from '@/lib/instagram/process-webhook';
import { handlePrivateReplyJob } from '@/lib/instagram/private-reply';
import { runActions } from './nodes/actions';
import { writeWorkspaceAttribute } from '@/lib/workspace/attribute-write';
import { contactInSegment } from '@/lib/audience/membership';
import { workspaceFieldSubject } from './conditions/workspace-field';
import { FlowVersionError, publishFlow, readNodeStats, saveDraft } from './versions';
import { ALL_CAPABILITIES } from './node-registry';
import type { FlowAction, FlowRunRow } from './types';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const ENV = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123456', INSTAGRAM_APP_SECRET: 'test-only-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify', APP_URL: 'https://app.example.test',
};
const A = randomUUID(), B = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
const igUserA = `85${seed}`;
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
let owner: pg.Client;

let n = 0;
const next = (prefix: string) => `${prefix}${seed}${String(++n).padStart(4, '0')}`;
const receipts: string[] = [];
const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function graphStub() {
  return vi.fn(async (input: string | URL, _init?: RequestInit) => {
    void _init;
    const url = String(input);
    if (url.includes('/replies')) return json(200, { id: `179${seed}${String(++n).padStart(4, '0')}` });
    if (url.includes('/messages')) return json(200, { recipient_id: '9001', message_id: `mid.${randomUUID()}` });
    if (url.includes('/media')) return json(200, { data: [] });
    return json(404, { error: { message: 'unexpected', code: 100 } });
  });
}
const posted = (fetchMock: ReturnType<typeof graphStub>, part: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(part)).map((c) => JSON.parse(String(c[1]?.body ?? '{}')));

type Node = { node_key: string; node_type: string; config: Record<string, unknown> };
/** A live Instagram flow: the row and its published version (with extra triggers), straight in SQL. */
async function liveIgFlow(accountId: string, userId: string, trigger: { type: string; config: Record<string, unknown> },
  extra: unknown[], nodes: Node[], status: 'active' | 'draft' = 'active', testUsernames: string[] = []): Promise<string> {
  const flow = (await q(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,extra_triggers,entry_node_id,channel_scope,test_usernames)
    VALUES($1,$2,'Stage 5 flow',$3,$4,$5,'start','instagram',$6) RETURNING id`,
  [accountId, userId, trigger.type, trigger.config, JSON.stringify(extra), testUsernames])).rows[0].id as string;
  for (const node of nodes) {
    await q('INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,$3,$4,$5)',
      [accountId, flow, node.node_key, node.node_type, JSON.stringify(node.config)]);
  }
  if (status === 'draft') return flow;
  const version = (await q(`INSERT INTO flow_versions(account_id,flow_id,version,trigger_type,trigger_config,extra_triggers,entry_node_id,
      fallback_policy,channel_scope,nodes,published_by)
    VALUES($1,$2,1,$3,$4,$5,'start','{}'::jsonb,'instagram',$6,$7) RETURNING id`,
  [accountId, flow, trigger.type, trigger.config, JSON.stringify(extra), JSON.stringify(nodes), userId])).rows[0].id as string;
  await q("UPDATE flows SET status='active', published_version_id=$1 WHERE id=$2", [version, flow]);
  return flow;
}
async function deliver(body: Record<string, unknown>): Promise<void> {
  const receiptId = await persistInstagramWebhook(JSON.stringify(body), body);
  receipts.push(receiptId);
  await processInstagramWebhookJob({ receiptId });
}
const comment = (value: Record<string, unknown>) =>
  ({ object: 'instagram', entry: [{ id: igUserA, time: Date.now(), changes: [{ field: 'comments', value }] }] });
const dm = (from: string, mid: string, text: string) => ({ object: 'instagram', entry: [{ id: igUserA, time: Date.now(), messaging: [{
  sender: { id: from }, recipient: { id: igUserA }, timestamp: Date.now() - 1000, message: { mid, text } }] }] });
const eventOf = async (commentId: string) => (await q(
  'SELECT id, private_reply_status AS status, flow_run_id FROM instagram_comment_events WHERE comment_id=$1', [commentId])).rows[0] as
  { id: string; status: string; flow_run_id: string | null } | undefined;
const jobPayload = async (eventId: string) => (await q(
  "SELECT payload FROM jobs WHERE type='instagram.private_reply' AND dedupe_key=$1", [`igpr:${eventId}`])).rows[0]?.payload as Record<string, unknown> | undefined;
const runOf = async (id: string) => (await q(
  'SELECT id, flow_id, contact_id, conversation_id, status, end_reason, current_node_key, transition_seq, delay_until, vars FROM flow_runs WHERE id=$1', [id])).rows[0];
const runJob = (payload: Record<string, unknown>) => withJobScope({ accountId: A, role: 'owner' }, () => handlePrivateReplyJob(A, payload));
const threadOf = async (igsid: string) => (await q(`SELECT c.id AS conversation_id, c.contact_id FROM contact_channel_identities i
  JOIN conversations c ON c.account_id=i.account_id AND c.contact_id=i.contact_id AND c.channel='instagram'
  WHERE i.account_id=$1 AND i.external_id=$2`, [A, igsid])).rows[0] as { conversation_id: string; contact_id: string };

const COMMENT_NODES: Node[] = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'reply' } },
  { node_key: 'reply', node_type: 'ig_comment_reply', config: { replies: ['Check your DMs'], next_node_key: 'pr' } },
  { node_key: 'pr', node_type: 'ig_private_reply', config: { text: 'Here is the link', next_node_key: '' } },
];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Stage 5 flow engine on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Stage 5 engine', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Stage 5 A',$2),($3,'Stage 5 B',$4)", [A, ownerA, B, ownerB]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [A, ownerA, B, ownerB]);
    await q(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
      VALUES($1,$2,'shop',$3,$4,$5)`, [A, igUserA, encrypt('test-only-ig-token'), SCOPES, ownerA]);
  });
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    h.waSend.mockClear();
    h.failRemoveOnce = false;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (owner) {
      await q('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      if (receipts.length) {
        await q("DELETE FROM jobs WHERE type='instagram.webhook' AND payload->>'receiptId' = ANY($1::text[])", [receipts]).catch(() => undefined);
        await q('DELETE FROM webhook_receipts WHERE id=ANY($1::uuid[])', [receipts]).catch(() => undefined);
      }
      await q('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[A, B]]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]).catch(() => undefined);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('a flow with a keyword and a comment trigger starts once per comment, and from a DM sends its private reply as a message', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const flow = await liveIgFlow(A, ownerA, { type: 'keyword', config: { keywords: ['catalog'] } },
      [{ trigger_type: 'ig_comment', config: { post_scope: 'any', include_keywords: ['catalog'] } }], COMMENT_NODES);

    // The comment: offered with the extra trigger's index, started once even when the job runs twice.
    const commentId = next('18'), commenter = next('7');
    await deliver(comment({ id: commentId, text: 'catalog please', media: { id: next('17') }, from: { id: commenter } }));
    const event = (await eventOf(commentId))!;
    const payload = (await jobPayload(event.id))!;
    expect(payload).toMatchObject({ flows: [{ flowId: flow, check: false, trigger: 1 }] });
    await runJob(payload);
    await runJob(payload);
    expect((await q('SELECT count(*)::int AS n FROM flow_runs WHERE flow_id=$1', [flow])).rows[0].n).toBe(1);
    expect(posted(fetchMock, '/messages')).toEqual([{ recipient: { comment_id: commentId }, message: { text: 'Here is the link' } }]);
    expect(posted(fetchMock, '/replies')).toEqual([{ message: 'Check your DMs' }]);

    // A DM with the keyword from someone else: no comment, so no public reply, and the private reply is an ordinary DM.
    const sender = next('7'), mid = `mid-s5-${sender}`;
    await deliver(dm(sender, mid, 'catalog'));
    const thread = await threadOf(sender);
    const result = await withJobScope({ accountId: A, role: 'owner' }, () => dispatchInboundToFlows({
      accountId: A, userId: ownerA, contactId: thread.contact_id, conversationId: thread.conversation_id,
      message: { kind: 'text', text: 'catalog', meta_message_id: mid }, isFirstInboundMessage: true,
    }));
    expect(result.consumed).toBe(true);
    expect(posted(fetchMock, '/replies')).toHaveLength(1);
    const dms = posted(fetchMock, '/messages');
    expect(dms[dms.length - 1]).toEqual({ recipient: { id: sender }, message: { text: 'Here is the link' } });
    const run = (await q('SELECT id FROM flow_runs WHERE flow_id=$1 AND contact_id=$2', [flow, thread.contact_id])).rows[0];
    const skipped = (await q("SELECT payload FROM flow_run_events WHERE flow_run_id=$1 AND node_key='reply'", [run.id])).rows;
    expect(JSON.stringify(skipped)).toContain('skipped_not_comment');
  });

  it('a comment reply delay is a flow.timer queued before the job returns; a fresh worker carries the run on once', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    await liveIgFlow(A, ownerA, { type: 'ig_comment', config: { post_scope: 'any', include_keywords: ['later'], reply_delay_seconds: 120 } }, [],
      [COMMENT_NODES[0], { ...COMMENT_NODES[1], config: { replies: ['Soon'], next_node_key: 'pr' } }, COMMENT_NODES[2]]);
    const commentId = next('18');
    await deliver(comment({ id: commentId, text: 'later', media: { id: next('17') }, from: { id: next('7') } }));
    const event = (await eventOf(commentId))!;
    const before = Date.now();
    await runJob((await jobPayload(event.id))!);
    const linked = (await eventOf(commentId))!;
    const run = await runOf(linked.flow_run_id!);
    expect(run).toMatchObject({ status: 'active', current_node_key: 'start', transition_seq: 1 });
    expect(new Date(run.delay_until).getTime()).toBeGreaterThanOrEqual(before + 119_000);
    // Nothing went to the commenter's DMs yet; the timer is a durable job row.
    expect(posted(fetchMock, '/messages')).toEqual([]);
    const [timer] = (await q("SELECT payload, run_at FROM jobs WHERE type='flow.timer' AND payload->>'runId'=$1", [run.id])).rows;
    expect(timer.payload).toMatchObject({ runId: run.id, nodeKey: 'start', seq: 1, kind: 'delay' });

    // The worker restarts: a new process picks the job up from the table.
    const fire = () => withJobScope({ accountId: A, role: 'owner' }, () => handleFlowTimer({ accountId: A, ...timer.payload }));
    expect(await fire()).toBe('fired');
    expect(await fire()).toBe('stale');
    expect(posted(fetchMock, '/messages')).toHaveLength(1);
    expect((await runOf(run.id)).status).toBe('completed');
  });

  it('a draft comment flow runs only for its test usernames', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const draft = await liveIgFlow(A, ownerA, { type: 'ig_comment', config: { post_scope: 'any', include_keywords: ['beta'] } }, [],
      COMMENT_NODES, 'draft', ['tester.one']);
    // The tester wrote before, so their identity and username are stored.
    const tester = next('7'), stranger = next('7');
    await deliver(dm(tester, `mid-s5-${tester}`, 'hello'));
    await deliver(dm(stranger, `mid-s5-${stranger}`, 'hello'));
    await q("UPDATE contact_channel_identities SET username='Tester.One' WHERE account_id=$1 AND external_id=$2", [A, tester]);
    await q("UPDATE contact_channel_identities SET username='someone' WHERE account_id=$1 AND external_id=$2", [A, stranger]);

    const fromStranger = next('18');
    await deliver(comment({ id: fromStranger, text: 'beta', media: { id: next('17') }, from: { id: stranger } }));
    expect((await eventOf(fromStranger))!.status).toBe('no_rule');

    const fromTester = next('18');
    await deliver(comment({ id: fromTester, text: 'beta', media: { id: next('17') }, from: { id: tester } }));
    const event = (await eventOf(fromTester))!;
    expect(await jobPayload(event.id)).toMatchObject({ flows: [{ flowId: draft }] });
    await runJob((await jobPayload(event.id))!);
    const run = await runOf((await eventOf(fromTester))!.flow_run_id!);
    expect(run).toMatchObject({ flow_id: draft, status: 'completed' });
  });

  it('a send after a long wait with a closed window is refused, ends window_closed and leaves no outbound intent', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const flow = await liveIgFlow(A, ownerA, { type: 'keyword', config: { keywords: ['wait'] } }, [], [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'd' } },
      { node_key: 'd', node_type: 'smart_delay', config: { mode: 'duration', amount: 2, unit: 'days', next_node_key: 'msg' } },
      { node_key: 'msg', node_type: 'send_message', config: { text: 'Still interested?', next_node_key: 'end' } },
      { node_key: 'end', node_type: 'end', config: {} },
    ]);
    const sender = next('7'), mid = `mid-s5-${sender}`;
    await deliver(dm(sender, mid, 'wait'));
    const thread = await threadOf(sender);
    await withJobScope({ accountId: A, role: 'owner' }, () => dispatchInboundToFlows({
      accountId: A, userId: ownerA, contactId: thread.contact_id, conversationId: thread.conversation_id,
      message: { kind: 'text', text: 'wait', meta_message_id: mid }, isFirstInboundMessage: true,
    }));
    const run = (await q('SELECT id FROM flow_runs WHERE flow_id=$1', [flow])).rows[0];
    const [timer] = (await q("SELECT payload FROM jobs WHERE type='flow.timer' AND payload->>'runId'=$1", [run.id])).rows;
    expect(timer.payload).toMatchObject({ nodeKey: 'd', kind: 'delay' });
    // Two days later: the person's last message is outside the 24-hour window.
    await q("UPDATE messages SET created_at=now() - interval '49 hours' WHERE conversation_id=$1", [thread.conversation_id]);
    await withJobScope({ accountId: A, role: 'owner' }, () => handleFlowTimer({ accountId: A, ...timer.payload }));
    expect(await runOf(run.id)).toMatchObject({ status: 'cancelled', end_reason: 'window_closed' });
    expect(posted(fetchMock, '/messages')).toEqual([]);
    expect((await q("SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2",
      [A, `%flow:${run.id}:msg:%`])).rows[0].n).toBe(0);
  });

  describe('WhatsApp-side checks', () => {
    let phones = 0;
    async function waContact(accountId = A, userId = ownerA) {
      const contact = randomUUID(), conversation = randomUUID();
      await q('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)', [contact, accountId, userId, 'C', `1415${seed}${++phones}`]);
      await q("INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,'open')", [conversation, accountId, userId, contact]);
      return { contact, conversation };
    }
    async function waFlow(accountId: string, userId: string, keyword: string, nodes: Node[], status = 'active') {
      const id = randomUUID();
      await q(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id)
        VALUES($1,$2,$3,'WA',$4,'keyword',$5,'start')`, [id, accountId, userId, status, JSON.stringify({ keywords: [keyword] })]);
      for (const node of nodes) {
        await q('INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,$3,$4,$5)', [accountId, id, node.node_key, node.node_type, JSON.stringify(node.config)]);
      }
      return id;
    }
    const member = { accountId: A, userId: ownerA, role: 'owner' as const };

    it('a WhatsApp flow runs exactly as before: the same messages, in order, then completes', async () => {
      const flow = await waFlow(A, ownerA, 'hello5', [
        { node_key: 'start', node_type: 'start', config: { next_node_key: 'ask' } },
        { node_key: 'ask', node_type: 'collect_input', config: { prompt_text: 'Your name?', var_key: 'name', next_node_key: 'thanks' } },
        { node_key: 'thanks', node_type: 'send_message', config: { text: 'Thanks {{vars.name}}{{vars.none}}!', next_node_key: 'done' } },
        { node_key: 'done', node_type: 'end', config: {} },
      ]);
      await withTenant(member, (tx) => publishFlow(tx, { accountId: A, flowId: flow, userId: ownerA, caps: ALL_CAPABILITIES }));
      const c = await waContact();
      const say = (text: string) => withJobScope({ accountId: A, role: 'owner' }, () => dispatchInboundToFlows({
        accountId: A, userId: ownerA, contactId: c.contact, conversationId: c.conversation,
        message: { kind: 'text', text, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false,
      }));
      await say('hello5');
      await say('Asha');
      expect(h.waSend.mock.calls.map((call) => call[0].text ?? call[0].bodyText)).toEqual(['Your name?', 'Thanks Asha!']);
      expect((await q('SELECT status, end_reason FROM flow_runs WHERE flow_id=$1', [flow])).rows).toEqual([{ status: 'completed', end_reason: 'end_node' }]);
    });

    it('an Actions step retried after a failure resumes at the failed action and never repeats a finished one', async () => {
      const tag = (await q("INSERT INTO tags(account_id,user_id,name) VALUES($1,$2,'s5-tag') RETURNING id", [A, ownerA])).rows[0].id as string;
      await q("INSERT INTO workspace_attributes(account_id,key,value) VALUES($1,'s5_orders','41')", [A]);
      const flow = await waFlow(A, ownerA, 'actions5', [{ node_key: 'start', node_type: 'start', config: {} }], 'draft');
      const c = await waContact();
      const runId = (await q(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
        VALUES($1,$2,$3,$4,$5,'active','act') RETURNING id`, [A, flow, ownerA, c.contact, c.conversation])).rows[0].id as string;
      const run = (await q('SELECT * FROM flow_runs WHERE id=$1', [runId])).rows[0] as FlowRunRow;
      const actions: FlowAction[] = [
        { type: 'set_workspace_field', key: 's5_orders', mode: 'increment', value: '1' },
        { type: 'add_tag', tag_id: tag },
        { type: 'remove_tag', tag_id: tag },
      ];
      const { databaseAdmin } = await import('./admin-client');
      const ctx = { db: databaseAdmin({ accountId: A, role: 'owner' }), run, nodeKey: 'act', channel: 'whatsapp' as const, flowName: 'WA',
        interpolate: async (text: string) => text };
      h.failRemoveOnce = true;
      await expect(withJobScope({ accountId: A, role: 'owner' }, () => runActions(ctx, actions))).rejects.toThrow('connection reset');
      // The cursor survives in the run row (two actions finished).
      const stored = (await q('SELECT vars FROM flow_runs WHERE id=$1', [runId])).rows[0].vars;
      expect(stored['_act:act']).toBe(2);
      // A retry reads the run again, as a replay or a new worker would.
      const reloaded = (await q('SELECT * FROM flow_runs WHERE id=$1', [runId])).rows[0] as FlowRunRow;
      const result = await withJobScope({ accountId: A, role: 'owner' }, () => runActions({ ...ctx, run: reloaded }, actions));
      expect(result.ran).toEqual(['remove_tag']);
      expect((await q("SELECT value FROM workspace_attributes WHERE account_id=$1 AND key='s5_orders'", [A])).rows[0].value).toBe('42');
      expect((await q('SELECT count(*)::int AS n FROM contact_tags WHERE contact_id=$1', [c.contact])).rows[0].n).toBe(0);
      expect((await q('SELECT vars FROM flow_runs WHERE id=$1', [runId])).rows[0].vars['_act:act']).toBeUndefined();
    });

    it('start_flow starts the queued flow once the run completes, and never after the run was cancelled', async () => {
      const queued = await waFlow(A, ownerA, 'queued5', [
        { node_key: 'start', node_type: 'start', config: { next_node_key: 'hi' } },
        { node_key: 'hi', node_type: 'send_message', config: { text: 'From the queued flow', next_node_key: 'end' } },
        { node_key: 'end', node_type: 'end', config: {} },
      ]);
      await withTenant(member, (tx) => publishFlow(tx, { accountId: A, flowId: queued, userId: ownerA, caps: ALL_CAPABILITIES }));
      const act = { node_key: 'act', node_type: 'actions', config: { actions: [{ type: 'start_flow', flow_id: queued }], next_node_key: 'bye' } };
      const chain = await waFlow(A, ownerA, 'chain5', [
        { node_key: 'start', node_type: 'start', config: { next_node_key: 'act' } }, act,
        { node_key: 'bye', node_type: 'send_message', config: { text: 'Bye', next_node_key: 'end' } },
        { node_key: 'end', node_type: 'end', config: {} },
      ]);
      await withTenant(member, (tx) => publishFlow(tx, { accountId: A, flowId: chain, userId: ownerA, caps: ALL_CAPABILITIES }));
      const waiting = await waFlow(A, ownerA, 'later5', [
        { node_key: 'start', node_type: 'start', config: { next_node_key: 'act' } }, { ...act, config: { ...act.config, next_node_key: 'd' } },
        { node_key: 'd', node_type: 'smart_delay', config: { mode: 'duration', amount: 1, unit: 'hours', next_node_key: 'bye' } },
        { node_key: 'bye', node_type: 'send_message', config: { text: 'Bye', next_node_key: 'end' } },
        { node_key: 'end', node_type: 'end', config: {} },
      ]);
      await withTenant(member, (tx) => publishFlow(tx, { accountId: A, flowId: waiting, userId: ownerA, caps: ALL_CAPABILITIES }));
      const say = (c: { contact: string; conversation: string }, text: string) => withJobScope({ accountId: A, role: 'owner' }, () => dispatchInboundToFlows({
        accountId: A, userId: ownerA, contactId: c.contact, conversationId: c.conversation,
        message: { kind: 'text', text, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false,
      }));

      // Completed: the queued flow starts after it, one hop deep.
      const done = await waContact();
      await say(done, 'chain5');
      expect(h.waSend.mock.calls.map((call) => call[0].text)).toEqual(['Bye', 'From the queued flow']);
      const started = (await q('SELECT status, vars FROM flow_runs WHERE flow_id=$1 AND contact_id=$2', [queued, done.contact])).rows;
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ status: 'completed', vars: { _start_depth: 1 } });

      // Cancelled while waiting (the contact was blocked): nothing more starts for them.
      h.waSend.mockClear();
      const blocked = await waContact();
      await say(blocked, 'later5');
      const run = (await q('SELECT id FROM flow_runs WHERE flow_id=$1 AND contact_id=$2', [waiting, blocked.contact])).rows[0];
      const [timer] = (await q("SELECT payload FROM jobs WHERE type='flow.timer' AND payload->>'runId'=$1", [run.id])).rows;
      await q('UPDATE contacts SET blocked_at=now() WHERE id=$1', [blocked.contact]);
      await withJobScope({ accountId: A, role: 'owner' }, () => handleFlowTimer({ accountId: A, ...timer.payload }));
      expect(await runOf(run.id)).toMatchObject({ status: 'cancelled' });
      expect((await q('SELECT count(*)::int AS n FROM flow_runs WHERE flow_id=$1 AND contact_id=$2', [queued, blocked.contact])).rows[0].n).toBe(0);
      expect(h.waSend).not.toHaveBeenCalled();
    });

    it('never writes a secret workspace field, even through the worker connection directly', async () => {
      await q("INSERT INTO workspace_attributes(account_id,key,value_encrypted,is_secret) VALUES($1,'s5_secret','enc','true')", [A]);
      const result = await withTenant({ accountId: A, role: 'owner' }, (tx) =>
        writeWorkspaceAttribute(tx, A, { key: 's5_secret', mode: 'set', value: 'leak' }), getWorkerPrisma());
      expect(result).toBe('secret');
      const updated = await withTenant({ accountId: A, role: 'owner' }, (tx) =>
        tx.$executeRaw`UPDATE workspace_attributes SET value='leak' WHERE account_id=${A}::uuid AND key='s5_secret'`, getWorkerPrisma());
      expect(updated).toBe(0);
      // Nor can it rename a key or flip is_secret (column grants).
      await expect(withTenant({ accountId: A, role: 'owner' }, (tx) =>
        tx.$executeRaw`UPDATE workspace_attributes SET is_secret=false WHERE account_id=${A}::uuid AND key='s5_secret'`, getWorkerPrisma())).rejects.toThrow();
      expect((await q("SELECT value, is_secret FROM workspace_attributes WHERE account_id=$1 AND key='s5_secret'", [A])).rows[0])
        .toEqual({ value: null, is_secret: true });
    });

    it('cross-tenant segment, workspace field, flow and node-stats ids are refused', async () => {
      const segmentB = (await q(`INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,'B only',$3) RETURNING id`,
        [B, ownerB, JSON.stringify({ conditions: [{ field: 'blocked', op: 'is', value: false }] })])).rows[0].id as string;
      const segmentA = (await q(`INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,'A all',$3) RETURNING id`,
        [A, ownerA, JSON.stringify({ conditions: [{ field: 'blocked', op: 'is', value: false }] })])).rows[0].id as string;
      await q("INSERT INTO workspace_attributes(account_id,key,value) VALUES($1,'s5_b_only','secret-ish')", [B]);
      const c = await waContact();
      const worker = <T,>(work: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>) =>
        withTenant({ accountId: A, role: 'owner' }, work, getWorkerPrisma());
      expect(await worker((tx) => contactInSegment(tx, A, segmentA, c.contact))).toBe(true);
      expect(await worker((tx) => contactInSegment(tx, A, segmentB, c.contact))).toBeNull();
      expect(await workspaceFieldSubject(A, 's5_b_only')).toBeUndefined();

      // stop_flow with another workspace's flow id touches nothing there.
      const flowB = await waFlow(B, ownerB, 'b5', [{ node_key: 'start', node_type: 'start', config: {} }]);
      const cb = await waContact(B, ownerB);
      const runB = (await q(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
        VALUES($1,$2,$3,$4,$5,'active','start') RETURNING id`, [B, flowB, ownerB, cb.contact, cb.conversation])).rows[0].id as string;
      const flowA = await waFlow(A, ownerA, 'a5', [{ node_key: 'start', node_type: 'start', config: {} }], 'draft');
      const runA = (await q(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
        VALUES($1,$2,$3,$4,$5,'active','act') RETURNING *`, [A, flowA, ownerA, c.contact, c.conversation])).rows[0] as FlowRunRow;
      const { databaseAdmin } = await import('./admin-client');
      await withJobScope({ accountId: A, role: 'owner' }, () => runActions({ db: databaseAdmin({ accountId: A, role: 'owner' }), run: runA, nodeKey: 'act',
        channel: 'whatsapp', flowName: 'A', interpolate: async (t) => t }, [{ type: 'stop_flow', flow_id: flowB }]));
      expect((await q('SELECT status FROM flow_runs WHERE id=$1', [runB])).rows[0].status).toBe('active');

      // Node stats: this workspace's flow only.
      expect(await withTenant(member, (tx) => readNodeStats(tx, A, flowA))).toEqual({ act: { waiting: 1, passed: 0 } });
      expect(await withTenant(member, (tx) => readNodeStats(tx, A, flowB))).toBeNull();
    });

    it('a stale autosave writes nothing; publishing snapshots extra triggers and ends username testing', async () => {
      // Workspace B, which has room under any plan's live-flow limit.
      const memberB = { accountId: B, userId: ownerB, role: 'owner' as const };
      const flow = await liveIgFlow(B, ownerB, { type: 'keyword', config: { keywords: ['snap5'] } },
        [{ trigger_type: 'ig_story_reply', config: {} }], [
          { node_key: 'start', node_type: 'start', config: { next_node_key: 'msg' } },
          { node_key: 'msg', node_type: 'send_message', config: { text: 'Hi', next_node_key: 'end' } },
          { node_key: 'end', node_type: 'end', config: {} },
        ], 'draft', ['tester.two']);
      const [{ updated_at: stored }] = (await q('SELECT updated_at FROM flows WHERE id=$1', [flow])).rows;
      const stale = new Date(new Date(stored).getTime() - 5_000).toISOString();
      const refused = await withTenant(memberB, (tx) => saveDraft(tx, { accountId: B, flowId: flow, patch: { name: 'Mine' }, baseUpdatedAt: stale }))
        .then(() => null, (e: unknown) => e);
      expect(refused).toBeInstanceOf(FlowVersionError);
      expect((refused as FlowVersionError).code).toBe('draft_changed');
      expect((await q('SELECT name FROM flows WHERE id=$1', [flow])).rows[0].name).toBe('Stage 5 flow');
      // The editor's own last-seen time (millisecond precision) passes.
      await withTenant(memberB, (tx) => saveDraft(tx, { accountId: B, flowId: flow, patch: { name: 'Mine' }, baseUpdatedAt: new Date(stored).toISOString() }));
      expect((await q('SELECT name FROM flows WHERE id=$1', [flow])).rows[0].name).toBe('Mine');

      // A run counted while the editor is open moves updated_at, not the draft marker: the next autosave still passes.
      const [{ draft_saved_at: marker }] = (await q('SELECT draft_saved_at FROM flows WHERE id=$1', [flow])).rows;
      expect(marker).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await q('UPDATE flows SET execution_count=execution_count+1 WHERE id=$1', [flow]);
      const notes = [{ id: 'n1', text: 'Size first', x: 1, y: 2 }];
      await withTenant(memberB, (tx) => saveDraft(tx, { accountId: B, flowId: flow, patch: { canvas_notes: notes },
        baseUpdatedAt: new Date(marker).toISOString() }));
      expect((await q('SELECT canvas_notes FROM flows WHERE id=$1', [flow])).rows[0].canvas_notes).toEqual(notes);
      // That save moved the marker, so the base from before it is now stale.
      const second = await withTenant(memberB, (tx) => saveDraft(tx, { accountId: B, flowId: flow, patch: { name: 'Other tab' },
        baseUpdatedAt: new Date(marker).toISOString() })).then(() => null, (e: unknown) => e);
      expect((second as FlowVersionError).code).toBe('draft_changed');

      await withTenant(memberB, (tx) => publishFlow(tx, { accountId: B, flowId: flow, userId: ownerB, caps: ALL_CAPABILITIES }));
      const row = (await q(`SELECT f.test_usernames, v.extra_triggers FROM flows f JOIN flow_versions v ON v.id=f.published_version_id WHERE f.id=$1`, [flow])).rows[0];
      expect(row).toEqual({ test_usernames: [], extra_triggers: [{ trigger_type: 'ig_story_reply', config: {} }] });
    });
  });
});
