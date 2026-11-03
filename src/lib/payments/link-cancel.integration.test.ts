import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { withJobScope } from '@/lib/jobs/scope';
import { encrypt } from '@/lib/whatsapp/encryption';

// Razorpay and Meta are the only fakes: the flow_runs trigger, RLS, jobs and the engine are real.
const h = vi.hoisted(() => {
  let n = 0;
  const link = (referenceId: string, status = 'created', amount = 25_000) => ({
    id: `plink_C${++n}x${Date.now() % 100000}`, shortUrl: `https://rzp.io/l/c${n}`, status, amountMinor: amount, amountPaidMinor: status === 'paid' ? amount : 0,
    currency: 'INR', referenceId, expireBy: null,
  });
  return {
    link,
    create: vi.fn(async (args: { referenceId: string; amountMinor: number }) => ({ outcome: 'created' as const, link: link(args.referenceId, 'created', args.amountMinor) }) as unknown),
    fetch: vi.fn<(args: { id: string }) => Promise<unknown>>(async () => null),
    cancel: vi.fn(async (args: { id: string }) => ({ ...link('x', 'cancelled'), id: args.id }) as unknown),
    sendText: vi.fn(async () => ({ whatsapp_message_id: `wamid.cancel.${++n}` })),
  };
});
vi.mock('@/lib/payments/razorpay', async (orig) => ({
  ...(await orig<typeof import('./razorpay')>()),
  createPaymentLink: h.create,
  fetchPaymentLinkByReference: vi.fn(async () => null),
  fetchPaymentLink: h.fetch,
  cancelPaymentLink: h.cancel,
}));
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.sendText, engineSendMedia: h.sendText, engineSendInteractiveButtons: h.sendText, engineSendInteractiveList: h.sendText,
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

import { databaseAdmin } from '@/lib/flows/admin-client';
import { startFlowById } from '@/lib/flows/engine';
import { checkRunTimeout, markRunTimedOut } from '@/lib/flows/timeout';
import { savePaymentProvider } from './providers';
import { CANCEL_LINK_JOB, handleCancelLinkJob } from './links';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), ownerB = randomUUID();
const contactA = randomUUID(), flowId = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const seed = String(Date.now()).slice(-9);
const scope = { accountId: accountA, role: 'owner' as const };
let owner: pg.Client;
let convA = '';

interface WaitingRun { id: string; last_advanced_at: string; transition_seq: number; link: { id: string; provider_link_id: string } }

/** Starts the flow and returns the run waiting on its payment link. */
async function waitingRun(): Promise<WaitingRun> {
  await withJobScope(scope, () => startFlowById({ accountId: accountA, userId: adminA, contactId: contactA, conversationId: convA, flowId,
    message: { kind: 'text', text: '', meta_message_id: `manual.${randomUUID()}` } }));
  const run = (await owner.query("SELECT id,last_advanced_at,transition_seq FROM flow_runs WHERE account_id=$1 AND flow_id=$2 AND status='active' AND current_node_key='pay'", [accountA, flowId])).rows[0];
  expect(run).toBeTruthy();
  const link = (await owner.query("SELECT id,provider_link_id FROM payment_links WHERE flow_run_id=$1 AND status='created'", [run.id])).rows[0];
  expect(link).toBeTruthy();
  return { id: run.id, last_advanced_at: new Date(run.last_advanced_at).toISOString(), transition_seq: run.transition_seq, link };
}
const cancelJobs = async (linkId: string) => (await owner.query(
  'SELECT type,tenant_id::text AS tenant_id,payload,status FROM jobs WHERE dedupe_key=$1', [`payment-link-cancel:${linkId}`])).rows;
const linkStatus = async (id: string) => (await owner.query('SELECT status FROM payment_links WHERE id=$1', [id])).rows[0].status as string;
/** What a worker does with a claimed job. */
const runJob = (accountId: string, linkId: string) =>
  withJobScope({ accountId, role: 'owner' }, () => handleCancelLinkJob(accountId, { linkId }));
