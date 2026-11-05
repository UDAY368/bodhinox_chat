import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureDatabaseUrls } from '@/test/tenancy/fixtures';
import { permutations } from '@/test/fixtures/providers/drain';
import { fixtureBody, loadProviderFixture } from '@/test/fixtures/providers';

// Duplicate and reordered Shopify deliveries (design 1.3, P2), replaying the
// docs-derived fixture payloads (design 1.4) through the real signed route.
// Shopify records synchronously in the route, so there is no job to drain.
const SECRET = 'test-only-shopify-ordering';
Object.assign(process.env, { SHOPIFY_API_KEY: 'test-only-key', SHOPIFY_API_SECRET: SECRET });

import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { POST as webhook } from '@/app/api/integrations/shopify/webhooks/route';
import { saveShopifyStore } from './store';

const db = fixtureDatabaseUrls();
if (db) {
  process.env.DATABASE_URL = db.app;
  process.env.WORKER_DATABASE_URL = db.worker;
}

const accountA = randomUUID(), adminA = randomUUID();
const seed = String(Date.now()).slice(-9);
const shop = `it-ord-${seed}.myshopify.com`;
let owner: pg.Client;
let hook = 0;

const bodies = {
  create: fixtureBody(loadProviderFixture('shopify', 'webhook-orders-create')),
  paid: fixtureBody(loadProviderFixture('shopify', 'webhook-orders-paid')),
  fulfilled: fixtureBody(loadProviderFixture('shopify', 'webhook-orders-fulfilled')),
};
const topics = { create: 'orders/create', paid: 'orders/paid', fulfilled: 'orders/fulfilled' } as const;

async function deliver(name: keyof typeof bodies, orderId: number, webhookId = `ord-${seed}-${++hook}`): Promise<{ status: number; outcome: string }> {
  // One order per scenario; the phone is in the reserved test range.
  const raw = JSON.stringify({ ...bodies[name], id: orderId, name: `#${orderId}`, phone: `+9198000${String(orderId % 100000).padStart(5, '0')}` });
  const res = await webhook(new Request('http://localhost/api/integrations/shopify/webhooks', { method: 'POST', body: raw, headers: {
    'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'), 'x-shopify-topic': topics[name],
    'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': webhookId,
  } }));
  return { status: res.status, outcome: res.ok ? ((await res.json()) as { status: string }).status : '' };
}

async function snapshot(orderId: number) {
  return {
    events: (await owner.query("SELECT event,status,reason FROM commerce_events WHERE account_id=$1 AND source='shopify' AND external_id=$2 ORDER BY event", [accountA, String(orderId)])).rows,
    contacts: Number((await owner.query('SELECT count(*) AS n FROM contacts WHERE account_id=$1 AND phone_normalized=$2', [accountA, `9198000${String(orderId % 100000).padStart(5, '0')}`])).rows[0].n),
    receipts: Number((await owner.query("SELECT count(*) AS n FROM webhook_receipts WHERE dedupe_key LIKE $1 AND payload->>'external_id'=$2", [`shopify:ord-${seed}-%`, String(orderId)])).rows[0].n),
  };
}

describe.skipIf(!db)('[CAP-01] [COM-04] Shopify webhooks: duplicates and reordering on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: db!.owner });
    await owner.connect();
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Shopify ordering','test-only-hash')", [adminA, `${adminA}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Shopify ordering',$2)", [accountA, adminA]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [accountA, adminA]);
    await withTenant({ accountId: accountA, userId: adminA, role: 'admin' }, (tx) => saveShopifyStore(tx, accountA, { shop, accessToken: 'test-only-token', scopes: ['read_orders'] }));
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`shopify:ord-${seed}-%`]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [adminA]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('replays the fixture payloads and ends in the in-order state for every order of create, paid and fulfilled', async () => {
    let baseline: Awaited<ReturnType<typeof snapshot>> | null = null;
    let orderId = 41000;
    for (const order of permutations(['create', 'paid', 'fulfilled'] as const)) {
      orderId++;
      for (const name of order) expect(await deliver(name, orderId)).toEqual({ status: 200, outcome: 'recorded' });
      const state = await snapshot(orderId);
      if (!baseline) {
        baseline = state;
        expect(state.events.map((e) => e.event)).toEqual(['order_created', 'order_fulfilled', 'order_paid']);
        expect(state.contacts).toBe(1);
      } else {
        expect(state, `delivery order ${order.join(' -> ')}`).toEqual(baseline);
      }
    }
  });

  it('records one event for five concurrent copies of one delivery and five concurrent redeliveries', async () => {
    const orderId = 42001;
    const same = await Promise.all(Array.from({ length: 5 }, () => deliver('paid', orderId, `ord-${seed}-same`)));
    expect(same.every((r) => r.status === 200)).toBe(true);
    expect(same.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    expect(same.filter((r) => r.outcome === 'duplicate')).toHaveLength(4);
    const redelivered = await Promise.all(Array.from({ length: 5 }, () => deliver('paid', orderId)));
    expect(redelivered.every((r) => r.status === 200)).toBe(true);
    expect(await snapshot(orderId)).toMatchObject({ events: [{ event: 'order_paid' }], contacts: 1, receipts: 6 });
    // Exactly one send job could be queued for the one event.
    const jobs = Number((await owner.query("SELECT count(*) AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key IN (SELECT 'commerce:' || id FROM commerce_events WHERE account_id=$1 AND external_id=$2)", [accountA, String(orderId)])).rows[0].n);
    expect(jobs).toBeLessThanOrEqual(1);
  });

  it('refuses a payload signed with another secret', async () => {
    const raw = JSON.stringify(bodies.paid);
    const res = await webhook(new Request('http://localhost/api/integrations/shopify/webhooks', { method: 'POST', body: raw, headers: {
      'x-shopify-hmac-sha256': createHmac('sha256', 'another-secret').update(raw).digest('base64'), 'x-shopify-topic': 'orders/paid',
      'x-shopify-shop-domain': shop, 'x-shopify-webhook-id': `ord-${seed}-forged`,
    } }));
    expect(res.status).toBe(401);
  });
});
