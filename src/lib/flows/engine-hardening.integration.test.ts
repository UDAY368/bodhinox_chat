import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getWorkerPrisma } from '@/lib/db/prisma';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';
import { flowPaymentReference } from '@/lib/payments/links';
import type { Job } from '@/lib/jobs/queue';

// Meta and webhook delivery are the only fakes: run rows, consent, outbound
// intents and the inbound stage checkpoints are real.
const h = vi.hoisted(() => {
  let n = 0;
  return {
    template: vi.fn<(args: { contactId: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: `wamid.t${++n}` })),
    webhook: vi.fn(async () => {}),
    onTemplate: null as null | (() => Promise<void>),
  };
});
vi.mock('@/lib/automations/meta-send', async (load) => ({
  ...(await load<typeof import('@/lib/automations/meta-send')>()),
  engineSendTemplate: async (args: { contactId: string }) => {
    if (h.onTemplate) await h.onTemplate();
    return h.template(args);
  },
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.webhook }));

import { handleFlowTimer, resumePaymentLinkRun } from './engine';
import { processInboundActions } from '@/lib/whatsapp/inbound-actions';
import { handleJob } from '@/lib/jobs/handlers';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), user = randomUUID(), tplFlow = randomUUID(), payFlow = randomUUID();
const seed = String(Date.now()).slice(-8);
const scope = { accountId: account, role: 'owner' as const };
let owner: pg.Client;
let phones = 0;

async function contactWithConversation(opts: { optedOut?: boolean; blocked?: boolean; numberId?: string | null } = {}) {
  const contact = randomUUID(), conversation = randomUUID();
  await owner.query('INSERT INTO contacts(id,account_id,user_id,name,phone,opted_out_at,blocked_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [contact, account, user, 'C', `1415${seed}${++phones}`, opts.optedOut ? new Date() : null, opts.blocked ? new Date() : null]);
  await owner.query("INSERT INTO conversations(id,account_id,user_id,contact_id,status,whatsapp_config_id) VALUES($1,$2,$3,$4,'open',$5)",
    [conversation, account, user, contact, opts.numberId ?? null]);
  return { contact, conversation };
}
async function addConversation(contact: string, numberId: string | null) {
  return (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status,whatsapp_config_id) VALUES($1,$2,$3,'open',$4) RETURNING id",
    [account, user, contact, numberId])).rows[0].id as string;
}
async function addRun(flow: string, c: { contact: string; conversation: string }, node: string, seq: number, extra: { delay?: boolean; reprompts?: number; waitUntil?: Date } = {}) {
  const run = randomUUID();
  await owner.query(`INSERT INTO flow_runs(id,account_id,flow_id,user_id,contact_id,conversation_id,status,current_node_key,transition_seq,reprompt_count,delay_until,wait_until)
    VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11)`,
    [run, account, flow, user, c.contact, c.conversation, node, seq, extra.reprompts ?? 0, extra.delay ? new Date() : null, extra.waitUntil ?? null]);
  return run;
}
const runRow = async (id: string) => (await owner.query('SELECT status,end_reason,current_node_key,wait_until FROM flow_runs WHERE id=$1', [id])).rows[0];
const flowCompletedCalls = () => (h.webhook.mock.calls as unknown as unknown[][]).filter((call) => call[2] === 'flow.completed');
const fireDelay = (runId: string, nodeKey: string, seq: number) => withJobScope(scope, () =>
  handleFlowTimer({ accountId: account, runId, nodeKey, seq, kind: 'delay' }));
const resume = (runId: string, referenceId: string) => withJobScope(scope, () =>
  resumePaymentLinkRun({ accountId: account, runId, nodeKey: 'pay', referenceId, outcome: 'paid', status: 'paid' }));
async function inbound(c: { contact: string; conversation: string }, text: string) {
  const message = (await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id) VALUES($1,$2,'customer','text',$3,$4) RETURNING id",
    [account, c.conversation, text, `wamid.in.${randomUUID()}`])).rows[0].id as string;
  await processInboundActions({ kind: 'message', accountId: account, userId: user, contactId: c.contact, conversationId: c.conversation, messageId: message,
    metaMessageId: `wamid.in.${randomUUID()}`, contentType: 'text', contentText: text, interactiveReplyId: null,
    wasContactCreated: false, wasConversationCreated: false, isFirstInboundMessage: false });
}

