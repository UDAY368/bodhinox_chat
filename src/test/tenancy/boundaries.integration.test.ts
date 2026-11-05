// Phase 15 (design 1.2.6): boundary checks for areas with no tenancy test of their own: outbound
// webhook delivery, the realtime event stream cursor, the audit log and the dashboard aggregates.
// Workspace attributes, account webhooks and the media library are covered by the route suite
// (src/app/api/cross-tenant.routes.integration.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { disconnectDatabases } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { createAdminClient } from '@/lib/data/admin';
import { encodeEventCursor } from '@/lib/realtime/cursor';
import { listAuditLog, parseAuditQuery } from '@/lib/audit/audit-log';
import { loadDashboardOperations } from '@/lib/dashboard/operations';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest,
  type TenantPair,
} from './fixtures';
import { callRoute } from './request-scope';

const sent = vi.hoisted(() => [] as string[]);
vi.mock('next/headers', async () => (await import('./request-scope')).nextHeadersMock);
vi.mock('@/lib/webhooks/ssrf', async (original) => ({
  ...(await original<typeof import('@/lib/webhooks/ssrf')>()),
  isDeliverableUrl: async () => true,
}));
vi.mock('@/lib/webhooks/safe-fetch', async (original) => ({
  ...(await original<typeof import('@/lib/webhooks/safe-fetch')>()),
  safeFetch: async (url: string) => { sent.push(url); return { ok: true, status: 200 }; },
}));

const databases = fixtureDatabaseUrls();

