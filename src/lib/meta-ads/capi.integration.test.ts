import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';

// Meta is the only fake (global fetch): rows, RLS, grants, intents and jobs are real.
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => {}) }));

import { updateOrder } from '@/lib/commerce/orders';
import { applyProviderState } from '@/lib/payments/links';
import { CapiError, handleCapiEventJob, CONVERSIONS_PAGE_SIZE, listConversionEvents, parseEventCursor, queueConversionEvent, queueConversionEventTx, resolveConversionEvent } from './capi';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const adminA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const clicked = randomUUID(), otherWaba = randomUUID(), noClick = randomUUID();
const asAdminA: TenantContext = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgentA: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
const seed = String(Date.now()).slice(-9);
const wabaA = `71${seed}`, wabaOther = `72${seed}`, dataset = `73${seed}`;
const savedEnv = { ...process.env };
let owner: pg.Client;
let n = 0;

const worker = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ accountId: accountA, role: 'owner' }, work, getWorkerPrisma());
const events = async (where = '') => (await owner.query(`SELECT * FROM capi_events WHERE account_id=$1 ${where} ORDER BY created_at`, [accountA])).rows;
const jobsFor = async (eventId: string) => (await owner.query("SELECT payload FROM jobs WHERE tenant_id=$1 AND type='meta.capi_event' AND dedupe_key=$2", [accountA, `capi:${accountA}:${eventId}`])).rows;

