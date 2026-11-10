// Campaign "Retry failed" and reconciliation of uncertain sends on PostgreSQL
// (audit 2026-11-10, findings 11 and 12): retry generations, the tenant-scoped
// reconcile action, its audit row, and that only an intent staff marked not
// sent is ever sent again.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { broadcastIntentKey, UNCERTAIN_SEND_MESSAGE } from '@/lib/whatsapp/broadcast-core';
import { listUncertainRecipients, reconcileBroadcastRecipients, RECONCILED_NOT_SENT_MESSAGE } from './reconcile';
import { prepareFailedRetry } from './schedule';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), B = randomUUID(), admin = randomUUID(), outsider = randomUUID();
const campaign = randomUUID(), campaignB = randomUUID();
// r-webhook: Meta accepted, a status webhook failed it. r-unc / r-legacy: uncertain (flag / old text only).
// r-reject: Meta refused (4xx). r-sent: delivered.
const rWebhook = randomUUID(), rUnc = randomUUID(), rLegacy = randomUUID(), rReject = randomUUID(), rSent = randomUUID(), rB = randomUUID();
const ctxA: TenantContext = { accountId: A, userId: admin, role: 'admin' };
const ctxB: TenantContext = { accountId: B, userId: outsider, role: 'owner' };
const PHONE = '14155550100';
let owner: pg.Client;
const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);
const recipientRow = async (id: string) => (await q(
  'SELECT status, error_message, whatsapp_message_id, retry_generation, outcome_uncertain_at FROM broadcast_recipients WHERE id=$1', [id])).rows[0];
