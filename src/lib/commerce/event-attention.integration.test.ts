import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { handleCommerceEventJob, recordCommerceEvent, type RecordCommerceEventInput } from './event-rules';
import { listAttentionEvents, resolveCommerceEvent } from './event-attention';

const meta = vi.hoisted(() => ({ send: vi.fn(async () => ({ whatsapp_message_id: 'wamid.attention' })) }));
vi.mock('@/lib/automations/meta-send', () => ({ engineSendTemplate: meta.send }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;

const record = (input: Partial<RecordCommerceEventInput> & { dedupeKey: string }) =>
  withTenant({ accountId: accountA, role: 'owner' }, (tx) => recordCommerceEvent(tx, {
    accountId: accountA, source: 'shopify', event: 'order_paid', payload: {}, ...input,
  }), getWorkerPrisma());
const eventRow = async (id: string) =>
  (await owner.query('SELECT status,reason,resolution,resolved_by,marketing_consent,created_contact_id,contact_id FROM commerce_events WHERE id=$1', [id])).rows[0];
const setRule = (template: string, enabled = true) =>
  owner.query("UPDATE commerce_event_rules SET template_name=$2,enabled=$3 WHERE account_id=$1 AND source='shopify' AND event='order_paid'", [accountA, template, enabled]);
const addIntent = (eventId: string, status: string) =>
  owner.query('INSERT INTO outbound_intents(account_id,idempotency_key,status) VALUES($1,$2,$3)', [accountA, `${accountA}:commerce:${eventId}`, status]);
const phone = (n: number) => `+9197${seed}${n}`;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('commerce event consent snapshot and reconciliation', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Attention test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Attention A',$2),($3,'Attention B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, adminA, agentA, accountB, ownerB]);
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected')",
      [accountA, adminA, `71${seed}`, `72${seed}`, encrypt('test-only-token')]);
    await owner.query(`INSERT INTO message_templates(account_id,user_id,name,body_text,status,category,language) VALUES
      ($1,$2,'order_update','Order paid','APPROVED','Utility','en'),
      ($1,$2,'promo','Big sale','APPROVED','Marketing','en')`, [accountA, adminA]);
    await owner.query(`INSERT INTO commerce_event_rules(account_id,source,event,enabled,template_name,template_language,delay_minutes,variable_map)
      VALUES($1,'shopify','order_paid',true,'order_update','en',0,'{}')`, [accountA]);
  });
  beforeEach(async () => {
    meta.send.mockClear();
    await setRule('order_update');
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('keeps the store consent so a template turned MARKETING during the delay is not sent (R9)', async () => {
    // A customer first seen through this event, no store consent reported.
    const fresh = await record({ dedupeKey: `r9-new-${seed}`, phone: phone(1) });
    expect(fresh.status).toBe('scheduled');
    expect(await eventRow(fresh.eventId)).toMatchObject({ marketing_consent: null, created_contact_id: fresh.contactId });
    // An existing contact whose store said no to marketing.
    await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Existing')", [accountA, adminA, phone(2).slice(1)]);
    const refused = await record({ dedupeKey: `r9-refused-${seed}`, phone: phone(2), marketingConsent: false });
    expect(refused.status).toBe('scheduled');
    expect(await eventRow(refused.eventId)).toMatchObject({ marketing_consent: false, created_contact_id: null });

    await setRule('promo');
    await handleCommerceEventJob(accountA, { eventId: fresh.eventId });
    await handleCommerceEventJob(accountA, { eventId: refused.eventId });
    expect(await eventRow(fresh.eventId)).toMatchObject({ status: 'skipped', reason: 'no_marketing_consent' });
    expect(await eventRow(refused.eventId)).toMatchObject({ status: 'skipped', reason: 'no_marketing_consent' });
    expect(meta.send).not.toHaveBeenCalled();

    // With the store's consent, the marketing template still goes.
    const agreed = await record({ dedupeKey: `r9-agreed-${seed}`, phone: phone(3), marketingConsent: true });
    await handleCommerceEventJob(accountA, { eventId: agreed.eventId });
    expect(await eventRow(agreed.eventId)).toMatchObject({ status: 'sent', marketing_consent: true });
    expect(meta.send).toHaveBeenCalledTimes(1);
  });

  it('lets an existing intent decide a retried job instead of re-planning it as skipped (R13)', async () => {
    const delivered = await record({ dedupeKey: `r13-accepted-${seed}`, phone: phone(4) });
    const inFlight = await record({ dedupeKey: `r13-dispatching-${seed}`, phone: phone(5) });
    const rejected = await record({ dedupeKey: `r13-failed-${seed}`, phone: phone(6) });
    await addIntent(delivered.eventId, 'accepted');
    await addIntent(inFlight.eventId, 'dispatching');
    await addIntent(rejected.eventId, 'failed');
    // The admin turns the rule off while the crashed attempts wait for their retry.
    await setRule('order_update', false);

    await handleCommerceEventJob(accountA, { eventId: delivered.eventId });
    expect(await eventRow(delivered.eventId)).toMatchObject({ status: 'sent', reason: null });
    await expect(handleCommerceEventJob(accountA, { eventId: inFlight.eventId })).rejects.toMatchObject({ name: 'UncertainDispatchError' });
    expect(await eventRow(inFlight.eventId)).toMatchObject({ status: 'scheduled', reason: 'outcome_unknown' });
    await handleCommerceEventJob(accountA, { eventId: rejected.eventId });
    expect(await eventRow(rejected.eventId)).toMatchObject({ status: 'failed', reason: 'provider_rejected' });
    expect(meta.send).not.toHaveBeenCalled();
  });

  it('lists events needing attention for the workspace only, with a fixed projection (R8)', async () => {
    const unknown = await record({ dedupeKey: `r8-unknown-${seed}`, phone: phone(7), name: 'Ravi', payload: { order_number: '#77', secret_note: 'do not show' } });
    meta.send.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(handleCommerceEventJob(accountA, { eventId: unknown.eventId })).rejects.toMatchObject({ name: 'UncertainDispatchError' });

    const { events } = await listAttentionEvents(asAdminA);
    const row = events.find((e) => e.id === unknown.eventId);
    expect(row).toMatchObject({
      source: 'shopify', event: 'order_paid', status: 'scheduled', reason: 'outcome_unknown',
      order_number: '#77', contact_id: unknown.contactId, contact_name: 'Ravi', template_name: 'order_update',
    });
    expect(row?.conversation_id).toBeTruthy();
    expect(Object.keys(row!).sort()).toEqual(['contact_id', 'contact_name', 'conversation_id', 'created_at', 'event', 'id',
      'order_number', 'reason', 'scheduled_for', 'source', 'status', 'template_name']);
    expect(JSON.stringify(events)).not.toContain('do not show');
    // Settled events are not listed; other workspaces see nothing.
    expect(events.every((e) => e.status === 'failed' || e.reason === 'outcome_unknown')).toBe(true);
    expect((await listAttentionEvents(asB)).events).toEqual([]);
  });

  it('records an admin resolution once, never re-sends, and keeps it from agents and other workspaces (R8)', async () => {
    const unknown = await record({ dedupeKey: `r8-resolve-${seed}`, phone: phone(8) });
    meta.send.mockRejectedValueOnce(new Error('timeout'));
    await expect(handleCommerceEventJob(accountA, { eventId: unknown.eventId })).rejects.toMatchObject({ name: 'UncertainDispatchError' });
    meta.send.mockClear();

    await expect(resolveCommerceEvent(asB, unknown.eventId, 'sent')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(resolveCommerceEvent(asAgentA, unknown.eventId, 'sent')).rejects.toMatchObject({ code: 'not_open', status: 409 });
    // The app role may touch only the resolution columns, as itself.
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`UPDATE commerce_events SET payload='{}' WHERE id=${unknown.eventId}::uuid`)).rejects.toThrow();
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`
      UPDATE commerce_events SET status='sent',resolution='sent',resolved_at=now(),resolved_by=${agentA}::uuid WHERE id=${unknown.eventId}::uuid`)).rejects.toThrow();
    // Status and resolution must agree.
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`
      UPDATE commerce_events SET status='skipped',resolution='sent',resolved_at=now(),resolved_by=${adminA}::uuid WHERE id=${unknown.eventId}::uuid`)).rejects.toThrow();

    const resolved = await resolveCommerceEvent(asAdminA, unknown.eventId, 'not_sent');
    expect(resolved).toMatchObject({ id: unknown.eventId, status: 'failed' });
    expect(await eventRow(unknown.eventId)).toMatchObject({ status: 'failed', reason: 'outcome_unknown', resolution: 'not_sent', resolved_by: adminA });
    await expect(resolveCommerceEvent(asAdminA, unknown.eventId, 'sent')).rejects.toMatchObject({ code: 'not_open', status: 409 });
    expect((await listAttentionEvents(asAdminA)).events.some((e) => e.id === unknown.eventId)).toBe(false);

    // A redelivered job neither sends nor overwrites the admin's decision.
    await handleCommerceEventJob(accountA, { eventId: unknown.eventId });
    expect(meta.send).not.toHaveBeenCalled();
    expect(await eventRow(unknown.eventId)).toMatchObject({ status: 'failed', resolution: 'not_sent' });
    const intent = (await owner.query('SELECT status FROM outbound_intents WHERE idempotency_key=$1', [`${accountA}:commerce:${unknown.eventId}`])).rows;
    expect(intent).toEqual([{ status: 'unknown' }]);
  });
});
