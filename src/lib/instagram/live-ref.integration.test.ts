// Stage 3B on a real PostgreSQL: Live comments, ref links, click-to-Direct ads
// and the webhook resubscribe. Deliveries are persisted and processed like the
// worker does; Meta is never called (fetch is stubbed per test). Proves:
//   - a Live comment (live_comments) starts only the ig_live_comment flows, once
//     per person per broadcast for the first MATCHING comment, never a post
//     comment flow and never a legacy rule; a redelivery sends nothing twice;
//   - a ref in a DM is saved on the sender's identity (only a ref we would
//     store, never moving back to an older message), starts the matching
//     ig_ref flow once, and a referral on its own only updates a known sender;
//   - a click-to-Direct ad message starts the ad_click flow and, with the
//     INSTAGRAM_CTD_WINDOW_ENABLED flag, opens the 7-day window for automated
//     sends (an ordinary or ref link message does not);
//   - accounts connected earlier are resubscribed with live_comments once, and
//     only those holding the comments scope;
//   - nothing crosses workspaces: flows, links and subscriptions.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { instagramAutomatedWindowOpen } from '@/lib/channels/sender';
import { persistInstagramWebhook } from './webhook';
import { processInstagramWebhookJob } from './process-webhook';
import { handlePrivateReplyJob } from './private-reply';
import { listRefLinks } from './ref-link-list';
import { RESUBSCRIBE_VERSION, runResubscribe, scheduleInstagramResubscribe } from './resubscribe';

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
const igUserA = `91${seed}`, igUserA2 = `94${seed}`, igUserB = `92${seed}`;
const DM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_messages'];
const SCOPES = [...DM_SCOPES, 'instagram_business_manage_comments'];
let owner: pg.Client;
let igA = '', igA2 = '';
let liveFlowA = '', postFlowA = '', refFlowA = '', adFlowA = '', refFlowB = '';
const receipts: string[] = [];
let n = 0;
const next = (prefix: string) => `${prefix}${seed}${String(++n).padStart(4, '0')}`;
const DAY = 24 * 3_600_000;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Graph stub: messages, comment replies, the media list and subscribed_apps; every call is recorded. */
function graphStub() {
  return vi.fn(async (input: string | URL, _init?: RequestInit) => {
    void _init;
    const url = String(input);
    if (url.includes('/subscribed_apps')) return json(200, { success: true });
    if (url.includes('/replies')) return json(200, { id: `179${seed}${String(++n).padStart(4, '0')}` });
    if (url.includes('/messages')) return json(200, { recipient_id: '9001', message_id: `mid.${randomUUID()}` });
    if (url.includes('/media')) return json(200, { data: [] });
    return json(404, { error: { message: 'unexpected', code: 100 } });
  });
}
const calls = (fetchMock: ReturnType<typeof graphStub>, part: string) =>
  fetchMock.mock.calls.filter((c) => String(c[0]).includes(part));
const bodies = (fetchMock: ReturnType<typeof graphStub>, part: string) =>
  calls(fetchMock, part).map((c) => JSON.parse(String(c[1]?.body ?? '{}')));

const COMMENT_NODES = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'pr' } },
  { node_key: 'pr', node_type: 'ig_private_reply',
    config: { text: 'Want the link?', opt_in_label: 'Send it', next_node_key: 'link', timeout_minutes: 60, after_timeout: 'link' } },
  { node_key: 'link', node_type: 'send_message', config: { text: 'https://shop.example/x', next_node_key: 'done' } },
  { node_key: 'done', node_type: 'end', config: {} },
];
const HELLO_NODES = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'hello' } },
  { node_key: 'hello', node_type: 'send_message', config: { text: 'Welcome!', next_node_key: 'done' } },
  { node_key: 'done', node_type: 'end', config: {} },
];