/** Ends a run the way the engine and the inbox do: through the worker role, scoped to the tenant. */
const endViaWorker = (runId: string, status: string) => withJobScope(scope, async () => {
  const { error } = await databaseAdmin().from('flow_runs').update({ status, ended_at: new Date().toISOString(), end_reason: 'test' }).eq('id', runId).eq('status', 'active');
  if (error) throw new Error('end failed');
});

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Cancelling a flow payment link when its run ends unpaid', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    const worker = await getWorkerPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (worker[0].role !== 'bodhinox_worker') throw new Error('Requires constrained test worker credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Cancel test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Cancel A',$2),($3,'Cancel B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'owner')", [accountA, adminA, accountB, ownerB]);
    const configA = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `73${seed}`, `74${seed}`, encrypt('test-only-token')])).rows[0].id;
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Payer',$4)", [contactA, accountA, adminA, `+9198${seed}`]);
    convA = (await owner.query("INSERT INTO conversations(account_id,user_id,contact_id,status,whatsapp_config_id) VALUES($1,$2,$3,'open',$4) RETURNING id",
      [accountA, adminA, contactA, configA])).rows[0].id;
    await withTenant(asAdminA, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_CaNcEl123456', keySecret: 'test-only-secret' }));
    await owner.query(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id) VALUES($1,$2,$3,'Pay','active','manual','{}','start')`, [flowId, accountA, adminA]);
    await owner.query(`INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES
      ($1,$2,'start','start','{"next_node_key":"pay"}'),
      ($1,$2,'pay','payment_link',$3),
      ($1,$2,'done','end','{}')`, [accountA, flowId,
      JSON.stringify({ amount: '250', currency: 'INR', message: 'Please pay', paid_next: 'done', expired_next: 'done' })]);
  });
  beforeEach(() => {
    h.fetch.mockReset();
    h.cancel.mockClear();
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('queues the cancel with the timeout itself, cancels the unpaid link once, and ignores a replay', async () => {
    const run = await waitingRun();
    expect(await cancelJobs(run.link.id)).toEqual([]);
    const now = new Date(Date.parse(run.last_advanced_at) + 400 * 3_600_000);
    const ended = await withJobScope(scope, () => markRunTimedOut(databaseAdmin(), run.id, checkRunTimeout(run.last_advanced_at, null, now), 'test_timeout', now, run));
    expect(ended).toBe(true);
    expect(await cancelJobs(run.link.id)).toEqual([{ type: CANCEL_LINK_JOB, tenant_id: accountA, payload: { linkId: run.link.id }, status: 'pending' }]);

    h.fetch.mockResolvedValueOnce({ ...h.link('x'), id: run.link.provider_link_id });
    await runJob(accountA, run.link.id);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel.mock.calls[0][0]).toMatchObject({ id: run.link.provider_link_id });
    expect(await linkStatus(run.link.id)).toBe('cancelled');
    // The ended run is not resumed by the cancellation.
    expect((await owner.query('SELECT status FROM flow_runs WHERE id=$1', [run.id])).rows[0].status).toBe('timed_out');

    await runJob(accountA, run.link.id);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('never cancels a link Razorpay reports paid by the time the job runs', async () => {
    const run = await waitingRun();
    await endViaWorker(run.id, 'cancelled');
    expect(await cancelJobs(run.link.id)).toHaveLength(1);
    h.fetch.mockResolvedValueOnce({ ...h.link('x', 'paid'), id: run.link.provider_link_id });
    await runJob(accountA, run.link.id);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(await linkStatus(run.link.id)).toBe('paid');
  });

  it('treats a cancel Razorpay refuses because the link was just paid as done', async () => {
    const run = await waitingRun();
    await endViaWorker(run.id, 'handed_off');
    const { RazorpayError } = await import('./razorpay');
    h.fetch
      .mockResolvedValueOnce({ ...h.link('x'), id: run.link.provider_link_id })
      .mockResolvedValueOnce({ ...h.link('x', 'paid'), id: run.link.provider_link_id });
    h.cancel.mockRejectedValueOnce(new RazorpayError('invalid_request', null));
    await expect(runJob(accountA, run.link.id)).resolves.toBeUndefined();
    expect(await linkStatus(run.link.id)).toBe('paid');
  });

  it('queues nothing for a run that ends after its link was paid, and nothing for a run still active', async () => {
    const run = await waitingRun();
    await owner.query("UPDATE payment_links SET status='paid', paid_at=now() WHERE id=$1", [run.link.id]);
    await owner.query("UPDATE flow_runs SET vars=vars || '{\"x\":\"1\"}' WHERE id=$1", [run.id]);
    expect(await cancelJobs(run.link.id)).toEqual([]);
    await endViaWorker(run.id, 'cancelled');
    expect(await cancelJobs(run.link.id)).toEqual([]);
  });

  it('queues the cancel when a member ends the run through the app role (takeover, deactivation)', async () => {
    const run = await waitingRun();
    await withTenant(asAdminA, (tx) => tx.$executeRaw`UPDATE flow_runs SET status='cancelled', ended_at=now(), end_reason='agent_takeover' WHERE id=${run.id}::uuid AND status='active'`);
    expect(await cancelJobs(run.link.id)).toEqual([{ type: CANCEL_LINK_JOB, tenant_id: accountA, payload: { linkId: run.link.id }, status: 'pending' }]);
    h.fetch.mockResolvedValueOnce({ ...h.link('x'), id: run.link.provider_link_id });
    await runJob(accountA, run.link.id);
    expect(await linkStatus(run.link.id)).toBe('cancelled');
  });

  it('rolls the queued cancel back with an ending that rolls back', async () => {
    const run = await waitingRun();
    await expect(withTenant(asAdminA, async (tx) => {
      await tx.$executeRaw`UPDATE flow_runs SET status='cancelled', ended_at=now(), end_reason='test' WHERE id=${run.id}::uuid AND status='active'`;
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await cancelJobs(run.link.id)).toEqual([]);
    expect((await owner.query('SELECT status FROM flow_runs WHERE id=$1', [run.id])).rows[0].status).toBe('active');
    await endViaWorker(run.id, 'cancelled');
    h.fetch.mockResolvedValueOnce({ ...h.link('x'), id: run.link.provider_link_id });
    await runJob(accountA, run.link.id);
  });

  it('retries a provider outage instead of dropping the cancel', async () => {
    const run = await waitingRun();
    await endViaWorker(run.id, 'timed_out');
    const { RazorpayError } = await import('./razorpay');
    h.fetch.mockRejectedValueOnce(new RazorpayError('unknown', null));
    await expect(runJob(accountA, run.link.id)).rejects.toBeTruthy();
    expect(await linkStatus(run.link.id)).toBe('created');
    h.fetch.mockResolvedValueOnce({ ...h.link('x'), id: run.link.provider_link_id });
    await runJob(accountA, run.link.id);
    expect(await linkStatus(run.link.id)).toBe('cancelled');
  });

  it('does nothing for a job naming another workspace\'s link, and rejects a malformed payload', async () => {
    const run = await waitingRun();
    await endViaWorker(run.id, 'cancelled');
    await runJob(accountB, run.link.id);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(await linkStatus(run.link.id)).toBe('created');
    await expect(runJob(accountA, 'not-a-uuid')).rejects.toThrow('Invalid payment link cancel job contract');
  });
});
