import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureDatabaseUrls } from '@/test/tenancy/fixtures';
import { drainJobs } from '@/test/fixtures/providers/drain';

// Concurrent duplicate Meta lead deliveries (design 1.3, P3): the Graph API is the
// only fake; receipts, jobs, the job dispatcher, contact matching and RLS are real.
vi.hoisted(() => { process.env.ENCRYPTION_KEY ??= 'ab'.repeat(32); });
const graph = vi.hoisted(() => ({ getLead: vi.fn() }));
vi.mock('./graph', async (orig) => ({ ...(await orig<typeof import('./graph')>()), getLead: graph.getLead }));

import { disconnectDatabases } from '@/lib/db/prisma';
import { encrypt } from '@/lib/whatsapp/encryption';
import { persistPageWebhook } from './leads';

const db = fixtureDatabaseUrls();
if (db) {
  process.env.DATABASE_URL = db.app;
  process.env.WORKER_DATABASE_URL = db.worker;
}
const env = { META_ADS_ENABLED: 'true', META_APP_ID: '1', META_APP_SECRET: 'test-secret', META_ADS_LOGIN_CONFIG_ID: '2' };
const saved: Record<string, string | undefined> = {};

const accountA = randomUUID(), admin = randomUUID(), conn = randomUUID();
const page = String(randomInt(3e9, 4e9)), leadgen = String(randomInt(3e9, 4e9));
const phone = `9198000${String(randomInt(0, 99999)).padStart(5, '0')}`;
const receipts: string[] = [];
let owner: pg.Client;

describe.skipIf(!db)('[ADS-04] Meta lead ads: concurrent duplicate deliveries on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
    owner = new pg.Client({ connectionString: db!.owner });
    await owner.connect();
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Leads ordering','test-only-hash')", [admin, `${admin}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Leads ordering',$2)", [accountA, admin]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [accountA, admin]);
    await owner.query(`INSERT INTO meta_ad_connections(id,account_id,connected_by,status,page_id,page_token_enc,scopes) VALUES($1,$2,$3,'active',$4,$5,$6)`,
      [conn, accountA, admin, page, encrypt('PAGE-TOKEN'), ['leads_retrieval', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_ads']]);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    if (owner) {
      await owner.query("DELETE FROM jobs WHERE tenant_id=$1 OR (type='meta.page_webhook' AND payload->>'receiptId' = ANY($2::text[]))", [accountA, receipts]);
      await owner.query('DELETE FROM webhook_receipts WHERE id::text = ANY($1::text[])', [receipts]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [admin]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('turns five concurrent deliveries of one leadgen id, run concurrently, into one lead, one fetch and one contact', async () => {
    graph.getLead.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { id: leadgen, createdTime: '2026-11-05T10:00:00+0000', formId: '555', adId: '777', adsetId: null, campaignId: null, adName: 'Fixture', campaignName: null,
        fieldData: [{ name: 'full_name', values: ['Lead Test'] }, { name: 'phone_number', values: [`+${phone}`] }] };
    });
    // Five distinct deliveries (Meta retries with a new body time) naming the same lead, stored at once.
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => {
      const payload = { object: 'page', entry: [{ id: page, time: 1762336800 + i, changes: [{ field: 'leadgen', value: { leadgen_id: leadgen, page_id: page, form_id: '555', ad_id: '777' } }] }] };
      return persistPageWebhook(JSON.stringify(payload), payload);
    }));
    receipts.push(...new Set(ids));
    expect(new Set(ids).size).toBe(5);
    await drainJobs(owner, { types: ['meta.page_webhook'], payloadIds: { key: 'receiptId', values: receipts } }, { concurrent: true });
    // Each delivery may queue a fetch; they share one dedupe key.
    expect(Number((await owner.query("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND type='meta.leadgen_fetch'", [accountA])).rows[0].n)).toBe(1);
    await drainJobs(owner, { tenantId: accountA, types: ['meta.leadgen_fetch'] }, { concurrent: true });
    const leads = (await owner.query('SELECT status, contact_id FROM meta_leads WHERE account_id=$1 AND leadgen_id=$2', [accountA, leadgen])).rows;
    expect(leads).toHaveLength(1);
    expect(leads[0].status).toBe('fetched');
    expect(Number((await owner.query('SELECT count(*) AS n FROM contacts WHERE account_id=$1 AND phone_normalized=$2', [accountA, phone])).rows[0].n)).toBe(1);
    expect(graph.getLead).toHaveBeenCalledTimes(1);
  });
});