async function addFlow(accountId: string, userId: string, triggerType: string, triggerConfig: Record<string, unknown>,
  nodes: unknown[]): Promise<string> {
  const flow = (await owner.query(`INSERT INTO flows(account_id,user_id,name,trigger_type,trigger_config,entry_node_id,channel_scope)
    VALUES($1,$2,$3,$4,$5,'start','instagram') RETURNING id`, [accountId, userId, `${triggerType} flow`, triggerType, triggerConfig])).rows[0].id as string;
  const version = (await owner.query(`INSERT INTO flow_versions(account_id,flow_id,version,trigger_type,trigger_config,entry_node_id,
      fallback_policy,channel_scope,nodes,published_by)
    VALUES($1,$2,1,$3,$4,'start','{}'::jsonb,'instagram',$5,$6) RETURNING id`,
    [accountId, flow, triggerType, triggerConfig, JSON.stringify(nodes), userId])).rows[0].id as string;
  await owner.query("UPDATE flows SET status='active', published_version_id=$1 WHERE id=$2", [version, flow]);
  return flow;
}

async function deliver(body: Record<string, unknown>): Promise<void> {
  const receiptId = await persistInstagramWebhook(JSON.stringify(body), body);
  receipts.push(receiptId);
  await processInstagramWebhookJob({ receiptId });
}
const change = (accountIgId: string, field: 'comments' | 'live_comments', value: Record<string, unknown>) =>
  ({ object: 'instagram', entry: [{ id: accountIgId, time: Date.now() + (++n), changes: [{ field, value }] }] });
const dm = (accountIgId: string, from: string, mid: string, text: string, extra: Record<string, unknown> = {}, at = Date.now() - 1000) =>
  ({ object: 'instagram', entry: [{ id: accountIgId, time: Date.now() + (++n), messaging: [{
    sender: { id: from }, recipient: { id: accountIgId }, timestamp: at, message: { mid, text, ...extra } }] }] });
const referralOnly = (accountIgId: string, from: string, referral: Record<string, unknown>) =>
  ({ object: 'instagram', entry: [{ id: accountIgId, time: Date.now() + (++n), messaging: [{
    sender: { id: from }, recipient: { id: accountIgId }, timestamp: Date.now() - 500, referral }] }] });

const eventOf = async (commentId: string) => (await owner.query(
  `SELECT id, account_id, private_reply_status AS status, flow_run_id, public_reply_id, rule_id
   FROM instagram_comment_events WHERE comment_id=$1`, [commentId])).rows[0] as
  { id: string; account_id: string; status: string; flow_run_id: string | null; public_reply_id: string | null; rule_id: string | null } | undefined;
const jobPayload = async (eventId: string) => (await owner.query(
  "SELECT payload FROM jobs WHERE type='instagram.private_reply' AND dedupe_key=$1", [`igpr:${eventId}`])).rows[0]?.payload as Record<string, unknown> | undefined;
const runOf = async (id: string) => (await owner.query(
  'SELECT id, flow_id, contact_id, conversation_id, status, current_node_key, vars FROM flow_runs WHERE id=$1', [id])).rows[0];
const runJob = (accountId: string, payload: Record<string, unknown>) =>
  withJobScope({ accountId, role: 'owner' }, () => handlePrivateReplyJob(accountId, payload));
const identityOf = async (accountId: string, igsid: string) => (await owner.query(
  `SELECT i.id, i.contact_id, i.last_ref, i.last_ref_at, c.id AS conversation_id
   FROM contact_channel_identities i LEFT JOIN conversations c ON c.account_id=i.account_id AND c.contact_id=i.contact_id
   WHERE i.account_id=$1 AND i.external_id=$2`, [accountId, igsid])).rows[0] as
  { id: string; contact_id: string; last_ref: string | null; last_ref_at: Date | null; conversation_id: string } | undefined;
const runsOf = async (flowId: string, contactId: string) => (await owner.query(
  'SELECT id, vars FROM flow_runs WHERE flow_id=$1 AND contact_id=$2', [flowId, contactId])).rows as { id: string; vars: Record<string, unknown> }[];
const actor = (accountId: string, userId: string) => ({ accountId, userId, role: 'agent' as const });