const intent = async (key: string) => (await q('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${A}:${key}`])).rows[0]?.status;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('campaign retry and reconciliation on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await q("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Reconcile', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, outsider]]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Reconcile A',$2),($3,'Reconcile B',$4)", [A, admin, B, outsider]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($3,$4,'owner')", [A, admin, B, outsider]);
    await q("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$2,$3,'A','promo','failed'),($4,$5,$6,'B','promo','sent')",
      [campaign, A, admin, campaignB, B, outsider]);
    await q(`INSERT INTO broadcast_recipients(id,account_id,broadcast_id,status,error_message,whatsapp_message_id,outcome_uncertain_at,created_at) VALUES
      ($1,$7,$8,'failed','Message undeliverable','wamid.OLD',NULL,now()-interval '5 min'),
      ($2,$7,$8,'failed',$10,NULL,now(),now()-interval '4 min'),
      ($3,$7,$8,'failed',$10,NULL,NULL,now()-interval '3 min'),
      ($4,$7,$8,'failed','Template does not exist',NULL,NULL,now()-interval '2 min'),
      ($5,$7,$8,'sent',NULL,'wamid.SENT',NULL,now()-interval '1 min'),
      ($6,$9,$11,'failed',$10,NULL,now(),now())`,
      [rWebhook, rUnc, rLegacy, rReject, rSent, rB, A, campaign, B, UNCERTAIN_SEND_MESSAGE, campaignB]);
    await q(`INSERT INTO outbound_intents(account_id,idempotency_key,status,result) VALUES
      ($1,$2,'accepted','{"messageId":"wamid.OLD"}'::jsonb),($1,$3,'unknown',NULL),($1,$4,'dispatching',NULL),($1,$5,'failed',NULL)`,
      [A, `${A}:${broadcastIntentKey(campaign, rWebhook, PHONE)}`, `${A}:${broadcastIntentKey(campaign, rUnc, PHONE)}`,
        `${A}:${broadcastIntentKey(campaign, rLegacy, PHONE)}`, `${A}:${broadcastIntentKey(campaign, rReject, PHONE)}`]);
  });
  afterAll(async () => {
    if (owner) {
      await q('DELETE FROM outbound_intents WHERE account_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM audit_logs WHERE account_id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[A, B]]);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('gives a row Meta failed after accepting it one new retry generation per Retry failed request', async () => {
    const retryId = randomUUID();
    expect(await prepareFailedRetry(A, campaign, retryId)).toBe(1);
    expect(await recipientRow(rWebhook)).toMatchObject({ retry_generation: 1, whatsapp_message_id: null, status: 'failed' });
    // The same request again (a requeued or retried pass) bumps nothing.
    expect(await prepareFailedRetry(A, campaign, retryId)).toBe(0);
    expect((await recipientRow(rWebhook)).retry_generation).toBe(1);
    // Uncertain and refused rows are untouched.
    expect((await recipientRow(rUnc)).retry_generation).toBe(0);
    expect((await recipientRow(rReject)).retry_generation).toBe(0);

    // The new generation is a new intent: a real send, while the old key still replays.
    const send = vi.fn(async () => ({ messageId: 'wamid.NEW' }));
    expect(await dispatchOnce(A, broadcastIntentKey(campaign, rWebhook, PHONE, 1), send, { retryRejected: true })).toEqual({ messageId: 'wamid.NEW' });
    expect(await dispatchOnce(A, broadcastIntentKey(campaign, rWebhook, PHONE), send, { retryRejected: true })).toEqual({ messageId: 'wamid.OLD' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('lists flagged and legacy uncertain recipients to the workspace only', async () => {
    const listed = await withTenant(ctxA, (tx) => listUncertainRecipients(tx, A, campaign));
    expect(listed.total).toBe(2);
    expect(listed.recipients.map((r) => r.id)).toEqual([rUnc, rLegacy]);
    // Another workspace cannot see the campaign, even by id.
    await expect(withTenant(ctxB, (tx) => listUncertainRecipients(tx, B, campaign))).rejects.toMatchObject({ reason: 'not_found' });
    await expect(withTenant(ctxB, (tx) => listUncertainRecipients(tx, A, campaign))).rejects.toThrow();
  });

  it('marks a send staff confirmed as sent, never resends it, and audits the decision', async () => {
    const result = await withTenant(ctxA, (tx) => reconcileBroadcastRecipients(tx, {
      accountId: A, userId: admin, broadcastId: campaign, recipientIds: [rUnc, rSent, rB], resolution: 'sent',
    }));
    // rSent was never uncertain and rB belongs to another workspace: neither is touched.
    expect(result).toEqual({ resolved: 1 });
    expect(await recipientRow(rUnc)).toMatchObject({ status: 'sent', error_message: null, outcome_uncertain_at: null });
    expect(await intent(broadcastIntentKey(campaign, rUnc, PHONE))).toBe('accepted');
    expect((await q('SELECT status FROM broadcast_recipients WHERE id=$1', [rB])).rows[0].status).toBe('failed');
    // The all-failed campaign now has a sent recipient.
    expect((await q('SELECT status FROM broadcasts WHERE id=$1', [campaign])).rows[0].status).toBe('sent');
    const audit = (await q("SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='campaigns.recipients_reconciled'", [A])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: admin, metadata: { resolution: 'sent', count: 1, recipient_ids: [rUnc] } });

    // A repeated request changes nothing, and the next dispatch replays instead of sending.
    expect(await withTenant(ctxA, (tx) => reconcileBroadcastRecipients(tx, {
      accountId: A, userId: admin, broadcastId: campaign, recipientIds: [rUnc], resolution: 'not_sent',
    }))).toEqual({ resolved: 0 });
    const send = vi.fn(async () => ({ messageId: 'x' }));
    await dispatchOnce(A, broadcastIntentKey(campaign, rUnc, PHONE), send, { retryRejected: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('turns a send staff marked not sent into an ordinary failure that the next retry sends once', async () => {
    const key = broadcastIntentKey(campaign, rLegacy, PHONE);
    const send = vi.fn(async () => ({ messageId: 'wamid.RETRY' }));
    // Before reconciliation the open intent blocks every send.
    await expect(dispatchOnce(A, key, send, { retryRejected: true })).rejects.toBeInstanceOf(UncertainDispatchError);

    expect(await withTenant(ctxA, (tx) => reconcileBroadcastRecipients(tx, {
      accountId: A, userId: admin, broadcastId: campaign, recipientIds: [rLegacy], resolution: 'not_sent',
    }))).toEqual({ resolved: 1 });
    expect(await recipientRow(rLegacy)).toMatchObject({ status: 'failed', error_message: RECONCILED_NOT_SENT_MESSAGE, outcome_uncertain_at: null });
    expect(await intent(key)).toBe('failed');
    expect((await withTenant(ctxA, (tx) => listUncertainRecipients(tx, A, campaign))).total).toBe(0);

    expect(await dispatchOnce(A, key, send, { retryRejected: true })).toEqual({ messageId: 'wamid.RETRY' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never reconciles another workspace\'s campaign', async () => {
    await expect(withTenant(ctxB, (tx) => reconcileBroadcastRecipients(tx, {
      accountId: B, userId: outsider, broadcastId: campaign, recipientIds: [rLegacy], resolution: 'sent',
    }))).rejects.toMatchObject({ reason: 'not_found' });
  });
});
