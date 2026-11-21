// WhatsApp sequences and "Exit when" (batch 7) on PostgreSQL:
//   - the 24-hour rule when a step falls due: free-form text or media inside
//     the window, the approved template (values filled from the contact) at any
//     time outside it, and a skip logged outside_window_no_template without one;
//   - durability: each send goes through an outbound intent keyed by its
//     delivery row; an ambiguous outcome is recorded outcome_unknown and never
//     sent again, also when a crashed worker's claim is taken again;
//   - exitSequencesFor: replied, tagged and bought, only for sequences with the
//     matching setting, only subscriptions that began before the event, and
//     never across workspaces; wired into the inbound message path, the tag
//     writer and the order.paid event dispatch.
// Meta is never called: the engine senders are fakes.
//
// Connection settings come only from the environment (TEST_DATABASE_URL,
// TEST_APP_DATABASE_URL, TEST_WORKER_DATABASE_URL); the suite is skipped
// without them and refuses a non-test database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sends = vi.hoisted(() => ({ text: vi.fn(), template: vi.fn(), media: vi.fn(), rules: vi.fn(), flows: vi.fn() }));
vi.mock('@/lib/automations/meta-send', async (original) => ({
  ...(await original<typeof import('@/lib/automations/meta-send')>()),
  engineSendText: sends.text, engineSendTemplate: sends.template,
}));
vi.mock('@/lib/flows/meta-send', async (original) => ({
  ...(await original<typeof import('@/lib/flows/meta-send')>()),
  engineSendMedia: sends.media,
}));
// The other targets of a tag or an event: nothing is configured, and they are not under test here.
vi.mock('@/lib/automations/engine', async (original) => ({
  ...(await original<typeof import('@/lib/automations/engine')>()),
  runAutomationsForTrigger: sends.rules,
}));
vi.mock('@/lib/flows/event-start', async (original) => ({
  ...(await original<typeof import('@/lib/flows/event-start')>()),
  startFlowsForEvent: sends.flows,
}));

import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { createAdminClient } from '@/lib/data/admin';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { handleEventDispatchJob } from '@/lib/events/dispatch';
import { ingestInboundMessage } from '@/lib/whatsapp/ingest';
import { addMessage, createSequence, getSequence, listSubscribers, updateSequence } from './store';
import { exitSequencesFor, sequenceSubscriptions } from './subscriptions';
import type { WhatsAppStep } from './whatsapp';
import { runDueSequences, sequenceSendIntentKey } from './worker';

const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;
process.env.APP_URL ??= 'https://app.example.test';
process.env.ENCRYPTION_KEY ??= 'a'.repeat(64);

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const numberA = randomUUID(), numberB = randomUUID();
const tagA = randomUUID(), tagB = randomUUID();
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asOwnerB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-7);
let phoneCounter = 0;
let db: pg.Client;

const workerA = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: accountA, role: 'owner' }, fn, getWorkerPrisma());

type Thread = { contact: string; conversation: string };

