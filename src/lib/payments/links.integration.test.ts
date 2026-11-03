import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';

// Razorpay and Meta are the only fakes: rows, RLS, intents, receipts and the flow engine are real.
const h = vi.hoisted(() => {
  let n = 0;
  const link = (referenceId: string, status = 'created', amount = 49_900) => ({
    id: `plink_T${++n}x${Date.now() % 100000}`, shortUrl: `https://rzp.io/l/t${n}`, status, amountMinor: amount, amountPaidMinor: status === 'paid' ? amount : 0,
    currency: 'INR', referenceId, expireBy: null,
  });
  return {
    link,
    create: vi.fn(async (args: { referenceId: string; amountMinor: number }) => ({ outcome: 'created' as const, link: link(args.referenceId, 'created', args.amountMinor) }) as unknown),
    fetchByReference: vi.fn<(args: { referenceId: string }) => Promise<unknown>>(async () => null),
    fetch: vi.fn<(args: { id: string }) => Promise<unknown>>(async () => null),
    cancel: vi.fn(async (args: { id: string }) => ({ ...link('x', 'cancelled'), id: args.id }) as unknown),
    sendText: vi.fn<(args: { conversationId: string; text: string }) => Promise<{ whatsapp_message_id: string }>>(async () => ({ whatsapp_message_id: `wamid.pay.${++n}` })),
    metaSendText: vi.fn<(args: { phoneNumberId: string; to: string; text: string }) => Promise<{ messageId: string }>>(async () => ({ messageId: `wamid.inbox.${++n}` })),
    dispatch: vi.fn<(db: unknown, accountId: string, event: string, data: Record<string, unknown>) => Promise<void>>(async () => {}),
  };
});
vi.mock('@/lib/payments/razorpay', async (orig) => ({
  ...(await orig<typeof import('./razorpay')>()),
  createPaymentLink: h.create,
  fetchPaymentLinkByReference: h.fetchByReference,
  fetchPaymentLink: h.fetch,
  cancelPaymentLink: h.cancel,
}));
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.sendText, engineSendMedia: h.sendText, engineSendInteractiveButtons: h.sendText, engineSendInteractiveList: h.sendText,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatch }));
vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTextMessage: h.metaSendText,
}));