/** What the inbound job does for a stored text message: offers it to the flows. */
async function dispatchText(accountId: string, userId: string, igsid: string, mid: string, text: string) {
  const id = (await identityOf(accountId, igsid))!;
  return withJobScope({ accountId, role: 'owner' }, () => dispatchInboundToFlows({
    accountId, userId, contactId: id.contact_id, conversationId: id.conversation_id,
    message: { kind: 'text', text, meta_message_id: mid }, isFirstInboundMessage: true,
  }));
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Instagram Live comments, ref links and ads on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Live ref test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[ownerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Live ref A',$2),($3,'Live ref B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')", [accountA, ownerA, accountB, ownerB]);
    const addAccount = async (accountId: string, userId: string, igUserId: string, scopes: string[]) => (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [accountId, igUserId, `shop${igUserId.slice(0, 2)}`, encrypt('test-only-ig-token'), scopes, userId])).rows[0].id as string;
    igA = await addAccount(accountA, ownerA, igUserA, SCOPES);
    igA2 = await addAccount(accountA, ownerA, igUserA2, DM_SCOPES);
    await addAccount(accountB, ownerB, igUserB, SCOPES);
    // A legacy rule that would match any comment saying "link": a Live comment must never use it.
    await owner.query(`INSERT INTO instagram_comment_rules(account_id,instagram_account_id,keywords,reply_text,created_by_user_id)
      VALUES($1,$2,ARRAY['link'],'Rule reply',$3)`, [accountA, igA, ownerA]);
    liveFlowA = await addFlow(accountA, ownerA, 'ig_live_comment', { keywords: ['link'] }, COMMENT_NODES);
    postFlowA = await addFlow(accountA, ownerA, 'ig_comment', { post_scope: 'any' }, COMMENT_NODES);
    refFlowA = await addFlow(accountA, ownerA, 'ig_ref', { refs: ['summer-sale'] }, HELLO_NODES);
    adFlowA = await addFlow(accountA, ownerA, 'ad_click', {}, HELLO_NODES);
    refFlowB = await addFlow(accountB, ownerB, 'ig_ref', { refs: ['summer-sale'] }, HELLO_NODES);
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

  describe('Live comments', () => {
    it('starts the live flow once with one private reply, and never a post flow or the legacy rule', async () => {
      const fetchMock = graphStub();
      vi.stubGlobal('fetch', fetchMock);
      const commentId = next('18'), commenter = next('7'), broadcast = next('17');
      await deliver(change(igUserA, 'live_comments', { id: commentId, text: 'Link please', media: { id: broadcast, media_product_type: 'LIVE' }, from: { id: commenter } }));
      const event = (await eventOf(commentId))!;
      expect(event).toMatchObject({ status: 'queued', rule_id: null, flow_run_id: null });
      const payload = (await jobPayload(event.id))!;
      expect(payload).toMatchObject({ eventId: event.id, flows: [{ flowId: liveFlowA, check: false }], fallbackRuleId: null });
      expect(JSON.stringify(payload)).not.toContain('Link please');

      await runJob(accountA, payload);
      const linked = (await eventOf(commentId))!;
      expect(linked).toMatchObject({ status: 'sent', flow_run_id: expect.any(String), public_reply_id: null });
      const run = await runOf(linked.flow_run_id!);
      expect(run).toMatchObject({ flow_id: liveFlowA, status: 'active', current_node_key: 'pr' });
      expect(run.vars).toMatchObject({ ig_comment_event_id: event.id, ig_comment_id: commentId, ig_media_id: broadcast });
      // One private reply to the comment, no public reply (a Live comment gets none), no legacy rule text.
      expect(bodies(fetchMock, '/messages')).toEqual([{ recipient: { comment_id: commentId },
        message: { text: 'Want the link?', quick_replies: [{ content_type: 'text', title: 'Send it', payload: `optin:${run.id}:pr` }] } }]);
      expect(calls(fetchMock, '/replies')).toHaveLength(0);

      // The job again (a retry): nothing more is sent and no second run starts.
      await runJob(accountA, payload);
      expect(calls(fetchMock, '/messages')).toHaveLength(1);
      expect((await owner.query('SELECT count(*)::int AS n FROM flow_runs WHERE contact_id=$1', [run.contact_id])).rows[0].n).toBe(1);
    });

    it('delivering the same comment again records and queues nothing more', async () => {
      const commentId = next('18'), commenter = next('7'), broadcast = next('17');
      await deliver(change(igUserA, 'live_comments', { id: commentId, text: 'link', media: { id: broadcast }, from: { id: commenter } }));
      await deliver(change(igUserA, 'live_comments', { id: commentId, text: 'link', media: { id: broadcast }, from: { id: commenter } }));
      expect((await owner.query('SELECT count(*)::int AS n FROM instagram_comment_events WHERE comment_id=$1', [commentId])).rows[0].n).toBe(1);
      const event = (await eventOf(commentId))!;
      expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='instagram.private_reply' AND dedupe_key=$1", [`igpr:${event.id}`])).rows[0].n).toBe(1);
    });

    it("only a person's first MATCHING comment per broadcast starts the flow", async () => {
      const commenter = next('7'), other = next('7'), broadcast = next('17');
      const c1 = next('18'), c2 = next('18'), c3 = next('18'), c4 = next('18');
      // A comment with no keyword does not use up the person's start.
      await deliver(change(igUserA, 'live_comments', { id: c1, text: 'hello everyone', media: { id: broadcast }, from: { id: commenter } }));
      expect(await eventOf(c1)).toMatchObject({ status: 'no_rule' });
      expect(await jobPayload((await eventOf(c1))!.id)).toBeUndefined();
      await deliver(change(igUserA, 'live_comments', { id: c2, text: 'LINK?', media: { id: broadcast }, from: { id: commenter } }));
      expect(await eventOf(c2)).toMatchObject({ status: 'queued' });
      // Their next matching comment on the same broadcast starts nothing.
      await deliver(change(igUserA, 'live_comments', { id: c3, text: 'link again', media: { id: broadcast }, from: { id: commenter } }));
      expect(await eventOf(c3)).toMatchObject({ status: 'no_rule' });
      expect(await jobPayload((await eventOf(c3))!.id)).toBeUndefined();
      // Another person, or the same person on another broadcast, starts it.
      await deliver(change(igUserA, 'live_comments', { id: c4, text: 'link', media: { id: broadcast }, from: { id: other } }));
      expect(await eventOf(c4)).toMatchObject({ status: 'queued' });
      const c5 = next('18');
      await deliver(change(igUserA, 'live_comments', { id: c5, text: 'link', media: { id: next('17') }, from: { id: commenter } }));
      expect(await eventOf(c5)).toMatchObject({ status: 'queued' });
    });

    it('keeps post comments and Live comments apart', async () => {
      const commentId = next('18'), commenter = next('7');
      // A post comment saying "link": the post flow and the legacy rule, never the live flow.
      await deliver(change(igUserA, 'comments', { id: commentId, text: 'link', media: { id: next('17') }, from: { id: commenter } }));
      const payload = (await jobPayload((await eventOf(commentId))!.id))!;
      expect(payload.flows).toEqual([{ flowId: postFlowA, check: false }]);
      expect(payload.fallbackRuleId).toEqual(expect.any(String));
    });

    it("ignores the account's own Live comments, and Live comments without the comments permission", async () => {
      const own = next('18'), noScope = next('18');
      await deliver(change(igUserA, 'live_comments', { id: own, text: 'link', media: { id: next('17') }, from: { id: igUserA } }));
      expect(await eventOf(own)).toBeUndefined();
      await deliver(change(igUserA2, 'live_comments', { id: noScope, text: 'link', media: { id: next('17') }, from: { id: next('7') } }));
      expect(await eventOf(noScope)).toBeUndefined();
      expect((await owner.query('SELECT unsupported_event_count FROM instagram_accounts WHERE id=$1', [igA2])).rows[0].unsupported_event_count).toBeGreaterThan(0);
    });

    it('never offers one workspace a Live comment of another', async () => {
      const commentId = next('18');
      await deliver(change(igUserB, 'live_comments', { id: commentId, text: 'link', media: { id: next('17') }, from: { id: next('7') } }));
      const event = (await eventOf(commentId))!;
      expect(event.account_id).toBe(accountB);
      // B has no live flow: nothing is queued, and A's live flow is not offered.
      expect(event.status).toBe('no_rule');
      expect(await jobPayload(event.id)).toBeUndefined();
    });
  });

  describe('ref links', () => {
    it('saves the ref on the identity and starts the matching flow once', async () => {
      const fetchMock = graphStub();
      vi.stubGlobal('fetch', fetchMock);
      const sender = next('7'), mid = `mid-ref-${sender}`;
      const body = dm(igUserA, sender, mid, 'hi', { referral: { ref: 'Summer-Sale', source: 'SHORTLINK', type: 'OPEN_THREAD' } });
      await deliver(body);
      await deliver({ ...body, entry: [{ ...(body.entry[0] as object), time: Date.now() + 99 }] });
      const identity = (await identityOf(accountA, sender))!;
      expect(identity).toMatchObject({ last_ref: 'Summer-Sale', last_ref_at: expect.any(Date) });
      // The message is stored once, with its referral, and one inbound job exists for it.
      const messages = (await owner.query("SELECT id, interactive_payload FROM messages WHERE account_id=$1 AND message_id=$2", [accountA, mid])).rows;
      expect(messages).toHaveLength(1);
      expect(messages[0].interactive_payload.ig.referral).toMatchObject({ ref: 'Summer-Sale', source: 'SHORTLINK' });
      expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='inbound.actions' AND dedupe_key=$1", [`inbound:${messages[0].id}`])).rows[0].n).toBe(1);

      const result = await dispatchText(accountA, ownerA, sender, mid, 'hi');
      expect(result.consumed).toBe(true);
      const runs = await runsOf(refFlowA, identity.contact_id);
      expect(runs).toHaveLength(1);
      expect(runs[0].vars).toMatchObject({ ig_ref: 'Summer-Sale' });
      expect(bodies(fetchMock, '/messages')).toEqual([{ recipient: { id: sender }, message: { text: 'Welcome!' } }]);
      // Never B's flow, which listens on the same key.
      expect(await runsOf(refFlowB, identity.contact_id)).toHaveLength(0);
    });

    it('does not start a flow for another key, and stores the ref it was given', async () => {
      const sender = next('7'), mid = `mid-other-${sender}`;
      await deliver(dm(igUserA, sender, mid, 'hi', { referral: { ref: 'winter', source: 'SHORTLINK' } }));
      const identity = (await identityOf(accountA, sender))!;
      expect(identity.last_ref).toBe('winter');
      await dispatchText(accountA, ownerA, sender, mid, 'hi');
      expect(await runsOf(refFlowA, identity.contact_id)).toHaveLength(0);
    });

    it('stores only a ref it would accept, and never moves back to an older message', async () => {
      const sender = next('7');
      await deliver(dm(igUserA, sender, `mid-a-${sender}`, 'hi', { referral: { ref: 'first', source: 'SHORTLINK' } }, Date.now() - 5_000));
      // A bad ref (spaces, markup) is dropped, the message is still stored.
      await deliver(dm(igUserA, sender, `mid-b-${sender}`, 'hi', { referral: { ref: 'bad ref<script>', source: 'SHORTLINK' } }, Date.now() - 4_000));
      expect((await identityOf(accountA, sender))!.last_ref).toBe('first');
      expect((await owner.query('SELECT count(*)::int AS n FROM messages WHERE account_id=$1 AND message_id=$2', [accountA, `mid-b-${sender}`])).rows[0].n).toBe(1);
      // A newer message moves it on; a redelivered older one does not move it back.
      await deliver(dm(igUserA, sender, `mid-c-${sender}`, 'hi', { referral: { ref: 'third', source: 'SHORTLINK' } }, Date.now() - 3_000));
      await deliver(dm(igUserA, sender, `mid-d-${sender}`, 'hi', { referral: { ref: 'stale', source: 'SHORTLINK' } }, Date.now() - 60_000));
      expect((await identityOf(accountA, sender))!.last_ref).toBe('third');
    });

    it('a referral on its own updates a known sender and creates nothing for an unknown one', async () => {
      const known = next('7'), stranger = next('7');
      await deliver(dm(igUserA, known, `mid-k-${known}`, 'hi'));
      await deliver(referralOnly(igUserA, known, { ref: 'from-bio', source: 'SHORTLINK', type: 'OPEN_THREAD' }));
      expect((await identityOf(accountA, known))!.last_ref).toBe('from-bio');
      await deliver(referralOnly(igUserA, stranger, { ref: 'from-bio', source: 'SHORTLINK', type: 'OPEN_THREAD' }));
      expect(await identityOf(accountA, stranger)).toBeUndefined();
    });

    it('lists the links of the caller\'s workspace only', async () => {
      const mine = await listRefLinks(actor(accountA, ownerA));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((row) => row.flowId === refFlowA)).toBe(true);
      expect(mine.map((row) => row.url)).toContain(`https://ig.me/m/shop${igUserA.slice(0, 2)}?ref=summer-sale`);
      const theirs = await listRefLinks(actor(accountB, ownerB));
      expect(theirs.map((row) => row.flowId)).toEqual([refFlowB]);
      // The app role reads through RLS: B's context cannot see A's flows even when asking directly.
      const seen = await withTenant({ accountId: accountB, userId: ownerB, role: 'owner' }, (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM flows WHERE id=${refFlowA}::uuid`);
      expect(seen).toHaveLength(0);
    });
  });

  describe('click-to-Direct ads', () => {
    it('starts the ad_click flow from an ad message, ahead of a ref flow', async () => {
      const fetchMock = graphStub();
      vi.stubGlobal('fetch', fetchMock);
      const sender = next('7'), mid = `mid-ad-${sender}`;
      await deliver(dm(igUserA, sender, mid, 'hi', { referral: { ref: 'summer-sale', source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000001',
        ads_context_data: { ad_title: 'Launch sale' } } }));
      const identity = (await identityOf(accountA, sender))!;
      await dispatchText(accountA, ownerA, sender, mid, 'hi');
      const adRuns = await runsOf(adFlowA, identity.contact_id);
      expect(adRuns).toHaveLength(1);
      expect(adRuns[0].vars).toMatchObject({ ad_id: '120000001', ad_headline: 'Launch sale' });
      expect(await runsOf(refFlowA, identity.contact_id)).toHaveLength(0);
    });

    it('opens the 7-day window for automated sends only with the flag and only after an ad message', async () => {
      const ad = next('7'), plain = next('7'), link = next('7');
      const threeDays = Date.now() - 3 * DAY;
      await deliver(dm(igUserA, ad, `mid-w1-${ad}`, 'hi', { referral: { source: 'ADS', type: 'OPEN_THREAD', ad_id: '120000002' } }, threeDays));
      await deliver(dm(igUserA, plain, `mid-w2-${plain}`, 'hi', {}, threeDays));
      await deliver(dm(igUserA, link, `mid-w3-${link}`, 'hi', { referral: { ref: 'bio', source: 'SHORTLINK' } }, threeDays));
      const open = async (igsid: string) => {
        const id = (await identityOf(accountA, igsid))!;
        return withTenant({ accountId: accountA, role: 'owner' }, (tx) => instagramAutomatedWindowOpen(tx, accountA, id.conversation_id), getWorkerPrisma());
      };
      expect([await open(ad), await open(plain), await open(link)]).toEqual([false, false, false]);
      vi.stubEnv('INSTAGRAM_CTD_WINDOW_ENABLED', 'true');
      expect([await open(ad), await open(plain), await open(link)]).toEqual([true, false, false]);
    });
  });

  describe('resubscribe', () => {
    it('subscribes the live_comments field for accounts with the comments scope, once per workspace', async () => {
      const fetchMock = graphStub();
      vi.stubGlobal('fetch', fetchMock);
      expect(await scheduleInstagramResubscribe(Date.now(), true)).toBeGreaterThanOrEqual(2);
      await scheduleInstagramResubscribe(Date.now(), true);
      for (const accountId of [accountA, accountB]) {
        const jobs = (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='instagram.resubscribe' AND tenant_id=$1 AND dedupe_key=$2",
          [accountId, `igresub:${RESUBSCRIBE_VERSION}:${accountId}`])).rows[0].n;
        expect(jobs).toBe(1);
      }
      const summary = await withJobScope({ accountId: accountA, role: 'owner' }, () => runResubscribe(accountA));
      // A's comments-capable account is subscribed; its DM-only account is left alone; B is never touched.
      expect(summary).toEqual({ subscribed: 1, skipped: 1, failures: 0 });
      const subscribed = calls(fetchMock, '/subscribed_apps');
      expect(subscribed).toHaveLength(1);
      expect(String(subscribed[0][0])).toContain(igUserA);
      expect(String(subscribed[0][0])).toContain('live_comments');
      expect(String(subscribed[0][0])).not.toContain(igUserB);
    });
  });
});
