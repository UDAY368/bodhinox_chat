// Real-database proof of failed-run replay (Phase 12, design §3.3 and §7.3):
// a step whose send outcome is unknown or accepted is never re-sent, a
// refused send is replayed on a new intent key with exactly one queued job
// (and the job re-sends the step on the pinned version), a payment link
// failure is never replayed, another active run on the conversation blocks
// it, and another workspace cannot see the run. Meta is the only fake.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';

const h = vi.hoisted(() => {
  let n = 0;
  const send = vi.fn(async () => ({ whatsapp_message_id: `wamid.r${++n}` }));
  return { send };
});
vi.mock('./meta-send', () => ({
  engineSendText: h.send,
  engineSendMedia: h.send,
  engineSendInteractiveButtons: h.send,
  engineSendInteractiveList: h.send,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

import { dispatchInboundToFlows, handleFlowReplay } from './engine';
import { publishFlow } from './versions';
import { ALL_CAPABILITIES } from './node-registry';
import { inspectReplayable, readRunIntents, ReplayError, replayFlowRun } from './replay';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), user = randomUUID(), userB = randomUUID();
const seed = String(Date.now()).slice(-7);
const admin = { accountId: A, userId: user, role: 'admin' as const };
let db: pg.Client;
let phones = 0;
let flowId = '';
let versionId = '';
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

async function failedRun(opts: { endReason?: string; intent?: string | null; seq?: number } = {}) {
  const contact = randomUUID(), conversation = randomUUID(), run = randomUUID();
  const seq = opts.seq ?? 2;
  await q('INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,$4,$5)', [contact, A, user, 'R', `1415${seed}${++phones}`]);
  await q("INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,'open')", [conversation, A, user, contact]);
  await q(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,flow_version_id,
      transition_seq,ended_at,end_reason,started_at)
    VALUES($1,$2,$3,$4,$5,$6,'failed','start',$7,$8,now() - interval '1 hour',$9,now() - interval '2 hours')`,
  [run, A, flowId, user, contact, conversation, versionId, seq, opts.endReason ?? 'send_text_failed']);
  await q("INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key,payload) VALUES($1,$2,'node_entered','thanks','{}')", [A, run]);
  await q("INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key,payload) VALUES($1,$2,'error','thanks',$3)",
    [A, run, JSON.stringify({ reason: opts.endReason ?? 'send_text_failed' })]);
  if (opts.intent !== null) {
    await q("INSERT INTO outbound_intents(account_id,idempotency_key,status,last_error) VALUES($1,$2,$3,'Provider outcome uncertain')",
      [A, `${A}:flow:${run}:thanks:${seq}:0`, opts.intent ?? 'unknown']);
  }
  return { run, contact, conversation };
}
const replay = (run: string, ctx = admin) =>
  withTenant(ctx, (tx) => replayFlowRun(tx, { accountId: ctx.accountId, flowId, runId: run, userId: ctx.userId }));
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof ReplayError ? e.reason : e));
const runRow = async (run: string) => (await q('SELECT status, transition_seq, end_reason, ended_at FROM flow_runs WHERE id=$1', [run])).rows[0];
const jobsFor = async (run: string) => (await q("SELECT payload, dedupe_key FROM jobs WHERE tenant_id=$1 AND type='flow.replay' AND payload->>'runId'=$2", [A, run])).rows;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('flow run replay on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    for (const [id, account] of [[user, A], [userB, B]]) {
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Replay','test-only-hash')", [id, `${id}@example.invalid`]);
      await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Replay',$2)", [account, id]);
      await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, id]);
    }
    flowId = randomUUID();
    await q(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id)
      VALUES($1,$2,$3,'Replay','draft','keyword','{"keywords":["replayme"]}','start')`, [flowId, A, user]);
    for (const n of [
      { node_key: 'start', node_type: 'start', config: { next_node_key: 'thanks' } },
      { node_key: 'thanks', node_type: 'send_message', config: { text: 'Thanks!', next_node_key: 'done' } },
      { node_key: 'done', node_type: 'end', config: {} },
    ]) await q('INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,$3,$4,$5)', [A, flowId, n.node_key, n.node_type, JSON.stringify(n.config)]);
    const published = await withTenant(admin, (tx) => publishFlow(tx, { accountId: A, flowId, userId: user, caps: ALL_CAPABILITIES }));
    versionId = published.version.id;
  });
  afterAll(async () => {
    if (db) {
      for (const account of [A, B]) {
        await q('DELETE FROM jobs WHERE tenant_id=$1', [account]).catch(() => undefined);
        await q('DELETE FROM outbound_intents WHERE account_id=$1', [account]).catch(() => undefined);
        await q('DELETE FROM accounts WHERE id=$1', [account]).catch(() => undefined);
      }
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[user, userB]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('never re-sends a step whose send outcome is unknown or accepted', async () => {
    for (const [intent, reason] of [['unknown', 'needs_reconciliation'], ['dispatching', 'needs_reconciliation'], ['accepted', 'already_sent']] as const) {
      const { run } = await failedRun({ intent });
      expect(await refusal(replay(run))).toBe(reason);
      expect(await runRow(run)).toMatchObject({ status: 'failed', transition_seq: 2 });
      expect(await jobsFor(run)).toHaveLength(0);
      const inspected = await withTenant(admin, (tx) => inspectReplayable(tx, A, flowId, run));
      expect(inspected).toEqual({ replayable: { ok: false, reason }, failedNode: 'thanks' });
    }
  });

  it('holds a message that arrives between the replay and its job, then the job still sends the step', async () => {
    const { run, contact, conversation } = await failedRun({ intent: 'failed' });
    const queued = await replay(run);
    h.send.mockClear();
    const inbound = await withJobScope({ accountId: A, role: 'owner' }, () => dispatchInboundToFlows({
      accountId: A, userId: user, contactId: contact, conversationId: conversation,
      message: { kind: 'text', text: 'hello?', meta_message_id: `wamid.in.${randomUUID()}` }, isFirstInboundMessage: false,
    }));
    expect(inbound).toMatchObject({ consumed: true, outcome: 'waiting', flow_run_id: run });
    // Nothing answered the prompt the customer never saw: no fallback, no advance.
    expect(h.send).not.toHaveBeenCalled();
    expect(await runRow(run)).toMatchObject({ status: 'active', transition_seq: queued.seq });
    const fired = (await q("SELECT count(*)::int AS n FROM flow_run_events WHERE flow_run_id=$1 AND event_type='fallback_fired'", [run])).rows[0].n;
    expect(fired).toBe(0);
    const [job] = await jobsFor(run);
    expect(await withJobScope({ accountId: A, role: 'owner' }, () => handleFlowReplay(job.payload))).toBe('replayed');
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Thanks!' }));
  });

  it('replays a refused send on a new intent key, queues exactly one job, and the job re-sends the step', async () => {
    const { run } = await failedRun({ intent: 'failed' });
    const queued = await replay(run);
    expect(queued).toEqual({ run_id: run, node_key: 'thanks', seq: 3 });
    expect(await runRow(run)).toMatchObject({ status: 'active', transition_seq: 3, end_reason: null, ended_at: null });
    const jobs = await jobsFor(run);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ dedupe_key: `flow-replay:${run}:3`, payload: { accountId: A, runId: run, seq: 3, nodeKey: 'thanks' } });
    expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='flows.run_replayed' AND metadata->>'run_id'=$2", [A, run])).rows[0].n).toBe(1);
    // The run's own timeline records the replay (who, which step, which transition).
    const replayed = (await q("SELECT node_key, payload FROM flow_run_events WHERE account_id=$1 AND flow_run_id=$2 AND event_type='replayed'", [A, run])).rows;
    expect(replayed).toEqual([{ node_key: 'thanks', payload: { by: admin.userId, seq: 3 } }]);
    // A second replay finds the run active.
    expect(await refusal(replay(run))).toBe('not_failed');

    h.send.mockClear();
    expect(await withJobScope({ accountId: A, role: 'owner' }, () => handleFlowReplay(jobs[0].payload))).toBe('replayed');
    expect(h.send).toHaveBeenCalledTimes(1);
    const intents = (await q('SELECT idempotency_key, status FROM outbound_intents WHERE account_id=$1 AND idempotency_key LIKE $2 ORDER BY idempotency_key',
      [A, `${A}:flow:${run}:%`])).rows;
    expect(intents).toEqual([
      { idempotency_key: `${A}:flow:${run}:thanks:2:0`, status: 'failed' },
      { idempotency_key: `${A}:flow:${run}:thanks:3:0`, status: 'accepted' },
    ]);
    expect((await runRow(run)).status).toBe('completed');
    // The same job again is stale: the run moved on.
    expect(await withJobScope({ accountId: A, role: 'owner' }, () => handleFlowReplay(jobs[0].payload))).toBe('stale');
    const inspected = await withTenant(admin, (tx) => readRunIntents(tx, A, run));
    expect(inspected.map((i) => [i.node_key, i.seq, i.attempt, i.status])).toEqual(expect.arrayContaining([['thanks', 2, 0, 'failed'], ['thanks', 3, 0, 'accepted']]));
    expect(JSON.stringify(inspected)).not.toContain('wamid');
  });

  it('never replays a payment link failure, and allows a step that never claimed a send', async () => {
    const pay = await failedRun({ endReason: 'payment_link_failed', intent: null });
    expect(await refusal(replay(pay.run))).toBe('not_replayable_reason');
    const unsent = await failedRun({ intent: null });
    expect(await replay(unsent.run)).toMatchObject({ seq: 3 });
  });

  it('refuses to replay for a contact who sent STOP after the failure, and a queued replay sends nothing (audit #47)', async () => {
    const refused = await failedRun({ intent: 'failed' });
    await q('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [refused.contact]);
    expect(await refusal(replay(refused.run))).toBe('contact_opted_out');
    expect(await runRow(refused.run)).toMatchObject({ status: 'failed', transition_seq: 2 });
    expect(await jobsFor(refused.run)).toHaveLength(0);
    expect(await withTenant(admin, (tx) => inspectReplayable(tx, A, flowId, refused.run)))
      .toEqual({ replayable: { ok: false, reason: 'contact_opted_out' }, failedNode: 'thanks' });

    // STOP between the replay and its job: the job ends the run and makes no provider call.
    const { run, contact } = await failedRun({ intent: 'failed' });
    const queued = await replay(run);
    await q('UPDATE contacts SET opted_out_at=now() WHERE id=$1', [contact]);
    h.send.mockClear();
    const [job] = await jobsFor(run);
    expect(job.payload).toMatchObject({ seq: queued.seq });
    expect(await withJobScope({ accountId: A, role: 'owner' }, () => handleFlowReplay(job.payload))).toBe('replayed');
    expect(h.send).not.toHaveBeenCalled();
    expect(await runRow(run)).toMatchObject({ status: 'cancelled', end_reason: 'contact_opted_out' });
  });

  it('refuses while another run is active on the same conversation, and hides the run from another workspace', async () => {
    const { run, contact, conversation } = await failedRun({ intent: 'failed' });
    await q(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key)
      VALUES($1,$2,$3,$4,$5,'active','thanks')`, [A, flowId, user, contact, conversation]);
    expect(await refusal(replay(run))).toBe('conversation_busy');
    expect(await refusal(replay(run, { accountId: B, userId: userB, role: 'admin' }))).toBe('not_found');
    expect(await runRow(run)).toMatchObject({ status: 'failed' });
  });

  it('refuses runs older than seven days and runs of an archived flow', async () => {
    const old = await failedRun({ intent: 'failed' });
    await q("UPDATE flow_runs SET ended_at=now() - interval '8 days' WHERE id=$1", [old.run]);
    expect(await refusal(replay(old.run))).toBe('too_old');
    const archived = await failedRun({ intent: 'failed' });
    await q("UPDATE flows SET status='archived' WHERE id=$1", [flowId]);
    try {
      expect(await refusal(replay(archived.run))).toBe('flow_archived');
    } finally {
      await q("UPDATE flows SET status='active' WHERE id=$1", [flowId]);
    }
  });
});
