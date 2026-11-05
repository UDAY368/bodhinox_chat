import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureDatabaseUrls } from '@/test/tenancy/fixtures';
import { permutations } from '@/test/fixtures/providers/drain';
import { fixtureBody, loadProviderFixture } from '@/test/fixtures/providers';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { POST as webhook } from '@/app/api/integrations/woocommerce/webhook/[storeId]/route';
import { createWooStore } from './stores';

// Duplicate and reordered WooCommerce deliveries (design 1.3, P2), replaying the
// docs-derived fixture payloads (design 1.4) through the real signed route.
const db = fixtureDatabaseUrls();
if (db) {
  process.env.DATABASE_URL = db.app;
  process.env.WORKER_DATABASE_URL = db.worker;
}

const accountA = randomUUID(), adminA = randomUUID();
const seed = String(Date.now()).slice(-8);
let owner: pg.Client;
let storeId = '';
let secret = '';
let hook = 0;

const bodies = {
  created: fixtureBody(loadProviderFixture('woocommerce', 'webhook-order-created')),
  paid: fixtureBody(loadProviderFixture('woocommerce', 'webhook-order-updated-paid')),
  completed: fixtureBody(loadProviderFixture('woocommerce', 'webhook-order-updated-completed')),
};
const topics = { created: 'order.created', paid: 'order.updated', completed: 'order.updated' } as const;
const phoneFor = (orderId: number) => `98000${String(orderId % 100000).padStart(5, '0')}`;

async function deliver(name: keyof typeof bodies, orderId: number, deliveryId = `${seed}${++hook}`): Promise<{ status: number; outcome: string }> {
  const raw = JSON.stringify({ ...bodies[name], id: orderId, number: String(orderId), billing: { ...(bodies[name].billing as object), phone: phoneFor(orderId) } });
  const res = await webhook(new Request(`http://localhost/api/integrations/woocommerce/webhook/${storeId}`, { method: 'POST', body: raw, headers: {
    'x-wc-webhook-topic': topics[name], 'x-wc-webhook-delivery-id': deliveryId,
    'x-wc-webhook-signature': createHmac('sha256', secret).update(raw).digest('base64'),
  } }), { params: Promise.resolve({ storeId }) });
  return { status: res.status, outcome: ((await res.json()) as { status?: string }).status ?? '' };
}

async function snapshot(orderId: number) {
  return {
    events: (await owner.query("SELECT event,status,reason FROM commerce_events WHERE account_id=$1 AND source='woocommerce' AND external_id=$2 ORDER BY event", [accountA, String(orderId)])).rows,
    contacts: Number((await owner.query('SELECT count(*) AS n FROM contacts WHERE account_id=$1 AND phone_normalized=$2', [accountA, `91${phoneFor(orderId)}`])).rows[0].n),
  };
}

describe.skipIf(!db)('[CAP-01] [COM-04] WooCommerce webhooks: duplicates and reordering on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: db!.owner });
    await owner.connect();
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Woo ordering','test-only-hash')", [adminA, `${adminA}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Woo ordering',$2)", [accountA, adminA]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [accountA, adminA]);
    const created = await withTenant({ accountId: accountA, userId: adminA, role: 'admin' }, (tx) => createWooStore(tx, accountA, { storeUrl: `https://ord-${seed}.example.com` }));
    storeId = created.store.id;
    secret = created.webhookSecret;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      if (storeId) await owner.query('DELETE FROM webhook_receipts WHERE dedupe_key LIKE $1', [`woocommerce:${storeId}:%`]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [adminA]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('replays the fixture payloads and ends in the in-order state for every order of created, paid and completed', async () => {
    let baseline: Awaited<ReturnType<typeof snapshot>> | null = null;
    let orderId = 71000;
    for (const order of permutations(['created', 'paid', 'completed'] as const)) {
      orderId++;
      for (const name of order) expect(await deliver(name, orderId)).toMatchObject({ status: 200 });
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

  it('records one delivery once under five concurrent copies, and one event per order under concurrent redeliveries', async () => {
    const orderId = 72001;
    const same = await Promise.all(Array.from({ length: 5 }, () => deliver('paid', orderId, `${seed}999`)));
    expect(same.every((r) => r.status === 200)).toBe(true);
    expect(same.filter((r) => r.outcome === 'duplicate')).toHaveLength(4);
    const again = await Promise.all(Array.from({ length: 5 }, () => deliver('paid', orderId)));
    expect(again.every((r) => r.status === 200)).toBe(true);
    expect(await snapshot(orderId)).toMatchObject({ events: [{ event: 'order_paid' }], contacts: 1 });
  });
});
