// Sequences (Stage 5, 5H) on PostgreSQL: tenancy and role rules through the
// real RLS policies, and the worker's delivery rules: a due message is claimed
// and started once (also under two concurrent workers and after a crash), a
// message due outside Instagram's 24-hour window is skipped and logged
// window_closed with nothing started, and unsubscribing or opting out stops
// the sequence at once. Starting the message's automation is stubbed with a
// fake that records a flow run the way the engine does; nothing leaves the
// machine.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL); the suite is skipped
// without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@/lib/flows/engine', async (original) => ({
  ...(await original<typeof import('@/lib/flows/engine')>()),
  startFlowById: (...args: unknown[]) => h.start(...args),
}));

import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  addMessage,
  archiveSequence,
  changeSubscriber,
  createSequence,
  deleteMessage,
  getSequence,
  listSequences,
  listSubscribers,
  reorderMessages,
  updateMessage,
  updateSequence,
} from './store';
import { contactInSequence, endSequencesForContact, sequenceSubscriptions } from './subscriptions';
import { runDueSequences } from './worker';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const ENV = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '123456', INSTAGRAM_APP_SECRET: 'test-only-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'test-only-verify', APP_URL: 'https://app.example.test',
};
const accountA = randomUUID(), accountB = randomUUID();
const adminUser = randomUUID(), agentUser = randomUUID(), viewerUser = randomUUID(), ownerUserB = randomUUID();
const agentA: TenantContext = { accountId: accountA, userId: agentUser, role: 'agent' };
const adminA: TenantContext = { accountId: accountA, userId: adminUser, role: 'admin' };
const viewerA: TenantContext = { accountId: accountA, userId: viewerUser, role: 'viewer' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerUserB, role: 'owner' };
const seed = String(Date.now()).slice(-9);

let owner: pg.Client;
const ids = { igA: '', igB: '', liveFlow: '', liveFlowB: '', draftFlow: '' };
type Thread = { contact: string; conversation: string };