import { claimWebhookReceipt } from '@/lib/commerce/webhook-receipts';
import { startFlowById } from '@/lib/flows/engine';
import { savePaymentProvider } from './providers';
import {
  cancelPaymentLinkRecord,
  createPaymentLinkRecord,
  flowPaymentReference,
  handlePaymentEventJob,
  listPaymentLinks,
  PaymentLinkError,
  reconcilePaymentLink,
  requestPaymentReference,
  sendPaymentLinkMessage,
} from './links';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), flowId = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asViewerA: TenantContext = { accountId: accountA, userId: viewerA, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const scope = { accountId: accountA, role: 'owner' as const };
let owner: pg.Client;
let convA = '';

const agent = { kind: 'agent' as const, userId: agentA, role: 'agent' as const };
const create = (overrides: Partial<Parameters<typeof createPaymentLinkRecord>[0]> = {}) => createPaymentLinkRecord({
  accountId: accountA, actor: agent, amountMinor: 49_900, currency: 'INR', description: 'Order', conversationId: convA,
  referenceId: requestPaymentReference(accountA, agentA, randomUUID()), ...overrides,
});
const linkRow = async (id: string) => (await owner.query('SELECT status,provider_link_id,short_url,paid_at,created_by,reference_id FROM payment_links WHERE id=$1', [id])).rows[0];
let deliveries = 0;
/** What the webhook route does after a verified delivery: one receipt, then the job. */
async function deliver(event: string, link: { provider_link_id: string | null; reference_id: string }, deliveryId = `evt_${seed}_${++deliveries}`) {
  const receipt = await getWorkerPrisma().$transaction((tx) => claimWebhookReceipt(tx, {
    provider: 'razorpay', receiptId: `${accountA}:${deliveryId}`,
    payload: { accountId: accountA, event, paymentLinkId: link.provider_link_id, referenceId: link.reference_id, status: event.split('.')[1] },
  }));
  await withJobScope(scope, () => handlePaymentEventJob(accountA, { receiptId: receipt.id }));
  return receipt.id;
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Razorpay payment links on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Payments test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, viewerA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Pay A',$2),($3,'Pay B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')", [accountA, adminA, agentA, viewerA, accountB, ownerB]);
    const configA = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `63${seed}`, `64${seed}`, encrypt('test-only-token')])).rows[0].id;
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Payer',$4)", [contactA, accountA, adminA, `+9197${seed}`]);
    convA = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status,whatsapp_config_id,assigned_agent_id) VALUES($1,$2,$3,'open',$4,$5) RETURNING id",
      [accountA, adminA, contactA, configA, agentA])).rows[0].id;
    await withTenant(asAdminA, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_AbCdEf123456', keySecret: 'test-only-secret', webhookSecret: 'test-only-hook' }));
    await withTenant(asB, (tx) => savePaymentProvider(tx, accountB, { keyId: 'rzp_test_ZyXwVu654321', keySecret: 'test-only-secret-b' }));
    // start -> pay (payment_link) -> paid: thanks -> done; expired: sorry (end)
    await owner.query(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id) VALUES($1,$2,$3,'Pay','active','manual','{}','start')`, [flowId, accountA, adminA]);
    await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
      ($1,$2,'start','start','{"next_node_key":"pay"}'),
      ($1,$2,'pay','payment_link',$3),
      ($1,$2,'thanks','send_message','{"text":"Thanks, {{vars.payment_status}}","next_node_key":"done"}'),
      ($1,$2,'sorry','end','{}'),
      ($1,$2,'done','end','{}')`, [accountA, flowId,
      JSON.stringify({ amount: '{{vars.total}}', currency: 'INR', message: 'Please pay', paid_next: 'thanks', expired_next: 'sorry' })]);
  });
  beforeEach(() => {
    h.create.mockClear();
    h.fetchByReference.mockClear();
    h.sendText.mockClear();
    h.metaSendText.mockClear();
    h.dispatch.mockClear();
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`razorpay:${accountA}:%`]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, viewerA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('creates one link per reference: a replay returns the stored link without calling Razorpay again', async () => {
    const referenceId = requestPaymentReference(accountA, agentA, randomUUID());
    const first = await create({ referenceId });
    expect(first).toMatchObject({ outcome: 'created', link: { status: 'created', amount_minor: 49_900, currency: 'INR', conversation_id: convA, contact_id: contactA, created_by: agentA } });
    expect(first.link.short_url).toMatch(/^https:\/\/rzp\.io\//);
    const again = await create({ referenceId });
    expect(again).toMatchObject({ outcome: 'existing', link: { id: first.link.id } });
    expect(h.create).toHaveBeenCalledTimes(1);
    // The same reference with another amount is refused rather than reused.
    await expect(create({ referenceId, amountMinor: 1 })).rejects.toMatchObject({ code: 'reference_conflict' });
  });

  it('lets agents create and read links; viewers neither; another workspace sees nothing', async () => {
    await expect(create({ actor: { kind: 'agent', userId: viewerA, role: 'viewer' } })).rejects.toThrow();
    expect(await withTenant(asViewerA, (tx) => listPaymentLinks(tx, accountA))).toEqual([]);
    expect((await withTenant(asAgentA, (tx) => listPaymentLinks(tx, accountA))).length).toBeGreaterThan(0);
    expect(await withTenant(asB, (tx) => listPaymentLinks(tx, accountB))).toEqual([]);
    expect(await withTenant(asB, (tx) => tx.$queryRaw<unknown[]>`SELECT id FROM payment_links`)).toEqual([]);
    // A conversation of another workspace cannot be targeted.
    await expect(createPaymentLinkRecord({ accountId: accountB, actor: { kind: 'agent', userId: ownerB, role: 'owner' }, amountMinor: 100, currency: 'INR',
      conversationId: convA, referenceId: requestPaymentReference(accountB, ownerB, randomUUID()) })).rejects.toMatchObject({ code: 'target_not_found' });
  });

  it('never lets the app role mark a link paid', async () => {
    const { link } = await create();
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`UPDATE payment_links SET status='paid' WHERE id=${link.id}::uuid`)).rejects.toThrow();
    expect((await linkRow(link.id)).status).toBe('created');
  });

  it('keeps an ambiguous create unknown, then reconciles by reference before creating again', async () => {
    h.create.mockResolvedValueOnce({ outcome: 'unknown' });
    const { link, outcome } = await create();
    expect(outcome).toBe('unknown');
    expect(link.status).toBe('unknown');
    expect(h.create).toHaveBeenCalledTimes(1);

    // Razorpay has it after all: adopt it, create nothing.
    const row = await linkRow(link.id);
    h.fetchByReference.mockResolvedValueOnce(h.link(row.reference_id));
    const settled = await reconcilePaymentLink(accountA, link.id);
    expect(settled.link.status).toBe('created');
    expect(h.fetchByReference).toHaveBeenCalledWith(expect.objectContaining({ referenceId: row.reference_id }));
    expect(h.create).toHaveBeenCalledTimes(1);

    // Razorpay has none: created once, with the same reference.
    h.create.mockResolvedValueOnce({ outcome: 'unknown' });
    const second = await create();
    const reference = (await linkRow(second.link.id)).reference_id;
    h.fetchByReference.mockResolvedValueOnce(null);
    const recreated = await reconcilePaymentLink(accountA, second.link.id);
    expect(recreated.link.status).toBe('created');
    expect(h.create).toHaveBeenCalledTimes(3);
    expect(h.create.mock.calls[2][0]).toMatchObject({ referenceId: reference });
  });

  it('marks a refused create failed', async () => {
    h.create.mockResolvedValueOnce({ outcome: 'rejected', reason: 'invalid_request', httpStatus: 400 });
    const { link, outcome } = await create();
    expect(outcome).toBe('rejected');
    expect((await linkRow(link.id)).status).toBe('failed');
  });

  it('applies a verified payment once: link and order paid, agents notified once', async () => {
    const order = (await owner.query(`INSERT INTO orders(account_id,source,contact_id,conversation_id,currency,subtotal_minor,status)
      VALUES($1,'manual',$2,$3,'INR',49900,'awaiting_payment') RETURNING id`, [accountA, contactA, convA])).rows[0].id;
    const { link } = await create({ orderId: order, conversationId: null });
    expect(link.conversation_id).toBe(convA);
    const row = await linkRow(link.id);
    const receipt = await deliver('payment_link.paid', row);
    expect(await linkRow(link.id)).toMatchObject({ status: 'paid' });
    expect((await linkRow(link.id)).paid_at).not.toBeNull();
    expect((await owner.query('SELECT status FROM orders WHERE id=$1', [order])).rows[0].status).toBe('paid');
    const notes = async () => (await owner.query("SELECT user_id,type,conversation_id,body FROM notifications WHERE account_id=$1 AND dedupe_key=$2", [accountA, `payment:${link.id}:paid`])).rows;
    expect(await notes()).toEqual([{ user_id: agentA, type: 'payment_received', conversation_id: convA, body: expect.any(String) }]);
    expect((await owner.query('SELECT status FROM webhook_receipts WHERE id=$1', [receipt])).rows[0].status).toBe('processed');
    // Outbound webhooks after commit: payment_link.paid and order.paid, once each.
    const events = () => h.dispatch.mock.calls.map((c) => [c[1], c[2], c[3]]);
    expect(events()).toEqual([
      [accountA, 'payment_link.paid', expect.objectContaining({ payment_link_id: link.id, reference_id: row.reference_id, amount_paid_minor: 49_900, currency: 'INR', order_id: order, conversation_id: convA })],
      [accountA, 'order.paid', expect.objectContaining({ order_id: order, source: 'manual', status: 'paid', total_minor: 49_900, currency: 'INR', item_count: 0 })],
    ]);

    // A redelivery under another id, then an out-of-order expiry: nothing changes and nothing is emitted again.
    await deliver('payment_link.paid', row);
    await deliver('payment_link.expired', row);
    expect((await linkRow(link.id)).status).toBe('paid');
    expect(await notes()).toHaveLength(1);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('emits payment_link.paid once when a reconcile finds the link paid, and no order.paid for an order already paid', async () => {
    const order = (await owner.query(`INSERT INTO orders(account_id,source,contact_id,conversation_id,currency,subtotal_minor,status)
      VALUES($1,'manual',$2,$3,'INR',49900,'paid') RETURNING id`, [accountA, contactA, convA])).rows[0].id;
    const { link } = await create({ orderId: order });
    const row = await linkRow(link.id);
    h.fetch.mockResolvedValueOnce({ ...h.link(row.reference_id, 'paid'), id: row.provider_link_id });
    expect((await reconcilePaymentLink(accountA, link.id)).link.status).toBe('paid');
    expect(h.dispatch.mock.calls.map((c) => c[2])).toEqual(['payment_link.paid']);
    // Already paid: a later webhook and reconcile emit nothing more.
    await deliver('payment_link.paid', row);
    await reconcilePaymentLink(accountA, link.id);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('sends a link into the conversation only inside the 24-hour window, once per intent', async () => {
    const { link } = await create();
    const send = (intentKey: string) => sendPaymentLinkMessage({ accountId: accountA, userId: agentA, role: 'agent', linkId: link.id, message: 'Pay here', intentKey });
    // No customer message yet (or only an old one): the window is closed and nothing reaches Meta.
    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id,created_at) VALUES($1,$2,'customer','text','hi',$3,now() - interval '25 hours')",
      [accountA, convA, `wamid.old.${seed}`]);
    await expect(send(`pay-send:${randomUUID()}`)).rejects.toMatchObject({ code: 'window_closed' });
    expect(h.metaSendText).not.toHaveBeenCalled();

    await owner.query("INSERT INTO messages(account_id,conversation_id,sender_type,content_type,content_text,message_id) VALUES($1,$2,'customer','text','hi',$3)",
      [accountA, convA, `wamid.recent.${seed}`]);
    const intentKey = `pay-send:${randomUUID()}`;
    const sent = await send(intentKey);
    expect(sent.whatsappMessageId).toMatch(/^wamid\.inbox\./);
    expect(sent.messageId).toEqual(expect.any(String));
    expect(h.metaSendText).toHaveBeenCalledTimes(1);
    expect(h.metaSendText.mock.calls[0][0]).toMatchObject({ phoneNumberId: `63${seed}`, text: `Pay here\n${link.short_url}` });
    const stored = (await owner.query('SELECT sender_type,sender_id,content_text,status FROM messages WHERE account_id=$1 AND message_id=$2', [accountA, sent.whatsappMessageId])).rows;
    expect(stored).toEqual([{ sender_type: 'agent', sender_id: agentA, content_text: `Pay here\n${link.short_url}`, status: 'sent' }]);
    expect((await owner.query('SELECT bot_paused FROM conversations WHERE id=$1', [convA])).rows[0].bot_paused).toBe(true);

    // A replay of the same intent returns the stored result without sending again.
    expect((await send(intentKey)).whatsappMessageId).toBe(sent.whatsappMessageId);
    expect(h.metaSendText).toHaveBeenCalledTimes(1);
    // The send paused the bot; resume it for the flow test below.
    await owner.query('UPDATE conversations SET bot_paused=false WHERE id=$1', [convA]);
  });

  it('refuses a job whose receipt belongs to another workspace', async () => {
    const { link } = await create();
    const row = await linkRow(link.id);
    const receipt = await getWorkerPrisma().$transaction((tx) => claimWebhookReceipt(tx, {
      provider: 'razorpay', receiptId: `${accountA}:evt_${seed}_cross`,
      payload: { accountId: accountA, event: 'payment_link.paid', paymentLinkId: row.provider_link_id, referenceId: row.reference_id, status: 'paid' },
    }));
    await expect(handlePaymentEventJob(accountB, { receiptId: receipt.id })).rejects.toThrow('tenant mismatch');
    expect((await linkRow(link.id)).status).toBe('created');
  });

  it('cancels an unpaid link and refuses to cancel a paid one', async () => {
    const { link } = await create();
    expect((await cancelPaymentLinkRecord(accountA, link.id)).status).toBe('cancelled');
    await expect(cancelPaymentLinkRecord(accountA, link.id)).rejects.toBeInstanceOf(PaymentLinkError);
  });

  it('runs a flow payment step: creates the link once, sends it, and resumes on the paid webhook', async () => {
    const started = await withJobScope(scope, () => startFlowById({ accountId: accountA, userId: adminA, contactId: contactA, conversationId: convA, flowId,
      message: { kind: 'text', text: '', meta_message_id: `manual.${randomUUID()}` } }));
    // A run that fails on its first step is reported as unavailable.
    expect(started).toEqual({ outcome: 'unavailable' });
    const run = (await owner.query("SELECT id,status,current_node_key,transition_seq,vars FROM flow_runs WHERE account_id=$1 AND flow_id=$2 ORDER BY started_at DESC LIMIT 1", [accountA, flowId])).rows[0];
    // vars.total was never set, so the amount is invalid: no link, and no wired failed port ends the run.
    expect(run.status).toBe('failed');
    expect(h.create).not.toHaveBeenCalled();

    await owner.query(`UPDATE flow_nodes SET config=jsonb_set(config,'{amount}','"250"') WHERE flow_id=$1 AND node_key='pay'`, [flowId]);
    await withJobScope(scope, () => startFlowById({ accountId: accountA, userId: adminA, contactId: contactA, conversationId: convA, flowId,
      message: { kind: 'text', text: '', meta_message_id: `manual.${randomUUID()}` } }));
    const waiting = (await owner.query("SELECT id,status,current_node_key,transition_seq,vars FROM flow_runs WHERE account_id=$1 AND flow_id=$2 AND status='active'", [accountA, flowId])).rows[0];
    expect(waiting).toMatchObject({ current_node_key: 'pay', vars: { payment_status: 'created' } });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({ amountMinor: 25_000, referenceId: flowPaymentReference(waiting.id, 'pay', waiting.transition_seq) });
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0][0].text).toBe(`Please pay\n${waiting.vars.payment_link_url}`);

    const link = (await owner.query('SELECT id,provider_link_id,reference_id,flow_run_id,node_key FROM payment_links WHERE flow_run_id=$1', [waiting.id])).rows;
    expect(link).toHaveLength(1);
    await deliver('payment_link.paid', link[0]);
    const done = (await owner.query('SELECT status,vars FROM flow_runs WHERE id=$1', [waiting.id])).rows[0];
    expect(done).toMatchObject({ status: 'completed', vars: { payment_status: 'paid' } });
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(h.sendText.mock.calls[1][0].text).toBe('Thanks, paid');
    // A late duplicate leaves the finished run alone.
    await deliver('payment_link.paid', link[0]);
    expect(h.sendText).toHaveBeenCalledTimes(2);
  });
});
