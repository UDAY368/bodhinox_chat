// Audit #14/#40: an outbound webhook endpoint is switched off only after sustained failure, says
// why, notifies the owners and admins once, and keeps a bounded delivery log only admins can read.
// Runs record_webhook_attempt() through the worker role and the read paths through the app role.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, type TenantPair } from '@/test/tenancy/fixtures';

const reply = vi.hoisted(() => ({ result: { ok: false, error: 'timeout' } as Record<string, unknown> }));
vi.mock('@/lib/webhooks/ssrf', async (original) => ({
  ...(await original<typeof import('@/lib/webhooks/ssrf')>()),
  isDeliverableUrl: async () => true,
}));
vi.mock('@/lib/webhooks/safe-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/webhooks/safe-fetch')>()),
  safeFetch: async () => reply.result,
}));

const databases = fixtureDatabaseUrls();

describe.skipIf(!databases)('[SEC-03] outbound webhook failure policy and delivery log', () => {
  let pair: TenantPair;
  beforeAll(async () => { pair = await createTenantPair({ label: 'whlog' }); }, 60000);
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);
  beforeEach(async () => {
    reply.result = { ok: false, error: 'timeout' };
    await fixtureOwnerPool().query(
      `UPDATE webhook_endpoints SET is_active=true, failure_count=0, failing_since=NULL, disabled_at=NULL, disabled_reason=NULL
       WHERE id = ANY($1::uuid[])`, [[pair.a.webhookEndpointId, pair.b.webhookEndpointId]]);
    await fixtureOwnerPool().query('DELETE FROM webhook_deliveries WHERE account_id = ANY($1::uuid[])', [[pair.a.accountId, pair.b.accountId]]);
    await fixtureOwnerPool().query("DELETE FROM notifications WHERE type='webhook_disabled' AND account_id = ANY($1::uuid[])", [[pair.a.accountId, pair.b.accountId]]);
  }, 30000);

  const endpoint = async (id: string) => (await fixtureOwnerPool().query(
    `SELECT is_active, failure_count, failing_since IS NOT NULL AS failing, disabled_at IS NOT NULL AS disabled, disabled_reason
     FROM webhook_endpoints WHERE id=$1`, [id])).rows[0];
  const attempt = async (n = 1) => {
    const { deliverQueuedWebhook } = await import('./deliver');
    const { a } = pair;
    return deliverQueuedWebhook(createAdminClient({ accountId: a.accountId, role: 'owner' }), a.accountId,
      { endpointId: a.webhookEndpointId, event: 'message.received', payload: JSON.stringify({ id: `evt-${n}` }) }, n);
  };

  it('keeps an endpoint on through a burst of failures, logs each attempt with codes only, and a success clears the streak', async () => {
    const { a, b } = pair;
    const bBefore = await endpoint(b.webhookEndpointId);
    // Far more failed attempts than the old threshold of 15, all within minutes.
    for (let n = 1; n <= 20; n++) await expect(attempt(n)).rejects.toThrow('Webhook delivery failed');
    expect(await endpoint(a.webhookEndpointId)).toMatchObject({ is_active: true, failure_count: 20, failing: true, disabled: false });
    const log = (await fixtureOwnerPool().query(
      'SELECT event, delivery_id, attempt, outcome, http_status, error FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY attempt', [a.webhookEndpointId])).rows;
    expect(log).toHaveLength(20);
    expect(log[0]).toEqual({ event: 'message.received', delivery_id: 'evt-1', attempt: 1, outcome: 'failed', http_status: null, error: 'timeout' });
    reply.result = { ok: true, status: 204 };
    await attempt(21);
    expect(await endpoint(a.webhookEndpointId)).toMatchObject({ is_active: true, failure_count: 0, failing: false, disabled: false });
    const last = (await fixtureOwnerPool().query(
      'SELECT outcome, http_status, error FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY created_at DESC, attempt DESC LIMIT 1', [a.webhookEndpointId])).rows[0];
    expect(last).toEqual({ outcome: 'delivered', http_status: 204, error: null });
    // Nothing reached B.
    expect(await endpoint(b.webhookEndpointId)).toEqual(bBefore);
    expect((await fixtureOwnerPool().query('SELECT count(*)::int AS n FROM webhook_deliveries WHERE account_id=$1', [b.accountId])).rows[0].n).toBe(0);
  }, 60000);

  it('switches off only after a day of failure, records why, and notifies the owners and admins once', async () => {
    const { a } = pair;
    for (let n = 1; n <= 15; n++) await expect(attempt(n)).rejects.toThrow();
    await fixtureOwnerPool().query("UPDATE webhook_endpoints SET failing_since=now()-interval '25 hours' WHERE id=$1", [a.webhookEndpointId]);
    await expect(attempt(16)).rejects.toThrow();
    expect(await endpoint(a.webhookEndpointId)).toMatchObject({ is_active: false, disabled: true, disabled_reason: 'sustained_failure' });
    const notices = (await fixtureOwnerPool().query(
      "SELECT user_id::text AS user_id, link FROM notifications WHERE account_id=$1 AND type='webhook_disabled' ORDER BY user_id", [a.accountId])).rows;
    expect(notices.map((n) => n.user_id).sort()).toEqual([a.users.owner.userId, a.users.admin.userId].sort());
    expect(notices.every((n) => n.link === '/settings?tab=api')).toBe(true);
    // Later queued attempts find the endpoint off: no request, no second notice.
    await attempt(17);
    expect((await fixtureOwnerPool().query("SELECT count(*)::int AS n FROM notifications WHERE account_id=$1 AND type='webhook_disabled'", [a.accountId])).rows[0].n).toBe(2);
    // Switching it back on clears the reason and the streak.
    const { updateWebhook } = await import('./manage');
    const updated = await updateWebhook(createAdminClient({ accountId: a.accountId, userId: a.users.admin.userId, role: 'admin' }),
      a.accountId, a.webhookEndpointId, { is_active: true });
    expect(updated).toMatchObject({ is_active: true, failure_count: 0, disabled_at: null, disabled_reason: null });
    expect(await endpoint(a.webhookEndpointId)).toMatchObject({ failing: false, disabled: false });
  }, 60000);

  it('trims the log to the newest 100 attempts per endpoint and drops attempts older than 30 days', async () => {
    const { a } = pair;
    await fixtureOwnerPool().query(
      `INSERT INTO webhook_deliveries(account_id,endpoint_id,event,attempt,outcome,created_at)
       SELECT $1, $2, 'message.received', 1, 'failed', now() - interval '31 days'`, [a.accountId, a.webhookEndpointId]);
    await fixtureOwnerPool().query(
      `INSERT INTO webhook_deliveries(account_id,endpoint_id,event,attempt,outcome,created_at)
       SELECT $1, $2, 'message.received', 1, 'delivered', now() - make_interval(secs => g) FROM generate_series(1,105) g`,
      [a.accountId, a.webhookEndpointId]);
    reply.result = { ok: true, status: 200 };
    await attempt(1);
    const rows = (await fixtureOwnerPool().query(
      "SELECT count(*)::int AS n, min(created_at) > now() - interval '30 days' AS fresh FROM webhook_deliveries WHERE endpoint_id=$1", [a.webhookEndpointId])).rows[0];
    expect(rows).toEqual({ n: 100, fresh: true });
  }, 60000);

  it('lets only admins and owners of the workspace read the log', async () => {
    const { a, b } = pair;
    reply.result = { ok: true, status: 200 };
    await attempt(1);
    const { listWebhookDeliveries } = await import('./manage');
    expect(await listWebhookDeliveries(a.users.admin.context, a.webhookEndpointId)).toHaveLength(1);
    expect(await listWebhookDeliveries(a.users.owner.context, a.webhookEndpointId)).toHaveLength(1);
    // RLS: an agent of the same workspace reads no rows.
    expect(await listWebhookDeliveries(a.users.agent.context, a.webhookEndpointId)).toEqual([]);
    // Another workspace's admin cannot even see the endpoint.
    expect(await listWebhookDeliveries(b.users.admin.context, a.webhookEndpointId)).toBeNull();
    const direct = await withTenant(b.users.owner.context, (tx) =>
      tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id=${a.webhookEndpointId}::uuid`);
    expect(direct[0].n).toBe(0);
    // The app role can neither write the log nor call the worker function.
    await expect(withTenant(a.users.owner.context, (tx) => tx.$executeRaw`DELETE FROM webhook_deliveries`)).rejects.toThrow();
    await expect(withTenant(a.users.owner.context, (tx) => tx.$queryRaw`SELECT record_webhook_attempt(${a.webhookEndpointId}::uuid,'x',NULL,1,false,0,'x',1,0)`)).rejects.toThrow();
  }, 60000);
});