describe.skipIf(!ownerUrl || !workerUrl)('flow engine hardening on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Hardening test','test-only-hash')", [user, `${user}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Hardening',$2)", [account, user]);
    // wait: a marketing template sent after a 60s delay -> done
    await owner.query("INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,entry_node_id) VALUES($1,$2,$3,'Promo','active','manual','start')", [tplFlow, account, user]);
    await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
      ($1,$2,'start','start','{"next_node_key":"wait"}'),
      ($1,$2,'wait','send_template','{"template_name":"spring_sale","language":"en","next_node_key":"done","delay_seconds":60}'),
      ($1,$2,'done','end','{}')`, [account, tplFlow]);
    // pay (payment link) -> paid: done
    await owner.query("INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,entry_node_id) VALUES($1,$2,$3,'Pay','active','manual','start')", [payFlow, account, user]);
    await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
      ($1,$2,'start','start','{"next_node_key":"pay"}'),
      ($1,$2,'pay','payment_link','{"amount":"100","currency":"INR","message":"Pay","paid_next":"done"}'),
      ($1,$2,'done','end','{}')`, [account, payFlow]);
  });
  beforeEach(() => { h.template.mockClear(); h.webhook.mockClear(); h.onTemplate = null; });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [user]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  describe('A15: consent on flow template steps', () => {
    it('skips the template for a contact who opted out while the run waited, and carries on', async () => {
      const c = await contactWithConversation({ optedOut: true });
      const run = await addRun(tplFlow, c, 'wait', 1, { delay: true });
      expect(await fireDelay(run, 'wait', 1)).toBe('fired');
      expect(h.template).not.toHaveBeenCalled();
      expect(await runRow(run)).toMatchObject({ status: 'completed', end_reason: 'end_node' });
      const skipped = (await owner.query("SELECT payload FROM flow_run_events WHERE flow_run_id=$1 AND event_type='error'", [run])).rows;
      expect(skipped).toEqual([{ payload: { reason: 'template_suppressed', detail: 'contact opted out' } }]);
    });

    it('still sends the template to a subscribed contact', async () => {
      const c = await contactWithConversation();
      const run = await addRun(tplFlow, c, 'wait', 1, { delay: true });
      expect(await fireDelay(run, 'wait', 1)).toBe('fired');
      expect(h.template).toHaveBeenCalledOnce();
      expect(await runRow(run)).toMatchObject({ status: 'completed', end_reason: 'end_node' });
    });

    it('a STOP message cancels the contact\'s waiting run, so the timer sends nothing later', async () => {
      const c = await contactWithConversation();
      const run = await addRun(tplFlow, c, 'wait', 1, { delay: true });
      await withJobScope(scope, () => inbound(c, 'STOP'));
      expect(await runRow(run)).toMatchObject({ status: 'cancelled', end_reason: 'contact_opted_out' });
      expect(await fireDelay(run, 'wait', 1)).toBe('stale');
      expect(h.template).not.toHaveBeenCalled();
    });
  });

  describe('A9: a run ends only while still active', () => {
    it('keeps an agent\'s takeover and emits no flow.completed when the engine reaches the end node', async () => {
      const c = await contactWithConversation();
      const run = await addRun(tplFlow, c, 'wait', 1, { delay: true });
      // The agent replies (send-message.ts) while the template is going out.
      h.onTemplate = async () => { await owner.query("UPDATE flow_runs SET status='paused_by_agent',ended_at=now(),end_reason='agent_replied' WHERE id=$1", [run]); };
      expect(await fireDelay(run, 'wait', 1)).toBe('fired');
      expect(await runRow(run)).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' });
      expect(flowCompletedCalls()).toHaveLength(0);
    });

    it('emits flow.completed for a run it did end', async () => {
      const c = await contactWithConversation();
      const run = await addRun(tplFlow, c, 'wait', 1, { delay: true });
      expect(await fireDelay(run, 'wait', 1)).toBe('fired');
      expect(flowCompletedCalls()).toHaveLength(1);
    });
  });

  describe('A16: payment resume after a crashed claim', () => {
    it('resumes a waiting run once and clears its payment wait', async () => {
      const c = await contactWithConversation();
      const run = await addRun(payFlow, c, 'pay', 2, { waitUntil: new Date(Date.now() + 86_400_000) });
      const reference = flowPaymentReference(run, 'pay', 2);
      expect(await resume(run, reference)).toBe('resumed');
      expect(await runRow(run)).toMatchObject({ status: 'completed', end_reason: 'end_node', wait_until: null });
      expect(await resume(run, reference)).toBe('stale');
    });

    it('carries on from the paid port when a worker died after claiming the transition', async () => {
      const c = await contactWithConversation();
      // Claimed: one transition on, sitting on paid_next, nothing run since.
      const run = await addRun(payFlow, c, 'done', 3);
      expect(await resume(run, flowPaymentReference(run, 'pay', 2))).toBe('resumed');
      expect(await runRow(run)).toMatchObject({ status: 'completed', end_reason: 'end_node' });
    });

    it('leaves a run that moved on further, or answered another link, alone', async () => {
      const moved = await addRun(payFlow, await contactWithConversation(), 'done', 3, { reprompts: 1 });
      expect(await resume(moved, flowPaymentReference(moved, 'pay', 2))).toBe('stale');
      const other = await addRun(payFlow, await contactWithConversation(), 'done', 3);
      expect(await resume(other, flowPaymentReference(other, 'pay', 1))).toBe('stale');
      expect((await runRow(moved)).status).toBe('active');
      expect((await runRow(other)).status).toBe('active');
    });
  });

  describe('A17: the stale sweep waits for a payable link', () => {
    it('times out an idle run but not one whose link is still payable', async () => {
      const idle = await addRun(payFlow, await contactWithConversation(), 'pay', 1);
      const paying = await addRun(payFlow, await contactWithConversation(), 'pay', 1, { waitUntil: new Date(Date.now() + 86_400_000) });
      await owner.query("UPDATE flow_runs SET last_advanced_at=now()-interval '30 hours' WHERE id=ANY($1)", [[idle, paying]]);
      await handleJob({ id: randomUUID(), type: 'flow.sweep', tenant_id: account, payload: {}, attempts: 1, max_attempts: 3 } as unknown as Job);
      expect(await runRow(idle)).toMatchObject({ status: 'timed_out', end_reason: 'stale_sweep' });
      expect((await runRow(paying)).status).toBe('active');
    });
  });

  describe('A5: campaign replies count only on the number the campaign used', () => {
    it('marks the send on the same number, ignores other numbers, and maps legacy sends to the default number', async () => {
      const numberA = (await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status,is_default)
        VALUES($1,$2,$3,$4,'connected',true) RETURNING id`, [account, user, `76${seed}`, encrypt('test-only-token')])).rows[0].id as string;
      const numberB = (await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,status)
        VALUES($1,$2,$3,$4,'connected') RETURNING id`, [account, user, `77${seed}`, encrypt('test-only-token')])).rows[0].id as string;
      const broadcast = async (numberId: string | null) => (await owner.query(
        "INSERT INTO broadcasts(account_id,user_id,name,template_name,status,whatsapp_config_id) VALUES($1,$2,'B','spring_sale','sent',$3) RETURNING id",
        [account, user, numberId])).rows[0].id as string;
      const recipient = async (broadcastId: string, contact: string, hoursAgo = 1) => (await owner.query(
        "INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,sent_at) VALUES($1,$2,$3,'delivered',now()-make_interval(hours=>$4)) RETURNING id",
        [account, broadcastId, contact, hoursAgo])).rows[0].id as string;
      const status = async (id: string) => (await owner.query('SELECT status FROM broadcast_recipients WHERE id=$1', [id])).rows[0].status;
      // Blocked contacts: the reply is still recorded, with no automated response to fake.
      const onA = await contactWithConversation({ blocked: true, numberId: numberA });
      const sentOnA = await recipient(await broadcast(numberA), onA.contact);
      const convB = { contact: onA.contact, conversation: await addConversation(onA.contact, numberB) };
      await withJobScope(scope, () => inbound(convB, 'about my other order'));
      expect(await status(sentOnA)).toBe('delivered');
      await withJobScope(scope, () => inbound(onA, 'interested'));
      expect(await status(sentOnA)).toBe('replied');

      const legacy = await contactWithConversation({ blocked: true, numberId: numberB });
      const legacySend = await recipient(await broadcast(null), legacy.contact);
      await withJobScope(scope, () => inbound(legacy, 'hi'));
      expect(await status(legacySend)).toBe('delivered');
      const legacyOnA = { contact: legacy.contact, conversation: await addConversation(legacy.contact, numberA) };
      await withJobScope(scope, () => inbound(legacyOnA, 'hi'));
      expect(await status(legacySend)).toBe('replied');

      const late = await contactWithConversation({ blocked: true, numberId: numberA });
      const oldSend = await recipient(await broadcast(numberA), late.contact, 96);
      await withJobScope(scope, () => inbound(late, 'hello'));
      expect(await status(oldSend)).toBe('delivered');
    });
  });
});
