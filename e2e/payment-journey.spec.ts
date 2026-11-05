import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { razorpaySignature, removeWorkspaces, seedWorkspace, withDb, type Workspace } from './journeys';

// Tenant Razorpay webhooks through the real route, up to the durable boundary:
// verified with the workspace's own webhook secret, recorded once and queued
// before the 200. Settlement (the job re-reads the link from Razorpay with the
// workspace's keys) needs the provider, so it is covered with a stubbed
// provider in the payments integration tests, not here. Status: simulated.
const run = randomBytes(4).toString('hex');
let a: Workspace & { secret: string };
let b: Workspace & { secret: string };

async function seedRazorpay(label: string) {
  const workspace = await seedWorkspace(label);
  const secret = `e2e-whsec-${randomBytes(12).toString('hex')}`;
  // Imported only now: the module reads ENCRYPTION_KEY when it loads, and testDatabase loaded the test env above.
  const { encrypt } = await import('../src/lib/whatsapp/encryption');
  await withDb((db) => db.query(`INSERT INTO payment_providers(account_id,provider,mode,key_id,key_secret_enc,webhook_secret_enc)
    VALUES($1,'razorpay','test',$2,$3,$4)`, [workspace.accountId, `rzp_test_e2e${run}`, encrypt('e2e-only-key-secret'), encrypt(secret)]));
  return { ...workspace, secret };
}

const linkPaid = (eventId: string) => JSON.stringify({
  entity: 'event', event: 'payment_link.paid', account_id: 'acc_E2E', contains: ['payment_link', 'payment'],
  payload: {
    payment_link: { entity: { id: `plink_E2E${run}`, reference_id: `e2e-${eventId}`, status: 'paid', amount: 49900, amount_paid: 49900, currency: 'INR' } },
    payment: { entity: { id: `pay_E2E${run}`, amount: 49900, currency: 'INR', status: 'captured' } },
  },
});
const receipts = (accountId: string) => withDb(async (db) => (await db.query(
  "SELECT id::text, payload FROM webhook_receipts WHERE provider='razorpay' AND payload->>'accountId'=$1", [accountId])).rows as { id: string; payload: Record<string, unknown> }[]);
const jobsFor = (accountId: string) => withDb(async (db) => (await db.query(
  "SELECT dedupe_key FROM jobs WHERE tenant_id=$1 AND dedupe_key LIKE 'payment-event:%'", [accountId])).rows);

test.describe('[PAY-02] tenant Razorpay webhooks (simulated settlement)', () => {
  test.beforeAll(async () => {
    a = await seedRazorpay('pay-a');
    b = await seedRazorpay('pay-b');
  });
  test.afterAll(async () => {
    await withDb((db) => db.query("DELETE FROM webhook_receipts WHERE provider='razorpay' AND payload->>'accountId' = ANY($1::text[])", [[a.accountId, b.accountId]]));
    await removeWorkspaces([a.accountId, b.accountId], [a.owner.id, b.owner.id]);
  });

  test('a signed payment_link.paid is recorded and queued once, with ids and amounts only', async ({ request }) => {
    const eventId = `evt_E2E${run}`;
    const raw = linkPaid(eventId);
    const post = () => request.post(`/api/payments/razorpay/webhook/${a.accountId}`, {
      data: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': razorpaySignature(raw, a.secret), 'x-razorpay-event-id': eventId },
    });
    expect((await post()).status()).toBe(200);
    expect((await post()).status()).toBe(200); // Razorpay redelivers: nothing new.
    const stored = await receipts(a.accountId);
    expect(stored).toHaveLength(1);
    expect(stored[0].payload).toMatchObject({ accountId: a.accountId, event: 'payment_link.paid', paymentLinkId: `plink_E2E${run}` });
    expect(JSON.stringify(stored[0].payload)).not.toMatch(/email|contact|phone/i);
    expect(await jobsFor(a.accountId)).toEqual([{ dedupe_key: `payment-event:${stored[0].id}` }]);
  });

  test("a wrong signature, another workspace's secret or an unknown account is refused and stores nothing", async ({ request }) => {
    const raw = linkPaid(`evt_E2E_bad${run}`);
    const attempts: [string, string][] = [
      [a.accountId, razorpaySignature(raw, 'not-the-secret')],
      // Signed with A's secret, sent to B's endpoint.
      [b.accountId, razorpaySignature(raw, a.secret)],
      ['00000000-0000-4000-8000-000000000000', razorpaySignature(raw, a.secret)],
      ['not-a-uuid', razorpaySignature(raw, a.secret)],
    ];
    for (const [account, signature] of attempts) {
      const response = await request.post(`/api/payments/razorpay/webhook/${account}`, {
        data: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      });
      expect(response.status()).toBe(401);
    }
    expect(await receipts(b.accountId)).toEqual([]);
    expect(await jobsFor(b.accountId)).toEqual([]);
  });

  test('a payment.captured event (no link id) is acknowledged and ignored', async ({ request }) => {
    const raw = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: `pay_E2Eign${run}`, amount: 100, currency: 'INR' } } } });
    const before = (await receipts(b.accountId)).length;
    const response = await request.post(`/api/payments/razorpay/webhook/${b.accountId}`, {
      data: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': razorpaySignature(raw, b.secret) },
    });
    expect(response.status()).toBe(200);
    expect((await receipts(b.accountId)).length).toBe(before);
    expect(await jobsFor(b.accountId)).toEqual([]);
  });
});
