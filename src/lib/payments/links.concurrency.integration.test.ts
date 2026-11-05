import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureDatabaseUrls } from '@/test/tenancy/fixtures';

// Concurrent payment-link creation for one order (design 1.5, T3). Razorpay is the
// only fake; the one-live-link rule, the order row lock and RLS are real.
const h = vi.hoisted(() => {
  let n = 0;
  return {
    create: vi.fn(async (args: { referenceId: string; amountMinor: number; currency: string }) => {
      // A provider round trip, so concurrent callers overlap.
      await new Promise((r) => setTimeout(r, 25));
      return { outcome: 'created' as const, link: { id: `plink_C${++n}x${Date.now() % 100000}`, shortUrl: `https://rzp.io/l/c${n}`, status: 'created',
        amountMinor: args.amountMinor, amountPaidMinor: 0, currency: args.currency, referenceId: args.referenceId, expireBy: null, payments: [] } };
    }),
  };
});
vi.mock('@/lib/payments/razorpay', async (orig) => ({
  ...(await orig<typeof import('./razorpay')>()),
  createPaymentLink: h.create,
  fetchPaymentLinkByReference: vi.fn(async () => null),
}));

import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { savePaymentProvider } from './providers';
import { createPaymentLinkRecord, PaymentLinkError } from './links';

const db = fixtureDatabaseUrls();
if (db) {
  process.env.DATABASE_URL = db.app;
  process.env.WORKER_DATABASE_URL = db.worker;
}

const accountA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), agentB = randomUUID();
let owner: pg.Client;

const newOrder = async () => (await owner.query(`INSERT INTO orders(account_id,source,currency,subtotal_minor,total_minor,tax_inclusive,priced_at,status)
  VALUES($1,'manual','INR',25000,25000,true,now(),'awaiting_payment') RETURNING id`, [accountA])).rows[0].id as string;
const create = (orderId: string, userId: string, referenceId = `co_${randomUUID().replace(/-/g, '')}`) => createPaymentLinkRecord({
  accountId: accountA, actor: { kind: 'agent', userId, role: 'agent' }, amountMinor: 25000, currency: 'INR', orderId, referenceId,
  expireBy: new Date(Date.now() + 60 * 60_000),
});

describe.skipIf(!db)('[PAY-01] payment links: concurrent creation for one order on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: db!.owner });
    await owner.connect();
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Link race', 'test-only-hash' FROM unnest($1::uuid[]) x", [[adminA, agentA, agentB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Link race',$2)", [accountA, adminA]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'agent')", [accountA, adminA, agentA, agentB]);
    await withTenant({ accountId: accountA, userId: adminA, role: 'admin' }, (tx) => savePaymentProvider(tx, accountA, { keyId: 'rzp_test_RaceKey000001', keySecret: 'test-only-secret', webhookSecret: 'test-only-hook' }));
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [accountA]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [accountA]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [[adminA, agentA, agentB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('creates one live link when agents click at once, and refuses the rest with link_exists', async () => {
    const order = await newOrder();
    const calls = h.create.mock.calls.length;
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => create(order, i % 2 ? agentA : agentB)));
    const created = results.filter((r) => r.status === 'fulfilled');
    expect(created).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(PaymentLinkError);
    expect(results.filter((r) => r.status === 'rejected').map((r) => ((r as PromiseRejectedResult).reason as PaymentLinkError).code)).toEqual(Array(5).fill('link_exists'));
    expect(h.create.mock.calls.length - calls).toBe(1);
    expect((await owner.query('SELECT status FROM payment_links WHERE order_id=$1', [order])).rows).toEqual([{ status: 'created' }]);
  });

  it('returns the same link for five concurrent replays of one request', async () => {
    const order = await newOrder();
    const reference = `co_${randomUUID().replace(/-/g, '')}`;
    const calls = h.create.mock.calls.length;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => create(order, agentA, reference)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof create>>> => r.status === 'fulfilled').map((r) => r.value);
    // A replay that finds the first create still in flight may be told it is busy; none makes a second link.
    for (const r of results) if (r.status === 'rejected') expect((r.reason as PaymentLinkError).code).toBe('busy');
    expect(new Set(ok.map((r) => r.link.id)).size).toBe(1);
    expect(ok.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(h.create.mock.calls.length - calls).toBe(1);
    expect(Number((await owner.query('SELECT count(*) AS n FROM payment_links WHERE order_id=$1', [order])).rows[0].n)).toBe(1);
  });
});