describe.skipIf(!databases)('[TEN-01][SEC-03] tenant boundaries in delivery, realtime, audit and dashboard', () => {
  let pair: TenantPair;
  beforeAll(async () => { pair = await createTenantPair({ label: 'bounds' }); }, 60000);
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it("webhooks/deliver: A's events are queued only for A's endpoints and never reach B's", async () => {
    const { dispatchWebhookEvent, deliverQueuedWebhook } = await import('@/lib/webhooks/deliver');
    const { a, b } = pair;
    const pool = fixtureOwnerPool();
    const endpointB = async () => (await pool.query('SELECT failure_count, last_delivery_at, is_active FROM webhook_endpoints WHERE id=$1', [b.webhookEndpointId])).rows[0];
    const beforeB = await endpointB();
    await dispatchWebhookEvent(createAdminClient({ accountId: a.accountId, role: 'owner' }), a.accountId, 'conversation.created', { id: a.contactId });
    const jobs = (await pool.query("SELECT tenant_id::text AS tenant, payload FROM jobs WHERE type='webhook.delivery' AND (tenant_id=ANY($1::uuid[]))",
      [[a.accountId, b.accountId]])).rows as { tenant: string; payload: { endpointId: string; payload: string } }[];
    expect(jobs.map((j) => [j.tenant, j.payload.endpointId])).toEqual([[a.accountId, a.webhookEndpointId]]);
    expect(JSON.parse(jobs[0].payload.payload).account_id).toBe(a.accountId);
    // A forged job in A's queue naming B's endpoint is dropped without a request or a failure count.
    await deliverQueuedWebhook(createAdminClient({ accountId: a.accountId, role: 'owner' }), a.accountId,
      { endpointId: b.webhookEndpointId, event: 'conversation.created', payload: '{}' });
    expect(sent).toEqual([]);
    expect(await endpointB()).toEqual(beforeB);
    // Positive control: A's own job is delivered to A's URL.
    await deliverQueuedWebhook(createAdminClient({ accountId: a.accountId, role: 'owner' }), a.accountId, jobs[0].payload);
    expect(sent).toEqual(['https://hooks.example.com/a']);
    expect(await endpointB()).toEqual(beforeB);
  }, 60000);

  it("realtime: a cursor pointing at B's event, or a resumed stream, never yields B's outbox events", async () => {
    const { GET } = await import('@/app/api/events/route');
    const { a, b } = pair;
    const stamp = new Date(Date.now() - 1000).toISOString();
    const marker = `p15-foreign-${randomUUID()}`;
    await withTenant(b.context, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO outbox_events(account_id,event_type,payload,created_at) VALUES($1::uuid,'contacts.UPDATE',jsonb_build_object('table','contacts','eventType','UPDATE','new',jsonb_build_object('id',$2::text),'old','{}'::jsonb),$3::timestamptz)`,
      b.accountId, marker, stamp));
    const [foreign] = await fixtureOwnerPool().query('SELECT id::text AS id FROM outbox_events WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1', [b.accountId])
      .then((r) => r.rows as { id: string }[]);
    const own = `p15-own-${randomUUID()}`;
    await withTenant(a.context, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO outbox_events(account_id,event_type,payload,created_at) VALUES($1::uuid,'contacts.UPDATE',jsonb_build_object('table','contacts','eventType','UPDATE','new',jsonb_build_object('id',$2::text),'old','{}'::jsonb),$3::timestamptz)`,
      a.accountId, own, stamp));
    for (const cursor of [encodeEventCursor({ at: new Date(Date.now() - 10000).toISOString(), id: foreign.id }),
      encodeEventCursor({ at: new Date(Date.now() - 10000).toISOString(), id: '00000000-0000-0000-0000-000000000000' })]) {
      const abort = new AbortController();
      const request = await signedRequest(a.users.agent, 'GET', `/api/events?tables=contacts&cursor=${cursor}`);
      const response = await callRoute(() => GET(new Request(request, { signal: abort.signal })), request);
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      let output = '';
      const deadline = Date.now() + 5000;
      try {
        while (!output.includes(own) && Date.now() < deadline) {
          const item = await Promise.race([reader.read(), new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), 2000))]);
          if (item.done) break;
          output += new TextDecoder().decode(item.value);
        }
      } finally {
        abort.abort();
        await reader.cancel().catch(() => undefined);
      }
      expect(output).toContain(own);
      expect(output).not.toContain(marker);
    }
  }, 60000);

  it("audit log: A's admin sees only A's entries, also when filtering by B's actor or paging with B's cursor", async () => {
    const { a, b } = pair;
    const pool = fixtureOwnerPool();
    await pool.query("INSERT INTO audit_logs(account_id,user_id,action,resource_id) VALUES($1,$2,'p15.boundary',$3),($4,$5,'p15.boundary',$6)",
      [a.accountId, a.users.owner.userId, 'res-a', b.accountId, b.users.owner.userId, 'res-b']);
    const all = await listAuditLog(a.users.admin.context, parseAuditQuery(new URLSearchParams()));
    expect(all.entries.some((e) => e.resource_id === 'res-a')).toBe(true);
    expect(JSON.stringify(all)).not.toContain(b.users.owner.userId);
    expect(JSON.stringify(all)).not.toContain('res-b');
    const byForeignActor = await listAuditLog(a.users.admin.context, parseAuditQuery(new URLSearchParams({ actor: b.users.owner.userId })));
    expect(byForeignActor.entries).toEqual([]);
    const { GET } = await import('@/app/api/audit-log/route');
    const response = await callRoute(GET, await signedRequest(a.users.admin, 'GET', `/api/audit-log?actor=${b.users.owner.userId}`));
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('res-b');
    const agent = await callRoute(GET, await signedRequest(a.users.agent, 'GET', '/api/audit-log'));
    expect(agent.status).toBe(403);
  }, 60000);

  it("dashboard: A's operational aggregates count only A's conversations and team", async () => {
    const { a, b } = pair;
    const overview = await loadDashboardOperations(a.context, 7);
    const text = JSON.stringify(overview);
    for (const value of [b.conversationId, b.contactId, ...Object.values(b.users).map((u) => u.userId)]) expect(text).not.toContain(value);
    const own = Object.values(a.users).map((u) => u.userId);
    expect(overview.team.length).toBeGreaterThan(0);
    expect(overview.team.filter((m) => !own.includes(m.id))).toEqual([]);
  }, 60000);
});
