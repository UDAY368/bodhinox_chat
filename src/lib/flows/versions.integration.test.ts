// Real-database proof of flow versioning (Phase 12, design §2 and §7.1):
// publish snapshots an immutable version, runs stay pinned to the version
// they started on, migrate/pause/archive behave as documented, concurrent
// publishes cannot form a Connect Flow loop, and versions are tenant-scoped
// and immutable for the app and worker roles. Meta is the only fake.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { databaseAdmin } from './admin-client';

const h = vi.hoisted(() => {
  let n = 0;
  type Sent = { conversationId: string; text?: string; bodyText?: string };
  const send = vi.fn<(args: Sent) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: `wamid.v${++n}` }));
  return { send };
});
vi.mock('./meta-send', () => ({
  engineSendText: h.send,
  engineSendMedia: h.send,
  engineSendInteractiveButtons: h.send,
  engineSendInteractiveList: h.send,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

import { dispatchInboundToFlows } from './engine';
import {
  archiveFlow, cancelRuns, FlowVersionError, migrateRuns, moveToDraft, pauseFlow, publishFlow, readPublishState, readVersion, saveDraft,
} from './versions';
import { ALL_CAPABILITIES } from './node-registry';
import { findMediaReferences } from '@/lib/inbox/media-library';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), user = randomUUID(), userB = randomUUID();
const seed = String(Date.now()).slice(-8);
const member = { accountId: A, userId: user, role: 'admin' as const };
const scope = { accountId: A, role: 'owner' as const };
let db: pg.Client;
let phones = 0;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

const START = (next: string) => ({ node_key: 'start', node_type: 'start', config: { next_node_key: next } });
const ASK = { node_key: 'ask', node_type: 'collect_input', config: { prompt_text: 'Your name?', var_key: 'name', next_node_key: 'thanks' } };
const THANKS = (text: string) => ({ node_key: 'thanks', node_type: 'send_message', config: { text, next_node_key: 'done' } });
const END = { node_key: 'done', node_type: 'end', config: {} };

async function addFlow(name: string, keyword: string, nodes: Array<{ node_key: string; node_type: string; config: object }>, status = 'draft') {
  const id = randomUUID();
  await q(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id)
    VALUES($1,$2,$3,$4,$5,'keyword',$6,'start')`, [id, A, user, name, status, JSON.stringify({ keywords: [keyword] })]);
  for (const n of nodes) {
    await q('INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,$3,$4,$5)', [A, id, n.node_key, n.node_type, JSON.stringify(n.config)]);
  }
  return id;
}
async function contact() {
  const c = randomUUID(), conversation = randomUUID();
  await q('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)', [c, A, user, 'C', `1415${seed}${++phones}`]);
  await q("INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,'open')", [conversation, A, user, c]);
  return { contact: c, conversation };
}
const inbound = (c: { contact: string; conversation: string }, text: string) => withJobScope(scope, () => dispatchInboundToFlows({
  accountId: A, userId: user, contactId: c.contact, conversationId: c.conversation,
  message: { kind: 'text', text, meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false,
}));
const publish = (flowId: string, extra: { expectedDraftHash?: string } = {}) =>
  withTenant(member, (tx) => publishFlow(tx, { accountId: A, flowId, userId: user, caps: ALL_CAPABILITIES, ...extra }));
const runsOf = async (flowId: string) => (await q('SELECT id,status,end_reason,current_node_key,flow_version_id,contact_id FROM flow_runs WHERE flow_id=$1 ORDER BY started_at', [flowId])).rows;
async function addRun(flowId: string, versionId: string, node: string, opts: { idleSeconds?: number; delay?: boolean } = {}) {
  const c = await contact();
  const id = randomUUID();
  await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,flow_version_id,last_advanced_at,delay_until)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,now() - make_interval(secs => $9::int),$10)`,
    [id, A, flowId, user, c.contact, c.conversation, node, versionId, opts.idleSeconds ?? 120, opts.delay ? new Date(Date.now() + 3_600_000) : null]);
  return { id, ...c };
}
const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('flow versions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    for (const [id, account] of [[user, A], [userB, B]]) {
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Versions','test-only-hash')", [id, `${id}@example.invalid`]);
      await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Versions',$2)", [account, id]);
      await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, id]);
    }
  });
  beforeEach(() => h.send.mockClear());
  afterAll(async () => {
    if (db) {
      for (const account of [A, B]) {
        await q('DELETE FROM jobs WHERE tenant_id=$1', [account]).catch(() => undefined);
        await q('DELETE FROM accounts WHERE id=$1', [account]).catch(() => undefined);
      }
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[user, userB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('pins a waiting run to v1 while v2 drops its step, and starts new runs on v2', async () => {
    const flow = await addFlow('Pinned', 'pinme', [START('ask'), ASK, THANKS('Thanks {{vars.name}}'), END]);
    const v1 = await publish(flow);
    expect(v1).toMatchObject({ version: { version: 1 }, reused: false, flow: { status: 'active' } });
    const c1 = await contact();
    expect(await inbound(c1, 'pinme')).toMatchObject({ consumed: true, outcome: 'started' });
    const [run1] = await runsOf(flow);
    expect(run1).toMatchObject({ status: 'active', current_node_key: 'ask', flow_version_id: v1.version.id });

    // Editing the draft changes nothing live until it is published.
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: {}, nodes: [START('thanks'), THANKS('Welcome back'), END] }));
    expect(await withTenant(member, (tx) => readPublishState(tx, A, flow))).toMatchObject({ has_unpublished_changes: true, published_version: { version: 1 } });
    const v2 = await publish(flow);
    expect(v2.version.version).toBe(2);
    // Publishing an unchanged draft again reuses the live version.
    expect(await publish(flow)).toMatchObject({ version: { id: v2.version.id }, reused: true });

    h.send.mockClear();
    expect(await inbound(c1, 'Asha')).toMatchObject({ outcome: 'completed' });
    expect((await runsOf(flow))[0]).toMatchObject({ status: 'completed', flow_version_id: v1.version.id });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Thanks Asha' }));

    const c2 = await contact();
    h.send.mockClear();
    expect(await inbound(c2, 'pinme')).toMatchObject({ outcome: 'completed' });
    const run2 = (await runsOf(flow)).find((r) => r.contact_id === c2.contact);
    expect(run2).toMatchObject({ status: 'completed', flow_version_id: v2.version.id });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Welcome back' }));
  });

  it('refuses to publish a draft other than the one the author saw', async () => {
    const flow = await addFlow('Hash', 'hash', [START('done'), END]);
    const state = await withTenant(member, (tx) => readPublishState(tx, A, flow));
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: { name: 'Hash 2' }, nodes: [START('thanks'), THANKS('x'), END] }));
    const err = await rejection(publish(flow, { expectedDraftHash: state!.draft_hash }));
    expect(err).toBeInstanceOf(FlowVersionError);
    expect((err as FlowVersionError).code).toBe('draft_changed');
    expect((await q('SELECT count(*)::int AS n FROM flow_versions WHERE flow_id=$1', [flow])).rows[0].n).toBe(0);
  });

  it('migrates only idle, waiting, type-compatible runs, and the engine claim then loses on the old version', async () => {
    const flow = await addFlow('Migrate', 'migrate', [START('ask'), ASK, THANKS('v1'), END]);
    const v1 = await publish(flow);
    const idle = await addRun(flow, v1.version.id, 'ask');
    const fresh = await addRun(flow, v1.version.id, 'ask', { idleSeconds: 0 });
    const delayed = await addRun(flow, v1.version.id, 'ask', { delay: true });
    const atStart = await addRun(flow, v1.version.id, 'thanks');
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: {}, nodes: [START('ask'), ASK, THANKS('v2'), END] }));
    const v2 = await publish(flow);

    const result = await withTenant(member, (tx) => migrateRuns(tx, { accountId: A, flowId: flow, userId: user, fromVersionId: v1.version.id }));
    expect(result.migrated).toBe(1);
    expect(result.to_version).toBe(2);
    expect(result.left.reduce((n, l) => n + l.count, 0)).toBe(3);
    const byId = new Map((await runsOf(flow)).map((r) => [r.id, r]));
    expect(byId.get(idle.id).flow_version_id).toBe(v2.version.id);
    for (const r of [fresh, delayed, atStart]) expect(byId.get(r.id).flow_version_id).toBe(v1.version.id);
    // Only the moved run gets a 'migrated' event on its timeline.
    const migrated = await withJobScope(scope, () => databaseAdmin().from('flow_run_events').select('flow_run_id, node_key, payload')
      .eq('account_id', A).eq('event_type', 'migrated').in('flow_run_id', [idle.id, fresh.id, delayed.id, atStart.id]));
    expect(migrated.error).toBeNull();
    expect(migrated.data).toEqual([{ flow_run_id: idle.id, node_key: 'ask', payload: { by: user, from_version: 1, to_version: 2 } }]);

    // A claim prepared on v1 (the version filter is part of every engine CAS) no longer matches.
    const lost = await withJobScope(scope, () => databaseAdmin().from('flow_runs').update({ current_node_key: 'thanks' })
      .eq('account_id', A).eq('id', idle.id).eq('status', 'active').eq('flow_version_id', v1.version.id).select('id'));
    expect(lost.error).toBeNull();
    expect(lost.data).toEqual([]);
    // The migrated run continues on v2.
    expect(await inbound(idle, 'Ravi')).toMatchObject({ outcome: 'completed' });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'v2' }));
    expect(await rejection(withTenant(member, (tx) => migrateRuns(tx, { accountId: A, flowId: flow, userId: user, fromVersionId: v2.version.id }))))
      .toMatchObject({ code: 'nothing_to_migrate' });
  });

  it('pause keeps runs on their version, cancel_active ends them; archive needs cancel_active and leaves archived_at alone', async () => {
    const flow = await addFlow('Lifecycle', 'life', [START('ask'), ASK, THANKS('done'), END]);
    const v1 = await publish(flow);
    const waiting = await addRun(flow, v1.version.id, 'ask');
    await withTenant(member, (tx) => pauseFlow(tx, { accountId: A, flowId: flow, userId: user, cancelActive: false }));
    // Paused: no new enrollments, but the waiting run finishes.
    const stranger = await contact();
    expect(await inbound(stranger, 'life')).toEqual({ consumed: false, outcome: 'no_match' });
    expect(await inbound(waiting, 'Mei')).toMatchObject({ outcome: 'completed' });

    const second = await addRun(flow, v1.version.id, 'ask');
    await withTenant(member, (tx) => pauseFlow(tx, { accountId: A, flowId: flow, userId: user, cancelActive: true }));
    expect((await runsOf(flow)).find((r) => r.id === second.id)).toMatchObject({ status: 'cancelled', end_reason: 'flow_paused' });

    // The old "draft" request pauses a published flow instead.
    await publish(flow);
    expect(await withTenant(member, (tx) => moveToDraft(tx, { accountId: A, flowId: flow, userId: user }))).toMatchObject({ paused: true, flow: { status: 'paused' } });

    const third = await addRun(flow, v1.version.id, 'ask');
    const busy = await rejection(withTenant(member, (tx) => archiveFlow(tx, { accountId: A, flowId: flow, userId: user, cancelActive: false })));
    expect(busy).toMatchObject({ code: 'active_runs', detail: { active_runs: 1 } });
    await withTenant(member, (tx) => archiveFlow(tx, { accountId: A, flowId: flow, userId: user, cancelActive: true }));
    expect((await runsOf(flow)).find((r) => r.id === third.id)).toMatchObject({ status: 'cancelled', end_reason: 'flow_archived' });
    expect((await q('SELECT status, archived_at FROM flows WHERE id=$1', [flow])).rows[0]).toEqual({ status: 'archived', archived_at: null });
    const audit = (await q("SELECT action FROM audit_logs WHERE account_id=$1 AND resource_id=$2 ORDER BY created_at", [A, flow])).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['flows.published', 'flows.paused', 'flows.archived']));
  });

  it('cancels the runs of one version only', async () => {
    const flow = await addFlow('Cancel', 'cancel', [START('ask'), ASK, THANKS('x'), END]);
    const v1 = await publish(flow);
    const old = await addRun(flow, v1.version.id, 'ask');
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: {}, nodes: [START('ask'), ASK, THANKS('y'), END] }));
    const v2 = await publish(flow);
    const current = await addRun(flow, v2.version.id, 'ask');
    expect(await withTenant(member, (tx) => cancelRuns(tx, { accountId: A, flowId: flow, userId: user, versionId: v1.version.id }))).toEqual({ cancelled: 1 });
    const byId = new Map((await runsOf(flow)).map((r) => [r.id, r]));
    expect(byId.get(old.id)).toMatchObject({ status: 'cancelled', end_reason: 'cancelled_by_member' });
    expect(byId.get(current.id).status).toBe('active');
  });

  it('lets exactly one of two concurrent publishes through when together they would loop A > B > A', async () => {
    const via = (target: string) => [START('go'), { node_key: 'go', node_type: 'connect_flow', config: { flow_id: target } }];
    const flowA = await addFlow('Loop A', 'loopa', []);
    const flowB = await addFlow('Loop B', 'loopb', []);
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flowA, patch: {}, nodes: via(flowB) }));
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flowB, patch: {}, nodes: via(flowA) }));
    const results = await Promise.allSettled([publish(flowA), publish(flowB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'invalid' });
    expect((failed.reason as FlowVersionError).detail.issues).toContainEqual(expect.objectContaining({ code: 'crossFlowLoop' }));
  });

  it('keeps versions immutable for the app and worker roles, scoped to the workspace, and deletable only with their flow', async () => {
    const flow = await addFlow('Immutable', 'immutable', [START('done'), END]);
    const v1 = await publish(flow);
    for (const client of [getPrisma(), getWorkerPrisma()]) {
      await expect(withTenant(member, (tx) => tx.$executeRaw`UPDATE flow_versions SET version=9 WHERE id=${v1.version.id}::uuid`, client)).rejects.toThrow();
      await expect(withTenant(member, (tx) => tx.$executeRaw`DELETE FROM flow_versions WHERE id=${v1.version.id}::uuid`, client)).rejects.toThrow();
    }
    // Another workspace sees nothing and cannot publish this flow.
    const other = { accountId: B, userId: userB, role: 'owner' as const };
    expect(await withTenant(other, (tx) => readVersion(tx, B, v1.version.id))).toBeNull();
    expect(await withTenant(other, (tx) => readVersion(tx, A, v1.version.id))).toBeNull();
    expect(await rejection(withTenant(other, (tx) => publishFlow(tx, { accountId: B, flowId: flow, userId: userB, caps: ALL_CAPABILITIES }))))
      .toMatchObject({ code: 'not_found' });
    // A viewer cannot publish.
    const viewer = { accountId: A, userId: user, role: 'viewer' as const };
    await q("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,'extra','end','{}')", [A, flow]);
    await expect(withTenant(viewer, (tx) => publishFlow(tx, { accountId: A, flowId: flow, userId: user, caps: ALL_CAPABILITIES }))).rejects.toThrow();
    await q('DELETE FROM flows WHERE id=$1', [flow]);
    expect((await q('SELECT count(*)::int AS n FROM flow_versions WHERE flow_id=$1', [flow])).rows[0].n).toBe(0);
  });

  it('refuses a provider-gated step at publish when the workspace lacks the provider', async () => {
    const flow = await addFlow('Pay', 'pay', [START('pay'), { node_key: 'pay', node_type: 'payment_link',
      config: { amount: '100', currency: 'INR', description: 'x', message: 'Pay {{payment_link}}', paid_next: 'done', expired_next: 'done', failed_next: 'done' } }, END]);
    const err = await rejection(withTenant(member, (tx) => publishFlow(tx, { accountId: A, flowId: flow, userId: user, caps: { ...ALL_CAPABILITIES, payments: false } })));
    expect((err as FlowVersionError).detail.issues).toContainEqual(expect.objectContaining({ code: 'capabilityUnavailable', capability: 'payments' }));
  });

  it('still runs an active flow without a version on its draft, unpinned (deploy-window straggler)', async () => {
    const flow = await addFlow('Straggler', 'straggle', [START('thanks'), THANKS('legacy'), END], 'active');
    const c = await contact();
    expect(await inbound(c, 'straggle')).toMatchObject({ outcome: 'completed' });
    expect((await runsOf(flow))[0]).toMatchObject({ status: 'completed', flow_version_id: null });
  });

  it('keeps media referenced while only a published version uses it', async () => {
    const key = `${A}/flow-media/${randomUUID()}.jpg`;
    const flow = await addFlow('Media', 'media', [START('pic'), { node_key: 'pic', node_type: 'send_media',
      config: { media_type: 'image', media_url: `/api/media/object?bucket=flow-media&key=${encodeURIComponent(key)}&raw=${key}`, next_node_key: 'done' } }, END]);
    await publish(flow);
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: {}, nodes: [START('done'), END] }));
    const refs = await withTenant(member, (tx) => findMediaReferences(tx, A, 'flow-media', key));
    expect(refs).toContain('flow');
  });

  it('leaves a run on its version while a reply is being handled, even when it last advanced long ago', async () => {
    const flow = await addFlow('Migrate busy', 'migbusy', [START('ask'), ASK, THANKS('v1'), END]);
    const v1 = await publish(flow);
    const replying = await addRun(flow, v1.version.id, 'ask');
    await q("INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key,payload) VALUES($1,$2,'reply_received','ask','{}')", [A, replying.id]);
    const quiet = await addRun(flow, v1.version.id, 'ask');
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: {}, nodes: [START('ask'), ASK, THANKS('v2'), END] }));
    const v2 = await publish(flow);
    const result = await withTenant(member, (tx) => migrateRuns(tx, { accountId: A, flowId: flow, userId: user, fromVersionId: v1.version.id }));
    expect(result.migrated).toBe(1);
    const byId = new Map((await runsOf(flow)).map((r) => [r.id, r]));
    expect(byId.get(replying.id).flow_version_id).toBe(v1.version.id);
    expect(byId.get(quiet.id).flow_version_id).toBe(v2.version.id);
  });

  it('pins draft test-number runs to the version their publish creates', async () => {
    const flow = await addFlow('Tested', 'tested', [START('ask'), ASK, THANKS('x'), END]);
    await q("UPDATE flows SET test_numbers='{15550001}' WHERE id=$1", [flow]);
    const c = await contact();
    const run = randomUUID();
    await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
      VALUES($1,$2,$3,$4,$5,$6,'active','ask')`, [run, A, flow, user, c.contact, c.conversation]);
    const v1 = await publish(flow);
    expect((await runsOf(flow))[0]).toMatchObject({ id: run, status: 'active', flow_version_id: v1.version.id });
  });

  it('takes a flow out of the plan archive when a member publishes or pauses it, so a later user archive stays archived', async () => {
    for (const via of ['publish', 'pause'] as const) {
      const flow = await addFlow(`Plan ${via}`, `plan${via}`, [START('done'), END]);
      await publish(flow);
      // What a downgrade does (billing/downgrade.ts archive()).
      await q("UPDATE flows SET status='archived', archived_at=now() WHERE id=$1", [flow]);
      await q("INSERT INTO plan_archives(account_id,kind,item_id,prior_state) VALUES($1,'flows',$2,'active')", [A, flow]);
      if (via === 'publish') await publish(flow);
      else await withTenant(member, (tx) => pauseFlow(tx, { accountId: A, flowId: flow, userId: user, cancelActive: false }));
      await withTenant(member, (tx) => archiveFlow(tx, { accountId: A, flowId: flow, userId: user, cancelActive: true }));
      expect((await q('SELECT status, archived_at FROM flows WHERE id=$1', [flow])).rows[0]).toEqual({ status: 'archived', archived_at: null });
      expect((await q("SELECT restored_at FROM plan_archives WHERE account_id=$1 AND kind='flows' AND item_id=$2", [A, flow])).rows[0].restored_at).not.toBeNull();
    }
  });

  it('keeps media referenced while a failed run that may still be replayed is pinned to its version', async () => {
    const key = `${A}/flow-media/${randomUUID()}.jpg`;
    const media = { node_key: 'pic', node_type: 'send_media',
      config: { media_type: 'image', media_url: `/api/media/object?bucket=flow-media&key=${encodeURIComponent(key)}&raw=${key}`, next_node_key: 'done' } };
    const flow = await addFlow('Replay media', 'replaymedia', [START('pic'), media, END]);
    const v1 = await publish(flow);
    const failed = await addRun(flow, v1.version.id, 'pic');
    await q("UPDATE flow_runs SET status='failed', ended_at=now() - interval '1 day', end_reason='send_media_failed' WHERE id=$1", [failed.id]);
    await withTenant(member, (tx) => saveDraft(tx, { accountId: A, flowId: flow, patch: {}, nodes: [START('done'), END] }));
    await publish(flow);
    const refs = () => withTenant(member, (tx) => findMediaReferences(tx, A, 'flow-media', key));
    expect(await refs()).toContain('flow');
    await q("UPDATE flow_runs SET ended_at=now() - interval '8 days' WHERE id=$1", [failed.id]);
    expect(await refs()).not.toContain('flow');
  });

  it('runs the version backfill without ACCESS EXCLUSIVE locks, pins only runs whose step exists, and leaves no session lock_timeout', async () => {
    // A versioned flow whose draft gained a node after v1 (an old instance edited it during the deploy window).
    const flow = await addFlow('Backfill', 'backfill', [START('ask'), ASK, THANKS('x'), END]);
    const v1 = await publish(flow);
    await q("INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,'extra','collect_input',$3)",
      [A, flow, JSON.stringify({ prompt_text: 'More?', var_key: 'more', next_node_key: 'done' })]);
    const insert = async (flowId: string, node: string) => {
      const c = await contact();
      const id = randomUUID();
      await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
        VALUES($1,$2,$3,$4,$5,$6,'active',$7)`, [id, A, flowId, user, c.contact, c.conversation, node]);
      return id;
    };
    const onKnown = await insert(flow, 'ask');
    const onNew = await insert(flow, 'extra');
    // An active flow with no version at all gets v1 and its run is pinned.
    const straggler = await addFlow('Backfill straggler', 'backfill2', [START('ask'), ASK, THANKS('x'), END], 'active');
    const stragglerRun = await insert(straggler, 'ask');

    const sql = readFileSync('prisma/migrations/20261110100100_flow_versions_backfill/migration.sql', 'utf8');
    await q('BEGIN');
    try {
      await q(sql);
      const modes = (await q(`SELECT DISTINCT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation = ANY(ARRAY[
        'flows','flow_nodes','flow_runs','flow_versions','plan_archives']::regclass[])`)).rows.map((r) => r.mode);
      expect(modes).not.toContain('AccessExclusiveLock');
      const runs = new Map((await q('SELECT id, flow_version_id FROM flow_runs WHERE id = ANY($1::uuid[])', [[onKnown, onNew, stragglerRun]])).rows
        .map((r) => [r.id, r.flow_version_id]));
      expect(runs.get(onKnown)).toBe(v1.version.id);
      expect(runs.get(onNew)).toBeNull();
      const stragglerVersion = (await q('SELECT published_version_id FROM flows WHERE id=$1', [straggler])).rows[0].published_version_id;
      expect(stragglerVersion).not.toBeNull();
      expect(runs.get(stragglerRun)).toBe(stragglerVersion);
    } finally {
      await q('ROLLBACK');
    }
    // Prisma applies each file as one implicit transaction over a shared
    // connection: the timeout must not outlive it (it would cancel the
    // following CREATE INDEX CONCURRENTLY files).
    const before = (await q('SHOW lock_timeout')).rows[0].lock_timeout;
    await q(readFileSync('prisma/migrations/20261110100200_flow_versions_validate/migration.sql', 'utf8'));
    expect((await q('SHOW lock_timeout')).rows[0].lock_timeout).toBe(before);
  });
});