/** A WhatsApp contact and conversation; the customer last wrote `ago` before now (null: never). */
async function thread(accountId: string, ago: string | null, name = 'Asha'): Promise<Thread> {
  const owner = accountId === accountA ? ownerA : ownerB;
  phoneCounter += 1;
  const contact = (await db.query('INSERT INTO contacts(account_id,user_id,name,phone,company) VALUES($1,$2,$3,$4,NULL) RETURNING id',
    [accountId, owner, name, `+1415${seed}${String(phoneCounter).padStart(3, '0')}`])).rows[0].id as string;
  const conversation = (await db.query(`INSERT INTO conversations(account_id,user_id,contact_id,whatsapp_config_id)
    VALUES($1,$2,$3,$4) RETURNING id`, [accountId, owner, contact, accountId === accountA ? numberA : numberB])).rows[0].id as string;
  if (ago) await db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status,created_at)
    VALUES($1,$2,'customer','text','hi',$3,'delivered',now() - $4::interval)`, [accountId, conversation, `wamid.in.${randomUUID()}`, ago]);
  return { contact, conversation };
}

/** A WhatsApp sequence of A with one immediate step. */
async function whatsappSequence(step: WhatsAppStep, ctx: TenantContext = asAgentA) {
  const created = await createSequence(ctx, `WA ${randomUUID().slice(0, 6)}`, 'whatsapp');
  const detail = await addMessage(ctx, created.id, { kind: 'whatsapp', step });
  return { id: created.id, message: detail.items[0].id };
}

const subscription = async (sequenceId: string, contactId: string) => (await db.query(
  'SELECT status, exit_reason, next_position, claimed_at FROM sequence_subscriptions WHERE sequence_id=$1 AND contact_id=$2',
  [sequenceId, contactId])).rows[0] as { status: string; exit_reason: string | null; next_position: number; claimed_at: Date | null };
const deliveries = async (sequenceId: string, contactId: string) => (await db.query(
  'SELECT id, status, reason, sent_as, channel_message_id FROM sequence_message_sends WHERE sequence_id=$1 AND contact_id=$2 ORDER BY created_at',
  [sequenceId, contactId])).rows as { id: string; status: string; reason: string | null; sent_as: string | null; channel_message_id: string | null }[];
const intent = async (accountId: string, sendId: string) => (await db.query(
  'SELECT status FROM outbound_intents WHERE account_id=$1 AND idempotency_key=$2', [accountId, `${accountId}:${sequenceSendIntentKey(sendId)}`])).rows[0];

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp sequences and Exit when on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await db.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await db.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'WA sequence test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agentA, ownerB]]);
    await db.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'WA seq A',$2),($3,'WA seq B',$4)", [accountA, ownerA, accountB, ownerB]);
    await db.query("INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,'basic'),($2,'basic')", [accountA, accountB]);
    await db.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, ownerA, agentA, accountB, ownerB]);
    await db.query(`INSERT INTO whatsapp_config(id,account_id,user_id,phone_number_id,access_token,status,is_default)
      VALUES($1,$2,$3,$4,'test-token','connected',true),($5,$6,$7,$8,'test-token','connected',true)`,
    [numberA, accountA, ownerA, `pn-${accountA}`, numberB, accountB, ownerB, `pn-${accountB}`]);
    await db.query(`INSERT INTO message_templates(account_id,user_id,name,language,category,status,body_text)
      VALUES($1,$2,'seq_comeback','en','Marketing','APPROVED','Hi {{1}}, {{2}} is waiting for you'),
            ($1,$2,'seq_draft','en','Marketing','PENDING','Hi {{1}}')`, [accountA, ownerA]);
    await db.query("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'VIP'),($4,$5,$6,'VIP')", [tagA, accountA, ownerA, tagB, accountB, ownerB]);
  });

  beforeEach(() => {
    sends.text.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.text' });
    sends.template.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.template' });
    sends.media.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid.media' });
    sends.rules.mockReset().mockResolvedValue(0);
    sends.flows.mockReset().mockResolvedValue(0);
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await db.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[ownerA, agentA, ownerB]]);
      await db.end();
    }
    await disconnectDatabases();
  });

  const comeback = { name: 'seq_comeback', language: 'en', params: ['{{contact.name|there}}', '{{contact.company|Your cart}}'] };

  describe('the 24-hour rule', () => {
    it('sends the free-form text inside the window, filled from the contact, through one accepted intent', async () => {
      const seq = await whatsappSequence({ text: 'Hi {{contact.name|there}}!', media: null, template: comeback });
      const t = await thread(accountA, '1 hour');
      expect(await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id)).toBe('subscribed');
      expect(await runDueSequences(accountA)).toBe(1);
      expect(sends.template).not.toHaveBeenCalled();
      expect(sends.text).toHaveBeenCalledTimes(1);
      expect(sends.text.mock.calls[0][0]).toMatchObject({ accountId: accountA, conversationId: t.conversation, contactId: t.contact, text: 'Hi Asha!' });
      const [row] = await deliveries(seq.id, t.contact);
      expect(row).toMatchObject({ status: 'sent', reason: null, sent_as: 'message', channel_message_id: 'wamid.text' });
      expect(await intent(accountA, row.id)).toEqual({ status: 'accepted' });
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'active', next_position: 1, claimed_at: null });
      // Nothing more is due: a second run sends nothing.
      expect(await runDueSequences(accountA)).toBe(0);
      expect(sends.text).toHaveBeenCalledTimes(1);
    });

    it('sends the approved template outside the window, any time later, with values from the contact', async () => {
      const seq = await whatsappSequence({ text: 'Hi {{contact.name|there}}!', media: null, template: comeback });
      const t = await thread(accountA, '30 hours');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await runDueSequences(accountA);
      expect(sends.text).not.toHaveBeenCalled();
      expect(sends.template).toHaveBeenCalledTimes(1);
      expect(sends.template.mock.calls[0][0]).toMatchObject({
        templateName: 'seq_comeback', language: 'en', params: ['Asha', 'Your cart'], bodyValuesOnly: true,
      });
      expect(await deliveries(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'sent', sent_as: 'template', channel_message_id: 'wamid.template' })]);
    });

    it('skips a step without a template outside the window: logged, counted, nothing sent', async () => {
      const seq = await whatsappSequence({ text: 'Only inside the window', media: null, template: null });
      const never = await thread(accountA, null);
      const late = await thread(accountA, '2 days');
      await sequenceSubscriptions.subscribe(accountA, never.contact, seq.id);
      await sequenceSubscriptions.subscribe(accountA, late.contact, seq.id);
      expect(await runDueSequences(accountA)).toBe(2);
      expect(sends.text).not.toHaveBeenCalled();
      expect(sends.template).not.toHaveBeenCalled();
      for (const t of [never, late]) {
        const rows = await deliveries(seq.id, t.contact);
        expect(rows).toEqual([expect.objectContaining({ status: 'skipped', reason: 'outside_window_no_template' })]);
        expect(await intent(accountA, rows[0].id)).toBeUndefined();
      }
      expect((await getSequence(asAgentA, seq.id)).items[0].skipped_no_template).toBe(2);
    });

    it('sends media with its caption inside the window', async () => {
      const seq = await whatsappSequence({ text: 'Your guide, {{contact.name}}', media: { type: 'document', url: 'https://files.example.test/guide.pdf', filename: 'guide.pdf' }, template: null });
      const t = await thread(accountA, '5 minutes');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await runDueSequences(accountA);
      expect(sends.media).toHaveBeenCalledTimes(1);
      expect(sends.media.mock.calls[0][0]).toMatchObject({ kind: 'document', link: 'https://files.example.test/guide.pdf', caption: 'Your guide, Asha', filename: 'guide.pdf' });
    });

    it('refuses a template that is not approved when the step is saved', async () => {
      const created = await createSequence(asAgentA, 'Refused template', 'whatsapp');
      await expect(addMessage(asAgentA, created.id, { kind: 'whatsapp', step: { text: 'x', media: null, template: { name: 'seq_draft', language: 'en', params: [] } } }))
        .rejects.toMatchObject({ code: 'templateUnusable' });
      await expect(addMessage(asAgentA, created.id, { kind: 'whatsapp', step: { text: 'x', media: null, template: { name: 'no_such', language: null, params: [] } } }))
        .rejects.toMatchObject({ code: 'templateNotFound' });
      // Another workspace's template is not visible either.
      await expect(addMessage(asOwnerB, (await createSequence(asOwnerB, 'B', 'whatsapp')).id,
        { kind: 'whatsapp', step: { text: 'x', media: null, template: comeback } })).rejects.toMatchObject({ code: 'templateNotFound' });
    });
  });

  describe('durability', () => {
    it('records an ambiguous send as outcome_unknown and never sends it again', async () => {
      const seq = await whatsappSequence({ text: 'Once only', media: null, template: null });
      const t = await thread(accountA, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      sends.text.mockRejectedValueOnce(new Error('socket hang up'));
      await runDueSequences(accountA);
      const [row] = await deliveries(seq.id, t.contact);
      expect(row).toMatchObject({ status: 'failed', reason: 'outcome_unknown' });
      expect(await intent(accountA, row.id)).toEqual({ status: 'unknown' });

      // A crashed worker's claim on the same delivery is taken again after the lease: the intent decides, nothing is re-sent.
      await db.query("UPDATE sequence_message_sends SET status='starting', reason=NULL WHERE id=$1", [row.id]);
      await db.query("UPDATE outbound_intents SET status='dispatching' WHERE account_id=$1 AND idempotency_key=$2",
        [accountA, `${accountA}:${sequenceSendIntentKey(row.id)}`]);
      await db.query(`UPDATE sequence_subscriptions SET status='sending', next_position=0, claimed_at=now() - interval '11 minutes'
        WHERE sequence_id=$1 AND contact_id=$2`, [seq.id, t.contact]);
      expect(await runDueSequences(accountA)).toBe(1);
      expect(sends.text).toHaveBeenCalledTimes(1);
      expect(await deliveries(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'failed', reason: 'outcome_unknown' })]);
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'active', next_position: 1 });
    });

    it('settles a crashed claim from its accepted intent without a second send', async () => {
      const seq = await whatsappSequence({ text: 'Settled', media: null, template: null });
      const t = await thread(accountA, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await runDueSequences(accountA);
      const [row] = await deliveries(seq.id, t.contact);
      // The send was accepted but the worker died before it recorded it.
      await db.query("UPDATE sequence_message_sends SET status='starting', channel_message_id=NULL WHERE id=$1", [row.id]);
      await db.query(`UPDATE sequence_subscriptions SET status='sending', next_position=0, claimed_at=now() - interval '11 minutes'
        WHERE sequence_id=$1 AND contact_id=$2`, [seq.id, t.contact]);
      await runDueSequences(accountA);
      expect(sends.text).toHaveBeenCalledTimes(1);
      expect(await deliveries(seq.id, t.contact)).toEqual([expect.objectContaining({ status: 'sent', channel_message_id: 'wamid.text' })]);
    });
  });

  describe('Exit when', () => {
    it('stops before a step when the subscriber replied after joining (checked by the worker)', async () => {
      const seq = await whatsappSequence({ text: 'Follow-up', media: null, template: comeback });
      await updateSequence(asAgentA, seq.id, { exit_on_reply: true });
      const t = await thread(accountA, '3 days');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await db.query(`INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,status)
        VALUES($1,$2,'customer','text','thanks',$3,'delivered')`, [accountA, t.conversation, `wamid.in.${randomUUID()}`]);
      await runDueSequences(accountA);
      expect(sends.text).not.toHaveBeenCalled();
      expect(sends.template).not.toHaveBeenCalled();
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'completed', exit_reason: 'replied' });
      expect((await listSubscribers(asAgentA, seq.id))[0]).toMatchObject({ status: 'completed', exit_reason: 'replied' });
    });

    it('exits only sequences with the matching setting, and only subscriptions that began before the event', async () => {
      const replies = await whatsappSequence({ text: 'a', media: null, template: null });
      const tags = await whatsappSequence({ text: 'b', media: null, template: null });
      const buys = await whatsappSequence({ text: 'c', media: null, template: null });
      await updateSequence(asAgentA, replies.id, { exit_on_reply: true });
      await updateSequence(asAgentA, tags.id, { exit_on_tag_id: tagA });
      await updateSequence(asAgentA, buys.id, { exit_on_purchase: true });
      const t = await thread(accountA, '1 minute');
      for (const s of [replies, tags, buys]) await sequenceSubscriptions.subscribe(accountA, t.contact, s.id);

      // An event from before they joined ends nothing.
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'bought', at: new Date(Date.now() - 3_600_000) }))).toBe(0);
      // Another tag ends nothing; a missing tag id ends nothing.
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'tagged', tagId: randomUUID() }))).toBe(0);
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'tagged' }))).toBe(0);

      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'tagged', tagId: tagA }))).toBe(1);
      expect(await subscription(tags.id, t.contact)).toMatchObject({ status: 'completed', exit_reason: 'tagged' });
      expect(await subscription(replies.id, t.contact)).toMatchObject({ status: 'active', exit_reason: null });
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'bought' }))).toBe(1);
      expect(await subscription(buys.id, t.contact)).toMatchObject({ status: 'completed', exit_reason: 'purchased' });
      // Idempotent: a second call ends nothing more.
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'bought' }))).toBe(0);
      // Subscribing again starts a new round with the reason cleared.
      expect(await sequenceSubscriptions.subscribe(accountA, t.contact, buys.id)).toBe('subscribed');
      expect(await subscription(buys.id, t.contact)).toMatchObject({ status: 'active', exit_reason: null });
    });

    it('leaves a subscription mid-send to the worker, so its claimed send settles or is reconciled', async () => {
      const seq = await whatsappSequence({ text: 'a', media: null, template: null });
      await updateSequence(asAgentA, seq.id, { exit_on_reply: true });
      const t = await thread(accountA, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await db.query("UPDATE sequence_subscriptions SET status='sending', claimed_at=now() WHERE sequence_id=$1", [seq.id]);
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: t.contact, reason: 'replied' }))).toBe(0);
      expect((await subscription(seq.id, t.contact)).status).toBe('sending');
    });

    it("never touches another workspace's subscriptions", async () => {
      const seqA = await whatsappSequence({ text: 'a', media: null, template: null });
      await updateSequence(asAgentA, seqA.id, { exit_on_reply: true, exit_on_tag_id: tagA, exit_on_purchase: true });
      const seqB = await createSequence(asOwnerB, 'B exits', 'whatsapp');
      await addMessage(asOwnerB, seqB.id, { kind: 'whatsapp', step: { text: 'b', media: null, template: null } });
      await updateSequence(asOwnerB, seqB.id, { exit_on_reply: true, exit_on_tag_id: tagB, exit_on_purchase: true });
      const a = await thread(accountA, '1 minute');
      const b = await thread(accountB, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, a.contact, seqA.id);
      await sequenceSubscriptions.subscribe(accountB, b.contact, seqB.id);

      // A's transaction, naming B's contact, B's tag or B's workspace: nothing ends (account filter and RLS).
      for (const reason of ['replied', 'bought'] as const) {
        expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: b.contact, reason }))).toBe(0);
        expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountB, contactId: b.contact, reason }))).toBe(0);
      }
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: [a.contact, b.contact], reason: 'tagged', tagId: tagB }))).toBe(0);
      expect(await subscription(seqB.id, b.contact)).toMatchObject({ status: 'active', exit_reason: null });

      // A's own exit ends only A's subscription.
      expect(await workerA((tx) => exitSequencesFor(tx, { accountId: accountA, contactId: [a.contact, b.contact], reason: 'replied' }))).toBe(1);
      expect(await subscription(seqA.id, a.contact)).toMatchObject({ status: 'completed', exit_reason: 'replied' });
      expect(await subscription(seqB.id, b.contact)).toMatchObject({ status: 'active', exit_reason: null });
    });
  });

  describe('wired into the event paths', () => {
    async function exitingSequence(settings: Parameters<typeof updateSequence>[2]) {
      const seq = await whatsappSequence({ text: 'x', media: null, template: null });
      await updateSequence(asAgentA, seq.id, settings);
      return seq;
    }

    it('an inbound message ends "Exit when replied" sequences in the same transaction', async () => {
      const seq = await exitingSequence({ exit_on_reply: true });
      const keeps = await exitingSequence({ exit_on_purchase: true });
      const t = await thread(accountA, '2 days');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      await sequenceSubscriptions.subscribe(accountA, t.contact, keeps.id);
      await ingestInboundMessage({
        accountId: accountA, userId: ownerA, contactId: t.contact, conversationId: t.conversation, metaMessageId: `wamid.in.${randomUUID()}`,
        contentType: 'text', contentText: 'stop please', mediaUrl: null, mediaType: null, interactiveReplyId: null, replyToMessageId: null,
        createdAt: new Date(), wasContactCreated: false, wasConversationCreated: false,
      });
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'completed', exit_reason: 'replied' });
      expect(await subscription(keeps.id, t.contact)).toMatchObject({ status: 'active' });
    });

    it('the tag writer ends "Exit when tagged" sequences for that tag', async () => {
      const seq = await exitingSequence({ exit_on_tag_id: tagA });
      const t = await thread(accountA, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      const result = await addContactTagAndDispatch({ db: createAdminClient({ accountId: accountA, role: 'owner' }), accountId: accountA,
        contactId: t.contact, tagId: tagA, startFlows: false });
      expect(result.added).toBe(true);
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'completed', exit_reason: 'tagged' });
    });

    it('the order.paid event dispatch ends "Exit when bought" sequences for the buyer', async () => {
      const seq = await exitingSequence({ exit_on_purchase: true });
      const t = await thread(accountA, '1 minute');
      await sequenceSubscriptions.subscribe(accountA, t.contact, seq.id);
      const order = randomUUID();
      await db.query(`INSERT INTO orders(id,account_id,source,contact_id,currency,subtotal_minor,shipping_minor,tax_minor,tax_inclusive,total_minor,
          status,priced_at,paid_at,amount_paid_minor,payment_method)
        VALUES($1,$2,'storefront',$3,'INR',49900,0,0,true,49900,'paid',now(),now(),49900,'online')`, [order, accountA, t.contact]);
      const events = (await db.query("SELECT id, type FROM domain_events WHERE account_id=$1 AND subject_id=$2 ORDER BY type", [accountA, order])).rows;
      expect(events.map((e) => e.type)).toEqual(['order.created', 'order.paid']);
      for (const event of events) await handleEventDispatchJob(accountA, { eventId: event.id });
      expect(await subscription(seq.id, t.contact)).toMatchObject({ status: 'completed', exit_reason: 'purchased' });
    });
  });
});
