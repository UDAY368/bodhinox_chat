// Stage 2C on a real PostgreSQL: comment flows. A delivered comment is
// recorded and queued like the worker does, then the private-reply job starts
// the ig_comment flow. Proves: the run starts once and the private reply goes
// out once per comment (shared intent with the legacy rule, which is skipped);
// the opening-button tap opens the window and resumes the run; a run that
// resumes past 24 hours ends with window_closed; the hourly guard holds the
// reply back; the account's own comments are ignored; and nothing crosses
// workspaces. Meta is never called: fetch is stubbed per test.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';
import { dispatchInboundToFlows, handleFlowTimer, startCommentFlow } from '@/lib/flows/engine';
import { persistInstagramWebhook } from './webhook';
import { processInstagramWebhookJob } from './process-webhook';
import { PRIVATE_REPLY_HOURLY_GUARD, handlePrivateReplyJob, runCommentFlowJob } from './private-reply';

const webhook = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: webhook.dispatch }));

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
const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
const igUserA = `81${seed}`, igUserA2 = `84${seed}`, igUserB = `82${seed}`;
const SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments'];
let owner: pg.Client;
let igA = '', igA2 = '', igB = '', flowA = '', flowB = '';
const receipts: string[] = [];
let n = 0;
const next = (prefix: string) => `${prefix}${seed}${String(++n).padStart(4, '0')}`;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Graph stub: messages, comment replies and the media list; every call is recorded. */
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
const calls = (fetchMock: ReturnType<typeof graphStub>, part: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(part)).map((c) => JSON.parse(String(c[1]?.body ?? "{}")));

const NODES = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'pr' } },
  { node_key: 'pr', node_type: 'ig_private_reply',
    config: { text: 'Want the link?', opt_in_label: 'Send it', next_node_key: 'link', timeout_minutes: 60, after_timeout: 'link' } },
  { node_key: 'link', node_type: 'send_message', config: { text: 'https://shop.example/x', next_node_key: 'done' } },
  { node_key: 'done', node_type: 'end', config: {} },
];

async function addFlow(accountId: string, userId: string, triggerConfig: Record<string, unknown>): Promise<string> {
  const flow = (await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,entry_node_id,channel_scope)
    VALUES($1,$2,'Comment flow','ig_comment',$3,'start','instagram') RETURNING id`, [accountId, userId, triggerConfig])).rows[0].id as string;
  const version = (await owner.query(`INSERT INTO flow_versions(account_id,flow_id,version,trigger_type,trigger_config,entry_node_id,
      fallback_policy,channel_scope,nodes,published_by)
    VALUES($1,$2,1,'ig_comment',$3,'start','{}'::jsonb,'instagram',$4,$5) RETURNING id`,
    [accountId, flow, triggerConfig, JSON.stringify(NODES), userId])).rows[0].id as string;
  await owner.query("UPDATE flows SET status='active', published_version_id=$1 WHERE id=$2", [version, flow]);
  return flow;
}

async function deliver(body: Record<string, unknown>): Promise<void> {
  const receiptId = await persistInstagramWebhook(JSON.stringify(body), body);
  receipts.push(receiptId);
  await processInstagramWebhookJob({ receiptId });
}
const comment = (accountIgId: string, value: Record<string, unknown>) =>
  ({ object: 'instagram', entry: [{ id: accountIgId, time: Date.now(), changes: [{ field: 'comments', value }] }] });
const eventOf = async (commentId: string) => (await owner.query(
  `SELECT id, account_id, private_reply_status AS status, flow_run_id, public_reply_id, opted_in_at, rule_id
   FROM instagram_comment_events WHERE comment_id=$1`, [commentId])).rows[0] as
  { id: string; account_id: string; status: string; flow_run_id: string | null; public_reply_id: string | null; opted_in_at: Date | null; rule_id: string | null } | undefined;
const jobPayload = async (eventId: string) => (await owner.query(
  "SELECT payload FROM jobs WHERE type='instagram.private_reply' AND dedupe_key=$1", [`igpr:${eventId}`])).rows[0]?.payload as Record<string, unknown> | undefined;
const runOf = async (id: string) => (await owner.query(
  'SELECT id, flow_id, contact_id, conversation_id, status, end_reason, current_node_key, transition_seq, delay_until, vars FROM flow_runs WHERE id=$1', [id])).rows[0];
const intent = async (accountId: string, key: string) => (await owner.query(
  'SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${accountId}:${key}`])).rows[0]?.status ?? null;