async function thread(accountId: string, userId: string, ig: string, igsid: string, lastCustomerAgo: string): Promise<Thread> {
  const contact = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'','Sequence test') RETURNING id",
    [accountId, userId])).rows[0].id as string;
  await owner.query("INSERT INTO contact_channel_identities(account_id,contact_id,channel,instagram_account_id,external_id) VALUES($1,$2,'instagram',$3,$4)",
    [accountId, contact, ig, igsid]);
  const conversation = (await owner.query(
    "INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id) VALUES($1,$2,$3,'instagram',$4) RETURNING id",
    [accountId, userId, contact, ig])).rows[0].id as string;
  await owner.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status,created_at)
    VALUES($1,$2,'customer','text','hi',$3,'delivered',now() - $4::interval)`, [accountId, conversation, `mid.in.${randomUUID()}`, lastCustomerAgo]);
  return { contact, conversation };
}

/** The engine's part, faked: a run row for the flow, as startNewRun inserts it, then 'started'. */
function startRecordsRun(outcome: 'started' | 'conflict' | 'unavailable' = 'started') {
  return async (input: { accountId: string; flowId: string; userId: string; contactId: string; conversationId: string }) => {
    if (outcome !== 'conflict')
      await owner.query(`INSERT INTO flow_runs(account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,ended_at)
        VALUES($1,$2,$3,$4,$5,$6,'n1',now())`, [input.accountId, input.flowId, input.userId, input.contactId, input.conversationId,
        outcome === 'started' ? 'completed' : 'failed']);
    return { outcome };
  };
}

const makeDue = (sequenceId: string, contactId: string) => owner.query(
  "UPDATE sequence_subscriptions SET next_due_at = now() - interval '1 minute' WHERE sequence_id=$1 AND contact_id=$2", [sequenceId, contactId]);
const subscription = async (sequenceId: string, contactId: string) => (await owner.query(
  'SELECT status, next_position, next_due_at, claimed_at FROM sequence_subscriptions WHERE sequence_id=$1 AND contact_id=$2', [sequenceId, contactId])).rows[0];
const sends = async (sequenceId: string, contactId: string) => (await owner.query(
  `SELECT s.status, s.reason, s.flow_run_id, m.position FROM sequence_message_sends s JOIN sequence_messages m ON m.id = s.sequence_message_id
   WHERE s.sequence_id=$1 AND s.contact_id=$2 ORDER BY m.position, s.created_at`, [sequenceId, contactId])).rows;
const code = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; meta?: { code?: string } }) => e.code ?? e.meta?.code ?? 'error');

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('sequences on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Sequence test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[adminUser, agentUser, viewerUser, ownerUserB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Sequences A',$2),($3,'Sequences B',$4)", [accountA, adminUser, accountB, ownerUserB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [accountA, adminUser, agentUser, viewerUser, accountB, ownerUserB]);
    const scopes = ['instagram_business_basic', 'instagram_business_manage_messages'];
    const addAccount = async (accountId: string, userId: string, igUserId: string) => (await owner.query(
      `INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,scopes,connected_by_user_id)
       VALUES($1,$2,'shop',$3,$4,$5) RETURNING id`, [accountId, igUserId, encrypt('test-only-ig-token'), scopes, userId])).rows[0].id as string;
    ids.igA = await addAccount(accountA, adminUser, `86${seed}`);
    ids.igB = await addAccount(accountB, ownerUserB, `87${seed}`);
    const flow = async (accountId: string, userId: string, status: string) => (await owner.query(
      "INSERT INTO flows(account_id,user_id,name,trigger_type,status,channel_scope) VALUES($1,$2,'Sequence message','manual',$3,'instagram') RETURNING id",
      [accountId, userId, status])).rows[0].id as string;
    ids.liveFlow = await flow(accountA, adminUser, 'active');
    ids.draftFlow = await flow(accountA, adminUser, 'draft');
    ids.liveFlowB = await flow(accountB, ownerUserB, 'active');
  });

  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    h.start.mockReset();
    h.start.mockImplementation(startRecordsRun());
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminUser, agentUser, viewerUser, ownerUserB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  /** A sequence of A with `flows.length` messages; the first is immediate, the rest one hour apart. */
  async function sequenceWith(flows: string[]): Promise<{ id: string; messages: string[] }> {
    const created = await createSequence(agentA, `Welcome ${randomUUID().slice(0, 6)}`);
    let detail = created;
    for (const flowId of flows) detail = await addMessage(agentA, created.id, { kind: 'existing', flowId });
    for (const item of detail.items.slice(1)) detail = await updateMessage(agentA, created.id, item.id, { delay: { amount: 1, unit: 'hours' } });
    return { id: created.id, messages: detail.items.map((i) => i.id) };
  }

  describe('tenancy and roles', () => {
    it('keeps sequences, messages and subscribers to the workspace', async () => {
      const seq = await sequenceWith([ids.liveFlow]);
      const other = await thread(accountB, ownerUserB, ids.igB, `71${seed}`, '1 minute');
      expect((await listSequences(ownerB)).map((s) => s.id)).not.toContain(seq.id);
      await expect(getSequence(ownerB, seq.id)).rejects.toMatchObject({ code: 'notFound' });
      await expect(updateSequence(ownerB, seq.id, { name: 'Taken' })).rejects.toMatchObject({ code: 'notFound' });
      await expect(addMessage(ownerB, seq.id, { kind: 'existing', flowId: ids.liveFlowB })).rejects.toMatchObject({ code: 'notFound' });
      await expect(updateMessage(ownerB, seq.id, seq.messages[0], { active: false })).rejects.toMatchObject({ code: 'notFound' });
      await expect(deleteMessage(ownerB, seq.id, seq.messages[0])).rejects.toMatchObject({ code: 'notFound' });
      await expect(reorderMessages(ownerB, seq.id, seq.messages)).rejects.toMatchObject({ code: 'notFound' });
      await expect(listSubscribers(ownerB, seq.id)).rejects.toMatchObject({ code: 'notFound' });
      await expect(changeSubscriber(ownerB, seq.id, { action: 'subscribe', contactId: other.contact })).rejects.toMatchObject({ code: 'notFound' });
      await expect(archiveSequence(ownerB, seq.id)).rejects.toMatchObject({ code: 'notFound' });
      // Another workspace's automation and contact cannot be attached to A's sequence.
      await expect(addMessage(agentA, seq.id, { kind: 'existing', flowId: ids.liveFlowB })).rejects.toMatchObject({ code: 'flowNotFound' });
      await expect(updateMessage(agentA, seq.id, seq.messages[0], { flowId: ids.liveFlowB })).rejects.toMatchObject({ code: 'flowNotFound' });
      await expect(changeSubscriber(agentA, seq.id, { action: 'subscribe', contactId: other.contact })).rejects.toMatchObject({ code: 'notFound' });
      // The engine-facing calls are bound by the composite keys and RLS as well.
      expect(await sequenceSubscriptions.subscribe(accountB, other.contact, seq.id)).toBe('unavailable');
      expect(await sequenceSubscriptions.subscribe(accountA, other.contact, seq.id)).toBe('unavailable');
      // The delivery log is readable by members and never writable by the app role.
      expect(await code(withTenant(adminA, (tx) => tx.$executeRaw`INSERT INTO sequence_message_sends(account_id,subscription_id,round_started_at,
        sequence_id,sequence_message_id,contact_id,status) VALUES(${accountA}::uuid,gen_random_uuid(),now(),${seq.id}::uuid,
        ${seq.messages[0]}::uuid,gen_random_uuid(),'starting')`))).not.toBeNull();
    });

    it('lets members read and agents write; viewers change nothing', async () => {
      const seq = await sequenceWith([ids.liveFlow]);
      expect((await getSequence(viewerA, seq.id)).items).toHaveLength(1);
      expect(await code(createSequence(viewerA, 'Viewer'))).not.toBeNull();
      expect(await code(updateSequence(viewerA, seq.id, { status: 'paused' }))).not.toBeNull();
      expect((await getSequence(adminA, seq.id)).status).toBe('active');
    });

    it('creates a draft Instagram automation for a new message and caps messages at 50', async () => {
      const seq = await createSequence(agentA, 'Fifty');
      const detail = await addMessage(agentA, seq.id, { kind: 'new', name: 'Day one' });
      const flow = (await owner.query('SELECT status, channel_scope, trigger_type, account_id FROM flows WHERE id=$1', [detail.items[0].flow_id])).rows[0];
      expect(flow).toEqual({ status: 'draft', channel_scope: 'instagram', trigger_type: 'manual', account_id: accountA });
      expect(detail.items[0]).toMatchObject({ position: 0, delay_amount: 0, active: true, flow_status: 'draft' });
      for (let i = 1; i < 50; i += 1) await owner.query(
        "INSERT INTO sequence_messages(account_id,sequence_id,position,delay_amount,delay_unit) VALUES($1,$2,$3,1,'days')", [accountA, seq.id, i]);
      await expect(addMessage(agentA, seq.id, { kind: 'existing', flowId: ids.liveFlow })).rejects.toMatchObject({ code: 'tooManyMessages' });
    });

    it('reorders by swapping positions and refuses an order that drops a message', async () => {
      const seq = await sequenceWith([ids.liveFlow, ids.draftFlow]);
      const reordered = await reorderMessages(agentA, seq.id, [...seq.messages].reverse());
      expect(reordered.items.map((i) => i.id)).toEqual([...seq.messages].reverse());
      await expect(reorderMessages(agentA, seq.id, [seq.messages[0]])).rejects.toMatchObject({ code: 'invalid_request' });
    });
  });

  describe('delivery', () => {
    it('claims and starts a due message once, even with two workers at the same time', async () => {
      const seq = await sequenceWith([ids.liveFlow, ids.liveFlow]);
      const t = await thread(accountA, adminUser, ids.igA, `72${seed}`, '1 minute');
      expect(await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id)).toBe('subscribed');
      expect(await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id)).toBe('already_subscribed');
      await Promise.all([runDueSequences(accountA), runDueSequences(accountA)]);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(h.start.mock.calls[0][0]).toMatchObject({ accountId: accountA, contactId: t.contact, conversationId: t.conversation, flowId: ids.liveFlow });
      expect(await sends(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'sent', position: 0, flow_run_id: expect.any(String) })]);
      const sub = await subscription(seq.id, t.contact);
      expect(sub).toMatchObject({ status: 'active', next_position: 1, claimed_at: null });
      // The second message is an hour after the first.
      expect(new Date(sub.next_due_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
      expect(await runDueSequences(accountA)).toBe(0);
      expect((await getSequence(viewerA, seq.id)).items[0]).toMatchObject({ sent: 1, clicks: 0, ctr: null });
      expect(await withTenant(viewerA, (tx) => contactInSequence(tx, accountA, t.contact, seq.id))).toBe(true);
      // Another workspace's worker run touches nothing of A's.
      expect(await runDueSequences(accountB)).toBe(0);
    });

    it('skips a message due outside the 24-hour window, logs window_closed and starts nothing', async () => {
      const seq = await sequenceWith([ids.liveFlow, ids.liveFlow]);
      const t = await thread(accountA, adminUser, ids.igA, `73${seed}`, '25 hours');
      await changeSubscriber(agentA, seq.id, { action: 'subscribe', contactId: t.contact });
      expect(await runDueSequences(accountA)).toBe(1);
      expect(h.start).not.toHaveBeenCalled();
      expect(await sends(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'skipped', reason: 'window_closed', flow_run_id: null })]);
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'active', next_position: 1 });
      expect((await owner.query('SELECT count(*)::int AS n FROM outbound_intents WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
    });

    it('skips an inactive message or one whose automation is not live, and moves on', async () => {
      const seq = await sequenceWith([ids.liveFlow, ids.draftFlow]);
      await updateMessage(agentA, seq.id, seq.messages[0], { active: false });
      await updateMessage(agentA, seq.id, seq.messages[1], { delay: { amount: 0, unit: 'minutes' } });
      const t = await thread(accountA, adminUser, ids.igA, `74${seed}`, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await runDueSequences(accountA);
      expect(h.start).not.toHaveBeenCalled();
      expect((await sends(seq.id, t.contact)).map((s) => s.reason)).toEqual(['inactive', 'flow_not_live']);
      // Past the last message the subscription waits for one to be added.
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'active', next_due_at: null, next_position: 2 });
      await addMessage(agentA, seq.id, { kind: 'existing', flowId: ids.liveFlow });
      expect((await subscription(seq.id, t.contact)).next_due_at).not.toBeNull();
    });

    it('stops at once on unsubscribe mid-sequence and on Instagram opt-out', async () => {
      const seq = await sequenceWith([ids.liveFlow, ids.liveFlow, ids.liveFlow]);
      const quits = await thread(accountA, adminUser, ids.igA, `75${seed}`, '1 minute');
      const stops = await thread(accountA, adminUser, ids.igA, `76${seed}`, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, quits.contact, seq.id);
      await sequenceSubscriptions.subscribe(accountA, stops.contact, seq.id);
      await runDueSequences(accountA);
      expect(h.start).toHaveBeenCalledTimes(2);

      expect(await changeSubscriber(agentA, seq.id, { action: 'unsubscribe', contactId: quits.contact })).toEqual({ status: 'unsubscribed' });
      await makeDue(seq.id, quits.contact);
      await owner.query('UPDATE contacts SET instagram_opted_out_at = now() WHERE id=$1', [stops.contact]);
      await makeDue(seq.id, stops.contact);
      await runDueSequences(accountA);
      expect(h.start).toHaveBeenCalledTimes(2);
      expect((await subscription(seq.id, quits.contact)).status).toBe('unsubscribed');
      expect((await subscription(seq.id, stops.contact)).status).toBe('unsubscribed');
      expect((await listSubscribers(viewerA, seq.id)).map((s) => s.status)).toEqual(['unsubscribed', 'unsubscribed']);
      // Opt-out handlers end every running subscription of the contact in one call (5D).
      await sequenceSubscriptions.subscribe(accountA, quits.contact, seq.id);
      expect(await withTenant({ accountId: accountA, role: 'owner' }, (tx) => endSequencesForContact(tx, accountA, quits.contact),
        getWorkerPrisma())).toBe(1);
    });

    it('recovers a claim a crashed worker left: finds the run it started and never starts a second one', async () => {
      const seq = await sequenceWith([ids.liveFlow]);
      const t = await thread(accountA, adminUser, ids.igA, `77${seed}`, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      // The run is recorded, then the worker dies before it settles.
      h.start.mockImplementationOnce(async (input: Parameters<ReturnType<typeof startRecordsRun>>[0]) => {
        await startRecordsRun()(input);
        throw new Error('worker lost');
      });
      await runDueSequences(accountA);
      expect((await subscription(seq.id, t.contact)).status).toBe('sending');
      expect(await sends(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'starting' })]);
      // Inside the lease nothing happens; after it the due function offers the workspace again.
      expect(await runDueSequences(accountA)).toBe(0);
      await owner.query("UPDATE sequence_subscriptions SET claimed_at = now() - interval '11 minutes' WHERE sequence_id=$1", [seq.id]);
      const due = await withTenant({ accountId: accountA, role: 'owner' },
        (tx) => tx.$queryRaw<{ account_id: string }[]>`SELECT account_id::text AS account_id FROM crm_due_sequence_accounts()`, getWorkerPrisma());
      expect(due.map((r) => r.account_id)).toContain(accountA);
      expect(await runDueSequences(accountA)).toBe(1);
      expect(h.start).toHaveBeenCalledTimes(1);
      expect(await sends(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'sent', flow_run_id: expect.any(String) })]);
    });

    it('retries later while another automation is running, and ends a start that keeps failing without a run', async () => {
      const seq = await sequenceWith([ids.liveFlow]);
      const t = await thread(accountA, adminUser, ids.igA, `78${seed}`, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      h.start.mockImplementation(startRecordsRun('conflict'));
      await runDueSequences(accountA);
      const later = await subscription(seq.id, t.contact);
      expect(later.status).toBe('active');
      expect(new Date(later.next_due_at).getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
      for (let i = 0; i < 5; i += 1) { await makeDue(seq.id, t.contact); await runDueSequences(accountA); }
      expect(await sends(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'failed', reason: 'start_failed', flow_run_id: null })]);
    });

    it('sends nothing for a paused sequence and nothing at all while Instagram is off', async () => {
      const seq = await sequenceWith([ids.liveFlow]);
      const t = await thread(accountA, adminUser, ids.igA, `79${seed}`, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await updateSequence(agentA, seq.id, { status: 'paused' });
      await runDueSequences(accountA);
      vi.stubEnv('INSTAGRAM_ENABLED', 'false');
      await updateSequence(adminA, seq.id, { status: 'active' });
      expect(await runDueSequences(accountA)).toBe(0);
      expect(h.start).not.toHaveBeenCalled();
      expect((await subscription(seq.id, t.contact)).status).toBe('active');
    });
  });
});
