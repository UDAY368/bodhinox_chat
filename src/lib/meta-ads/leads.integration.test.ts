import { randomInt, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The Page token is stored encrypted; the key must exist before encryption.ts loads.
vi.hoisted(() => { process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32); });
const graph = vi.hoisted(() => ({ getLead: vi.fn() }));
vi.mock('./graph', async (orig) => ({ ...(await orig<typeof import('./graph')>()), getLead: graph.getLead }));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { encrypt } from '@/lib/whatsapp/encryption';
import { deleteLead, exportLeadsCsv, handleLeadgenFetchJob, handlePageWebhookJob, listLeads, parseLeadsFilter, persistPageWebhook, storeFetchedLeadTx } from './leads';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), ownerB = randomUUID();
const connA = randomUUID(), connB = randomUUID();
const pageA = String(randomInt(1e9, 2e9)), pageB = String(randomInt(2e9, 3e9));
const lead1 = String(randomInt(1e9, 2e9)), lead2 = String(randomInt(2e9, 3e9));
const existing = randomUUID();
const LEAD_SCOPES = ['leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads'];
const env = { META_ADS_ENABLED: 'true', META_APP_ID: '1', META_APP_SECRET: 'test-secret', META_ADS_LOGIN_CONFIG_ID: '2' };
const saved: Record<string, string | undefined> = {};
let owner: pg.Client;