async function order(contactId: string, status = 'new', total = 49_900) {
  return (await owner.query("INSERT INTO orders(account_id,source,external_id,contact_id,currency,subtotal_minor,total_minor,status) VALUES($1,'manual',$2,$3,'INR',$4,$4,$5) RETURNING id",
    [accountA, `ord-${seed}-${++n}`, contactId, total, status])).rows[0].id as string;
}
async function link(contactId: string, orderId: string | null, amount = 49_900) {
  return (await owner.query("INSERT INTO payment_links(account_id,provider,provider_link_id,reference_id,amount_minor,currency,contact_id,order_id,status) VALUES($1,'razorpay',$2,$3,$4,'INR',$5,$6,'created') RETURNING id",
    [accountA, `plink_${seed}_${++n}`, `capiref${seed}x${n}xxxxxxxx`, amount, contactId, orderId])).rows[0].id as string;
}
const pay = (linkId: string) => applyProviderState(accountA, linkId, { status: 'paid' }, 'webhook');
const fetchMock = vi.fn<typeof fetch>();

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Conversions API on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    Object.assign(process.env, { META_ADS_ENABLED: 'true', META_APP_ID: '1234567890', META_APP_SECRET_PRIMARY: 'test-only-secret', META_ADS_LOGIN_CONFIG_ID: '987654321' });
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'CAPI test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'CAPI A',$2),($3,'CAPI B',$4)", [accountA, adminA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, adminA, agentA, accountB, ownerB]);
    const numberA = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `74${seed}`, wabaA, encrypt('test-only-token')])).rows[0].id;
    const numberOther = (await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status) VALUES($1,$2,$3,$4,$5,'connected') RETURNING id",
      [accountA, adminA, `75${seed}`, wabaOther, encrypt('test-only-token')])).rows[0].id;
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$4,$5,'Clicked',$6),($2,$4,$5,'Other WABA',$7),($3,$4,$5,'Organic',$8)",
      [clicked, otherWaba, noClick, accountA, adminA, `+9181${seed}`, `+9182${seed}`, `+9183${seed}`]);
    await owner.query(`INSERT INTO ad_referrals(account_id,contact_id,wa_message_id,whatsapp_config_id,source_id,source_type,ctwa_clid) VALUES
      ($1,$2,$4,$6,'120000000001','ad','clid-test-1'),($1,$3,$5,$7,'120000000002','ad','clid-test-2'),($1,$8,$9,$6,'120000000003','ad',NULL)`,
    [accountA, clicked, otherWaba, `wamid.capi.${seed}.1`, `wamid.capi.${seed}.2`, numberA, numberOther, noClick, `wamid.capi.${seed}.3`]);
    await owner.query(`INSERT INTO meta_ad_connections(account_id,connected_by,status,user_token_enc,scopes,capi_enabled,capi_dataset_id,capi_whatsapp_config_id,capi_waba_id)
      VALUES($1,$2,'active',$3,ARRAY['ads_read','whatsapp_business_manage_events'],true,$4,$5,$6)`, [accountA, adminA, encrypt('test-only-user-token'), dataset, numberA, wabaA]);
    vi.stubGlobal('fetch', fetchMock);
  });
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    process.env = savedEnv;
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM outbound_intents WHERE account_id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('queues the Purchase with the payment, once, keyed by the order', async () => {
    const orderId = await order(clicked);
    const linkId = await link(clicked, orderId);
    expect((await pay(linkId))?.becamePaid).toBe(true);
    // A second paid webhook for the same link changes nothing.
    expect((await pay(linkId))?.becamePaid).toBe(false);
    const rows = await events(`AND event_id='order:${orderId}:Purchase'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_name: 'Purchase', source: 'payment_link', status: 'queued', currency: 'INR', contact_id: clicked });
    expect(Number(rows[0].value)).toBe(499);
    expect(await jobsFor(rows[0].event_id)).toEqual([{ payload: { capiEventId: rows[0].id } }]);
  });

  it('lets an agent session queue a manual-order Purchase, and dedupes it against the payment link', async () => {
    const orderId = await order(clicked, 'confirmed', 1_250);
    await updateOrder(asAgentA, orderId, { status: 'paid' });
    const rows = await events(`AND event_id='order:${orderId}:Purchase'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'order', status: 'queued' });
    expect(Number(rows[0].value)).toBe(12.5);
    expect(await jobsFor(rows[0].event_id)).toHaveLength(1);
    // A payment link for that order paid later: same event id, no second row or job.
    await owner.query("UPDATE orders SET status='awaiting_payment' WHERE id=$1", [orderId]);
    await pay(await link(clicked, orderId, 1_250));
    expect(await events(`AND event_id='order:${orderId}:Purchase'`)).toHaveLength(1);
    expect(await jobsFor(rows[0].event_id)).toHaveLength(1);
  });

  it('rolls the event back with the business transaction', async () => {
    const sourceId = randomUUID();
    await expect(worker(async (tx) => {
      expect(await queueConversionEventTx(tx, { accountId: accountA, eventName: 'Purchase', source: 'payment_link', sourceId, contactId: clicked })).toBe(true);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await events(`AND source_id='${sourceId}'`)).toEqual([]);
    expect(await jobsFor(`payment_link:${sourceId}:Purchase`)).toEqual([]);
  });

  it('queues nothing without an attributable click on the dataset WABA, or with the feature off', async () => {
    const q = (contactId: string) => queueConversionEvent(accountA, { eventName: 'QualifiedLead', source: 'flow', sourceId: `${randomUUID()}:n1`, contactId });
    expect(await q(noClick)).toBe(false);
    expect(await q(otherWaba)).toBe(false);
    process.env.META_ADS_ENABLED = 'false';
    expect(await q(clicked)).toBe(false);
    process.env.META_ADS_ENABLED = 'true';
    expect(await q(clicked)).toBe(true);
  });

  it('never breaks the business transaction: a failing enqueue rolls back to its savepoint and returns false', async () => {
    const after = await worker(async (tx) => {
      expect(await queueConversionEventTx(tx, { accountId: accountA, eventName: 'Purchase', source: 'payment_link', sourceId: 'bad id', contactId: clicked })).toBe(false);
      return tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    });
    expect(after).toEqual([{ ok: 1 }]);
    const orderId = await order(clicked);
    await owner.query('UPDATE meta_ad_connections SET capi_dataset_id=NULL WHERE account_id=$1', [accountA]);
    try {
      expect((await pay(await link(clicked, orderId)))?.becamePaid).toBe(true);
      expect(await events(`AND event_id='order:${orderId}:Purchase'`)).toEqual([]);
    } finally {
      await owner.query('UPDATE meta_ad_connections SET capi_dataset_id=$2 WHERE account_id=$1', [accountA, dataset]);
    }
  });

  it('sends a queued event once with the click id and WABA, and marks it sent', async () => {
    const sourceId = `${randomUUID()}:send`;
    await queueConversionEvent(accountA, { eventName: 'LeadSubmitted', source: 'flow', sourceId, contactId: clicked });
    const [row] = await events(`AND source_id='${sourceId}'`);
    await handleCapiEventJob(accountA, { capiEventId: row.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(`/${dataset}/events`);
    expect(String(url)).not.toContain('test-only-user-token');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-only-user-token');
    const body = JSON.parse(String(init?.body));
    expect(body.data[0]).toMatchObject({ event_name: 'LeadSubmitted', event_id: row.event_id, action_source: 'business_messaging',
      messaging_channel: 'whatsapp', user_data: { whatsapp_business_account_id: wabaA, ctwa_clid: 'clid-test-1' } });
    expect((await events(`AND id='${row.id}'`))[0]).toMatchObject({ status: 'sent' });
    await handleCapiEventJob(accountA, { capiEventId: row.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records a rejection as failed without rethrowing, and never re-sends an unknown outcome', async () => {
    const rejected = `${randomUUID()}:rej`, ambiguous = `${randomUUID()}:amb`;
    await queueConversionEvent(accountA, { eventName: 'AddToCart', source: 'flow', sourceId: rejected, contactId: clicked });
    await queueConversionEvent(accountA, { eventName: 'AddToCart', source: 'flow', sourceId: ambiguous, contactId: clicked });
    const [r1] = await events(`AND source_id='${rejected}'`);
    const [r2] = await events(`AND source_id='${ambiguous}'`);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 100, error_subcode: 2804003, message: 'secret detail' } }), { status: 400 }));
    await handleCapiEventJob(accountA, { capiEventId: r1.id });
    expect((await events(`AND id='${r1.id}'`))[0]).toMatchObject({ status: 'failed', last_error_code: '100:2804003' });

    fetchMock.mockRejectedValueOnce(new TypeError('network down'));
    await handleCapiEventJob(accountA, { capiEventId: r2.id });
    expect((await events(`AND id='${r2.id}'`))[0]).toMatchObject({ status: 'unknown' });
    // Forced re-run (as if the row were still queued): the intent stops it before any fetch.
    await owner.query("UPDATE capi_events SET status='queued' WHERE id=$1", [r2.id]);
    await handleCapiEventJob(accountA, { capiEventId: r2.id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await events(`AND id='${r2.id}'`))[0]).toMatchObject({ status: 'unknown' });
  });

  it('skips with a reason when the click came in on another WABA', async () => {
    const sourceId = `${randomUUID()}:waba`;
    await queueConversionEvent(accountA, { eventName: 'ViewContent', source: 'flow', sourceId, contactId: clicked });
    const [row] = await events(`AND source_id='${sourceId}'`);
    const other = (await owner.query('SELECT id FROM ad_referrals WHERE account_id=$1 AND contact_id=$2', [accountA, otherWaba])).rows[0].id;
    await owner.query('UPDATE capi_events SET ad_referral_id=$2 WHERE id=$1', [row.id, other]);
    await handleCapiEventJob(accountA, { capiEventId: row.id });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await events(`AND id='${row.id}'`))[0]).toMatchObject({ status: 'skipped', skip_reason: 'wrong_waba' });
  });

  it('lets only an admin record an unknown outcome, once, with an audit row; the app role cannot set a status', async () => {
    const sourceId = `${randomUUID()}:res`;
    await queueConversionEvent(accountA, { eventName: 'Purchase', source: 'flow', sourceId, contactId: clicked });
    const [row] = await events(`AND source_id='${sourceId}'`);
    await owner.query("UPDATE capi_events SET status='unknown' WHERE id=$1", [row.id]);
    await expect(resolveConversionEvent(asAgentA, row.id, 'confirmed_sent')).rejects.toMatchObject({ code: 'not_open' });
    await expect(withTenant(asAdminA, (tx) => tx.$executeRaw`UPDATE capi_events SET status='sent' WHERE id=${row.id}::uuid`)).rejects.toThrow();
    const done = await resolveConversionEvent(asAdminA, row.id, 'confirmed_sent');
    expect(done).toMatchObject({ id: row.id, status: 'unknown', resolution: 'confirmed_sent' });
    await expect(resolveConversionEvent(asAdminA, row.id, 'confirmed_not_sent')).rejects.toBeInstanceOf(CapiError);
    const audit = (await owner.query("SELECT user_id,metadata FROM audit_logs WHERE account_id=$1 AND action='meta_capi.resolve' AND resource_id=$2", [accountA, row.id])).rows;
    expect(audit).toEqual([{ user_id: adminA, metadata: { resolution: 'confirmed_sent' } }]);
    expect((await listConversionEvents(asAdminA, 'review')).events.map((e) => e.id)).not.toContain(row.id);
  });

  it('keeps events and the click id inside the workspace', async () => {
    expect(await listConversionEvents(asB)).toEqual({ events: [], nextCursor: null });
    await expect(resolveConversionEvent(asB, (await events())[0].id, 'confirmed_sent')).rejects.toMatchObject({ code: 'not_found' });
    const list = (await listConversionEvents(asAdminA)).events;
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain('clid-test');
  });

  it('pages the event log by (created_at, id) without gaps or repeats, inside the workspace', async () => {
    // 205 events, 50 at a time sharing one created_at to the microsecond, so the id breaks ties.
    await owner.query(`INSERT INTO capi_events(account_id,event_id,event_name,source,source_id,status,skip_reason,event_time,created_at)
      SELECT $1, 'page:' || g || ':' || $2, 'ViewContent', 'flow', 'page-' || g || '-' || $2, 'skipped', 'disabled', now(),
        '2026-01-01T00:00:00.123456Z'::timestamptz + make_interval(secs => (g / 50))
      FROM generate_series(1, 205) g`, [accountA, seed]);
    const all = (await owner.query('SELECT id::text AS id FROM capi_events WHERE account_id=$1 ORDER BY created_at DESC, id DESC', [accountA])).rows.map((row) => row.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listConversionEvents(asAdminA, null, cursor ? parseEventCursor(cursor) : null);
      expect(page.events.length).toBeLessThanOrEqual(CONVERSIONS_PAGE_SIZE);
      seen.push(...page.events.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(seen).toEqual(all);
    expect(pages).toBe(Math.ceil(all.length / CONVERSIONS_PAGE_SIZE));
    // Another workspace replaying A's cursor sees nothing of A.
    const first = await listConversionEvents(asAdminA);
    expect(first.nextCursor).not.toBeNull();
    expect((await listConversionEvents(asB, null, parseEventCursor(first.nextCursor))).events).toEqual([]);
  });
});