const runJob = (accountId: string, payload: Record<string, unknown>) =>
  withJobScope({ accountId, role: 'owner' }, () => handlePrivateReplyJob(accountId, payload));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram comment flows on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Comment flow test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Comment flows A',$2),($3,'Comment flows B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const addAccount = async (accountId: string, userId: string, igUserId: string) => (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`, [accountId, igUserId, encrypt('test-only-ig-token'), SCOPES, userId])).rows[0].id as string;
    igA = await addAccount(accountA, ownerA, igUserA);
    igA2 = await addAccount(accountA, ownerA, igUserA2);
    igB = await addAccount(accountB, ownerB, igUserB);
    // A legacy rule that also matches: the flow must take the comment, and the rule must not send a second reply.
    await owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,keywords,reply_text,created_by_user_id)
      VALUES($1,$2,ARRAY['price'],'Rule reply',$3)`, [accountA, igA, ownerA]);
    flowA = await addFlow(accountA, ownerA, { post_scope: 'any', include_keywords: ['price'], public_replies: ['Sent you a DM'] });
    flowB = await addFlow(accountB, ownerB, { post_scope: 'any' });
  });
  beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      if (receipts.length) {
        await owner.query("DELETE FROM jobs WHERE type='instagram.webhook' AND payload->>'receiptId' = ANY($1::text[])", [receipts]);
        await owner.query('DELETE FROM webhook_receipts WHERE id=ANY($1::uuid[])', [receipts]);
      }
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('a comment starts the flow once: public reply, one private reply with the opening button, legacy rule skipped', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const commentId = next('18'), commenter = next('7'), media = next('17');
    await deliver(comment(igUserA, { id: commentId, text: 'PRICE please', media: { id: media }, from: { id: commenter } }));
    const event = (await eventOf(commentId))!;
    expect(event).toMatchObject({ status: 'queued', rule_id: null, flow_run_id: null });
    const payload = (await jobPayload(event.id))!;
    expect(payload).toMatchObject({ eventId: event.id, flows: [{ flowId: flowA, check: false }], fallbackRuleId: expect.any(String) });
    expect(JSON.stringify(payload)).not.toContain('PRICE');

    await runJob(accountA, payload);
    const linked = (await eventOf(commentId))!;
    expect(linked).toMatchObject({ status: 'sent', flow_run_id: expect.any(String), public_reply_id: expect.stringMatching(/^\d+$/) });
    const run = await runOf(linked.flow_run_id!);
    expect(run).toMatchObject({ flow_id: flowA, status: 'active', current_node_key: 'pr' });
    expect(run.vars).toMatchObject({ ig_comment_event_id: event.id, ig_comment_id: commentId, ig_media_id: media });
    const privateReplies = calls(fetchMock, '/messages');
    expect(privateReplies).toEqual([{ recipient: { comment_id: commentId },
      message: { text: 'Want the link?', quick_replies: [{ content_type: 'text', title: 'Send it', payload: `optin:${run.id}:pr` }] } }]);
    expect(calls(fetchMock, '/replies')).toEqual([{ message: 'Sent you a DM' }]);
    expect(await intent(accountA, `ig_private_reply:${commentId}`)).toBe('accepted');
    expect(await intent(accountA, `ig-comment-reply:${commentId}`)).toBe('accepted');

    // The job again (a retry), and the rule's own reply path: nothing more is sent.
    await runJob(accountA, payload);
    await runJob(accountA, { eventId: event.id });
    expect(calls(fetchMock, '/messages')).toHaveLength(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM flow_runs WHERE flow_id=$1 AND contact_id=$2', [flowA, run.contact_id])).rows[0].n).toBe(1);

    // A second comment by the same person on the same post is not offered to the flow (the rule answers it).
    const again = next('18');
    await deliver(comment(igUserA, { id: again, text: 'price?', media: { id: media }, from: { id: commenter } }));
    const second = (await eventOf(again))!;
    expect(await jobPayload(second.id)).toEqual({ accountId: accountA, eventId: second.id });
  });

  it('the opening-button tap opens the window and resumes the run', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const commentId = next('18'), commenter = next('7');
    await deliver(comment(igUserA, { id: commentId, text: 'price', media: { id: next('17') }, from: { id: commenter } }));
    const event = (await eventOf(commentId))!;
    await runJob(accountA, (await jobPayload(event.id))!);
    const run = await runOf((await eventOf(commentId))!.flow_run_id!);
    // The tap arrives as a quick reply in the DM thread (stored as the customer's message).
    const mid = `mid-tap-${commenter}`;
    await deliver({ object: 'instagram', entry: [{ id: igUserA, time: Date.now(), messaging: [{
      sender: { id: commenter }, recipient: { id: igUserA }, timestamp: Date.now() - 1000,
      message: { mid, text: 'Send it', quick_reply: { payload: `optin:${run.id}:pr` } } }] }] });
    const result = await withJobScope({ accountId: accountA, role: 'owner' }, () => dispatchInboundToFlows({
      accountId: accountA, userId: ownerA, contactId: run.contact_id, conversationId: run.conversation_id,
      message: { kind: 'interactive_reply', reply_id: `optin:${run.id}:pr`, reply_title: 'Send it', meta_message_id: mid },
      isFirstInboundMessage: false,
    }));
    expect(result.consumed).toBe(true);
    expect((await runOf(run.id))).toMatchObject({ status: 'completed' });
    expect((await eventOf(commentId))!.opted_in_at).toBeInstanceOf(Date);
    const dms = calls(fetchMock, '/messages');
    expect(dms[dms.length - 1]).toEqual({ recipient: { id: commenter }, message: { text: 'https://shop.example/x' } });
  });

  it('a run that resumes past the 24-hour window ends with window_closed and sends nothing', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const commentId = next('18');
    await deliver(comment(igUserA, { id: commentId, text: 'price', media: { id: next('17') }, from: { id: next('7') } }));
    const event = (await eventOf(commentId))!;
    await runJob(accountA, (await jobPayload(event.id))!);
    const run = await runOf((await eventOf(commentId))!.flow_run_id!);
    const before = calls(fetchMock, '/messages').length;
    // The opening button was never tapped: the reply timeout moves the run on, and the customer never wrote.
    expect(await withJobScope({ accountId: accountA, role: 'owner' }, () => handleFlowTimer({
      accountId: accountA, runId: run.id, nodeKey: 'pr', seq: run.transition_seq, kind: 'timeout' }))).toBe('fired');
    expect(await runOf(run.id)).toMatchObject({ status: 'cancelled', end_reason: 'window_closed' });
    expect(calls(fetchMock, '/messages')).toHaveLength(before);
  });

  it('holds the private reply back at the hourly guard: the step waits and retries, nothing is sent', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    await owner.query(`INSERT INTO instagram_comment_events(account_id,instagram_account_id,comment_id,private_reply_status,private_reply_at)
      SELECT $1,$2,'19' || $3 || lpad(g::text,5,'0'),'sent',now() - interval '5 minutes' FROM generate_series(1,$4) g`,
    [accountA, igA2, seed, PRIVATE_REPLY_HOURLY_GUARD]);
    const commentId = next('18');
    await deliver(comment(igUserA2, { id: commentId, text: 'price', media: { id: next('17') }, from: { id: next('7') } }));
    const event = (await eventOf(commentId))!;
    await runJob(accountA, (await jobPayload(event.id))!);
    const held = (await eventOf(commentId))!;
    expect(held.status).toBe('queued');
    const run = await runOf(held.flow_run_id!);
    expect(run).toMatchObject({ status: 'active', current_node_key: 'pr', delay_until: expect.any(Date) });
    expect(calls(fetchMock, '/messages')).toHaveLength(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='flow.timer' AND payload->>'runId'=$1", [run.id])).rows[0].n).toBe(1);
  });

  it("ignores the account's own comments", async () => {
    const commentId = next('18');
    await deliver(comment(igUserA, { id: commentId, text: 'price', media: { id: next('17') }, from: { id: igUserA } }));
    expect(await eventOf(commentId)).toBeUndefined();
  });

  it('keeps every comment flow inside its own workspace', async () => {
    const fetchMock = graphStub();
    vi.stubGlobal('fetch', fetchMock);
    const commentB = next('18');
    await deliver(comment(igUserB, { id: commentB, text: 'hello', media: { id: next('17') }, from: { id: next('7') } }));
    const eventB = (await eventOf(commentB))!;
    expect(eventB.account_id).toBe(accountB);
    // B's comment, its event and its flow are invisible to A's worker scope.
    expect(await withJobScope({ accountId: accountA, role: 'owner' }, () =>
      startCommentFlow({ accountId: accountA, eventId: eventB.id, flowId: flowB }))).toBe('unavailable');
    expect(await withJobScope({ accountId: accountA, role: 'owner' }, () =>
      runCommentFlowJob(accountA, { eventId: eventB.id, flows: [{ flowId: flowB, check: false }], fallbackRuleId: null }))).toBe('noop');
    // A's flow never answers B's comment: B's own job starts B's flow.
    expect((await jobPayload(eventB.id))!.flows).toEqual([{ flowId: flowB, check: false }]);
    await runJob(accountB, (await jobPayload(eventB.id))!);
    const run = await runOf((await eventOf(commentB))!.flow_run_id!);
    expect(run.flow_id).toBe(flowB);
    expect((await owner.query('SELECT count(*)::int AS n FROM flow_runs WHERE flow_id=$1 AND id=$2', [flowA, run.id])).rows[0].n).toBe(0);
    expect(igB).toBeTruthy();
  });
});