const change = (page: string, leadgen: string) => ({ field: 'leadgen', value: { leadgen_id: leadgen, page_id: page, form_id: '555', ad_id: '777' } });
const pagePayload = (...changes: unknown[]) => ({ object: 'page', entry: [{ id: pageA, changes }] });

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('Meta lead ads on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Leads test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Leads A',$2),($3,'Leads B',$4)", [accountA, admin, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, admin, agent, accountB, ownerB]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,name,phone) VALUES($1,$2,$3,'Asha','919876543210')", [existing, accountA, admin]);
    await owner.query(`INSERT INTO meta_ad_connections(id,account_id,connected_by,status,page_id,page_token_enc,scopes) VALUES
      ($1,$2,$3,'active',$4,$5,$6),($7,$8,$9,'active',$10,$5,$6)`,
    [connA, accountA, admin, pageA, encrypt('PAGE-TOKEN'), LEAD_SCOPES, connB, accountB, ownerB, pageB]);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[]) OR (type='meta.page_webhook' AND payload->>'receiptId' IN (SELECT id::text FROM webhook_receipts WHERE provider='meta_page' AND payload::text LIKE $2))",
        [[accountA, accountB], `%${pageA}%`]);
      await owner.query("DELETE FROM webhook_receipts WHERE provider='meta_page' AND payload::text LIKE $1", [`%${pageA}%`]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores a delivery once, records one lead per leadgen id, and drops unknown Pages', async () => {
    const payload = pagePayload(change(pageA, lead1), change(pageA, lead1), change('42', lead2));
    const raw = JSON.stringify(payload);
    const first = await persistPageWebhook(raw, payload);
    expect(await persistPageWebhook(raw, payload)).toBe(first);
    const jobs = (await owner.query("SELECT tenant_id FROM jobs WHERE type='meta.page_webhook' AND payload->>'receiptId'=$1", [first])).rows;
    expect(jobs).toEqual([{ tenant_id: null }]);

    await handlePageWebhookJob(payload);
    await handlePageWebhookJob(payload); // a redelivered job
    const leads = (await owner.query('SELECT account_id, leadgen_id, status FROM meta_leads WHERE leadgen_id = ANY($1)', [[lead1, lead2]])).rows;
    expect(leads).toEqual([{ account_id: accountA, leadgen_id: lead1, status: 'pending' }]);
    const fetches = (await owner.query("SELECT tenant_id, payload FROM jobs WHERE type='meta.leadgen_fetch' AND tenant_id=$1", [accountA])).rows;
    expect(fetches).toEqual([{ tenant_id: accountA, payload: { accountId: accountA, leadgenId: lead1 } }]);
  });

  it('fetches the answers and matches the existing contact by number', async () => {
    graph.getLead.mockResolvedValueOnce({
      id: lead1, createdTime: '2026-11-03T10:00:00+0000', formId: '555', adId: '777', adsetId: null, campaignId: null,
      adName: 'Diwali', campaignName: null,
      fieldData: [{ name: 'full_name', values: ['Asha'] }, { name: 'phone_number', values: ['+91 98765 43210'] }],
    });
    await handleLeadgenFetchJob(accountA, { leadgenId: lead1 });
    expect(graph.getLead).toHaveBeenCalledWith(lead1, 'PAGE-TOKEN');
    const row = (await owner.query('SELECT status, contact_id, ad_name FROM meta_leads WHERE account_id=$1 AND leadgen_id=$2', [accountA, lead1])).rows[0];
    expect(row).toEqual({ status: 'fetched', contact_id: existing, ad_name: 'Diwali' });
    expect((await owner.query('SELECT opted_out_at FROM contacts WHERE id=$1', [existing])).rows[0].opted_out_at).toBeNull();
    // Already fetched: no second network call.
    await handleLeadgenFetchJob(accountA, { leadgenId: lead1 });
    expect(graph.getLead).toHaveBeenCalledTimes(1);
  });

  it('shows leads only to their workspace, masks numbers for masked agents, and refuses app writes', async () => {
    await owner.query("INSERT INTO meta_leads(account_id,connection_id,leadgen_id,status) VALUES($1,$2,$3,'pending')", [accountB, connB, lead2]);
    const mine = await listLeads({ accountId: accountA, userId: admin, role: 'admin' }, {});
    expect(mine.leads.map((l) => l.leadgenId)).toEqual([lead1]);
    expect(mine.leads[0].answers).toContainEqual({ name: 'phone_number', values: ['+91 98765 43210'] });
    expect((await listLeads({ accountId: accountB, userId: ownerB, role: 'owner' }, {})).leads.map((l) => l.leadgenId)).toEqual([lead2]);

    await owner.query('UPDATE account_memberships SET mask_phone_numbers=true WHERE account_id=$1 AND user_id=$2', [accountA, agent]);
    const masked = await listLeads({ accountId: accountA, userId: agent, role: 'agent' }, {});
    expect(JSON.stringify(masked.leads)).not.toContain('98765 43210');

    await expect(withTenant({ accountId: accountA, userId: admin, role: 'admin' }, (tx) =>
      tx.$executeRaw`INSERT INTO meta_leads(account_id,connection_id,leadgen_id) VALUES(${accountA}::uuid,${connA}::uuid,'1')`)).rejects.toThrow();
    await expect(withTenant({ accountId: accountA, userId: admin, role: 'admin' }, (tx) =>
      tx.$executeRaw`DELETE FROM meta_leads WHERE account_id=${accountA}::uuid`)).rejects.toThrow();
  });

  it('exports CSV with an audit row holding the count only, and erases a lead with an audit row', async () => {
    const { csv, rows } = await exportLeadsCsv({ accountId: accountA, userId: admin, role: 'admin' }, {});
    expect(rows).toBe(1);
    expect(csv).toContain('"phone_number"');
    const audit = (await owner.query("SELECT metadata FROM audit_logs WHERE account_id=$1 AND action='meta_leads.export'", [accountA])).rows;
    expect(audit).toEqual([{ metadata: { rows: 1 } }]);

    const id = (await owner.query('SELECT id FROM meta_leads WHERE account_id=$1 AND leadgen_id=$2', [accountA, lead1])).rows[0].id;
    // Another workspace cannot erase it.
    expect(await deleteLead({ accountId: accountB, userId: ownerB }, id)).toBe(false);
    expect(await deleteLead({ accountId: accountA, userId: admin }, id)).toBe(true);
    // A content-free tombstone stays so nothing re-imports the lead.
    expect((await owner.query('SELECT status, field_data, contact_id, ad_name FROM meta_leads WHERE id=$1', [id])).rows)
      .toEqual([{ status: 'erased', field_data: [], contact_id: null, ad_name: null }]);
    expect((await listLeads({ accountId: accountA, userId: admin, role: 'admin' }, {})).leads).toEqual([]);
    expect(await deleteLead({ accountId: accountA, userId: admin }, id)).toBe(false);

    // A webhook redelivery queues nothing, and a backfill re-read neither restores answers nor touches contacts.
    const jobsBefore = (await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='meta.leadgen_fetch' AND tenant_id=$1", [accountA])).rows[0].n;
    const contactsBefore = (await owner.query('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA])).rows[0].n;
    await owner.query("DELETE FROM jobs WHERE type='meta.leadgen_fetch' AND tenant_id=$1", [accountA]);
    await handlePageWebhookJob(pagePayload(change(pageA, lead1)));
    expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE type='meta.leadgen_fetch' AND tenant_id=$1", [accountA])).rows[0].n).toBe(0);
    expect(jobsBefore).toBeGreaterThan(0);
    await owner.query('DELETE FROM contacts WHERE id=$1', [existing]);
    await withTenant({ accountId: accountA, role: 'owner' }, (tx) => storeFetchedLeadTx(tx, accountA, connA, pageA, {
      id: lead1, createdTime: null, formId: '555', adId: '777', adsetId: null, campaignId: null, adName: 'Diwali', campaignName: null,
      fieldData: [{ name: 'phone_number', values: ['+91 98765 43210'] }],
    }), getWorkerPrisma());
    expect((await owner.query('SELECT status, field_data FROM meta_leads WHERE id=$1', [id])).rows).toEqual([{ status: 'erased', field_data: [] }]);
    expect((await owner.query('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1', [accountA])).rows[0].n).toBe(contactsBefore - 1);
    const erased = (await owner.query("SELECT resource_id, metadata FROM audit_logs WHERE account_id=$1 AND action='meta_leads.delete'", [accountA])).rows;
    expect(erased).toEqual([{ resource_id: id, metadata: {} }]);
  });

  it('pages through leads stored in one transaction (same microsecond received_at) without skipping any', async () => {
    const ids = Array.from({ length: 53 }, (_, i) => String(3_000_000_000 + randomInt(1e6) * 100 + i));
    await owner.query('BEGIN');
    await owner.query("INSERT INTO meta_leads(account_id,connection_id,leadgen_id,status) SELECT $1,$2,x,'fetched' FROM unnest($3::text[]) x", [accountB, connB, ids]);
    await owner.query('COMMIT');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const filter = parseLeadsFilter(new URLSearchParams(cursor ? { cursor } : {}));
      const page = await listLeads({ accountId: accountB, userId: ownerB, role: 'owner' }, filter);
      seen.push(...page.leads.map((l) => l.leadgenId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.filter((x) => ids.includes(x)).sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});
