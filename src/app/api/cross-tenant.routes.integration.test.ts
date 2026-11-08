/// <reference types="vite/client" />
// Phase 15 (design 1.2.3): tenant A calls the highest-risk tenant-owned id routes with tenant B's
// ids through the real route handlers, session, membership and CSRF checks. Pass = 403/404 (400
// only where the case says the route validates the body before loading the record) and B's rows
// unchanged. A coverage check lists dynamic routes that are neither mapped nor exempt; the list is
// pinned in KNOWN_UNMAPPED so the gap is visible and cannot grow silently.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { disconnectDatabases } from '@/lib/db/prisma';
import { FEATURE_PERMISSIONS } from '@/lib/auth/permissions';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, signedRequest,
  type FixtureRole, type TenantFixture, type TenantPair,
} from '@/test/tenancy/fixtures';
import { callRoute } from '@/test/tenancy/request-scope';

vi.mock('next/headers', async () => (await import('@/test/tenancy/request-scope')).nextHeadersMock);

const routeModules = import.meta.glob('/src/app/api/**/route.ts');
const databases = fixtureDatabaseUrls();

type Extra = Record<'list' | 'segment' | 'team' | 'paymentLink' | 'media' | 'note' | 'attribute' | 'schedule'
  | 'savedFilter' | 'form' | 'mediaKey', string>;
type Ids = TenantFixture & { extra: Extra };

type Case = {
  /** Route folder under src/app/api, e.g. "teams/[id]". */
  route: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  params: (b: Ids) => Record<string, string>;
  query?: (b: Ids) => string;
  body?: (a: Ids, b: Ids) => unknown;
  /** Caller role in tenant A (default owner). */
  as?: FixtureRole;
  /** The route validates the body before it loads the record, so 400 is an accepted refusal. */
  validatesBodyFirst?: true;
  /** Environment set only while this case runs (e.g. a feature that answers without a query while off). */
  env?: Record<string, string>;
};

const INSTAGRAM_ON = {
  INSTAGRAM_ENABLED: 'true', INSTAGRAM_APP_ID: '1000000001', INSTAGRAM_APP_SECRET: 'tenancy-test-secret',
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'tenancy-test-verify',
};

const id = (key: keyof TenantFixture) => (b: Ids) => ({ id: b[key] as string });
const extra = (key: keyof Extra) => (b: Ids) => ({ id: b.extra[key] });
const rid = (resource: string) => (b: Ids) => ({ id: b.ids[resource] });

export const CASES: Case[] = [
  // Contacts and conversations
  { route: 'contacts/[id]/tags', method: 'POST', params: id('contactId'), body: (a) => ({ tag_id: a.ids.tags }) },
  { route: 'contacts/[id]/tags', method: 'DELETE', params: id('contactId'), body: (_a, b) => ({ tag_id: b.ids.tags }) },
  // While Instagram is off the list answers { enabled:false } with no query for any id, so the case runs with it on.
  { route: 'contacts/[id]/identities', method: 'GET', params: id('contactId'), env: INSTAGRAM_ON },
  { route: 'conversations/[id]/notes', method: 'GET', params: id('conversationId') },
  { route: 'conversations/[id]/notes', method: 'POST', params: id('conversationId'), body: () => ({ body: 'p15 cross-tenant note' }) },
  { route: 'conversations/[id]/notes/[noteId]', method: 'PATCH', params: (b) => ({ id: b.conversationId, noteId: b.extra.note }), body: () => ({ body: 'p15 edit' }) },
  { route: 'conversations/[id]/notes/[noteId]', method: 'DELETE', params: (b) => ({ id: b.conversationId, noteId: b.extra.note }) },
  { route: 'conversations/[id]/ad-referral', method: 'GET', params: id('conversationId') },
  // Orders and payments
  { route: 'commerce/orders/[id]', method: 'GET', params: id('orderId') },
  { route: 'commerce/orders/[id]', method: 'PATCH', params: id('orderId'), body: () => ({ status: 'cancelled' }) },
  { route: 'commerce/orders/[id]/events', method: 'GET', params: id('orderId') },
  { route: 'commerce/orders/[id]/dispatch', method: 'POST', params: id('orderId'), body: () => ({}) },
  { route: 'commerce/orders/[id]/deliver', method: 'POST', params: id('orderId'), body: () => ({}) },
  { route: 'commerce/orders/[id]/cancel-refund', method: 'POST', params: id('orderId'), body: () => ({ reason: 'p15' }) },
  { route: 'commerce/orders/[id]/offline-payment', method: 'POST', params: id('orderId'), body: () => ({ amount: '10.00', method: 'cash', client_request_id: randomUUID() }) },
  { route: 'commerce/orders/[id]/returns', method: 'GET', params: id('orderId') },
  { route: 'commerce/orders/[id]/shipment', method: 'GET', params: id('orderId') },
  { route: 'payments/links/[id]', method: 'GET', params: extra('paymentLink') },
  { route: 'payments/links/[id]', method: 'POST', params: extra('paymentLink'), body: () => ({ action: 'cancel' }) },
  // Appointments
  { route: 'appointments/[id]', method: 'GET', params: id('appointmentId') },
  { route: 'appointments/[id]', method: 'PATCH', params: id('appointmentId'), body: () => ({ action: 'cancel', reason: 'staff', expected_version: 1 }) },
  { route: 'appointments/services/[id]', method: 'PATCH', params: rid('appointment_services'), body: () => ({ name: 'p15 tamper' }) },
  { route: 'appointments/locations/[id]', method: 'PATCH', params: rid('appointment_locations'), body: () => ({ name: 'p15 tamper' }) },
  // Broadcasts
  { route: 'broadcasts/[id]/schedule', method: 'PATCH', params: id('broadcastId'), body: () => ({ scheduledAt: new Date(Date.now() + 86400000).toISOString() }) },
  { route: 'broadcasts/[id]/schedule', method: 'DELETE', params: id('broadcastId') },
  { route: 'whatsapp/broadcast/[id]/resume', method: 'POST', params: id('broadcastId'), body: () => ({}) },
  // Flows and automations
  { route: 'flows/[id]', method: 'GET', params: rid('flows') },
  { route: 'flows/[id]', method: 'PUT', params: rid('flows'), body: () => ({ name: 'p15 tamper' }) },
  { route: 'flows/[id]', method: 'DELETE', params: rid('flows') },
  { route: 'flows/[id]/duplicate', method: 'POST', params: rid('flows'), body: () => ({}) },
  { route: 'flows/[id]/activate', method: 'POST', params: rid('flows'), body: () => ({ status: 'active' }) },
  { route: 'flows/[id]/runs', method: 'GET', params: rid('flows') },
  { route: 'flows/[id]/versions', method: 'GET', params: rid('flows') },
  { route: 'automations/[id]', method: 'GET', params: rid('automations') },
  { route: 'automations/[id]', method: 'PATCH', params: rid('automations'), body: () => ({ name: 'p15 tamper' }) },
  { route: 'automations/[id]', method: 'DELETE', params: rid('automations') },
  { route: 'automations/[id]/duplicate', method: 'POST', params: rid('automations'), body: () => ({}) },
  // Lists and segments
  { route: 'lists/[id]', method: 'DELETE', params: extra('list') },
  { route: 'lists/[id]/members', method: 'POST', params: extra('list'), body: (a) => ({ add: [a.contactId] }) },
  { route: 'lists/[id]/contacts', method: 'GET', params: extra('list') },
  { route: 'segments/[id]', method: 'PATCH', params: extra('segment'), body: () => ({ name: 'p15 tamper' }) },
  { route: 'segments/[id]', method: 'DELETE', params: extra('segment') },
  { route: 'segments/[id]/contacts', method: 'GET', params: extra('segment') },
  // Media
  { route: 'media/library/[id]', method: 'DELETE', params: extra('media') },
  // Account settings
  { route: 'account/webhooks/[id]', method: 'PATCH', params: id('webhookEndpointId'), body: () => ({ is_active: false }) },
  { route: 'account/webhooks/[id]', method: 'DELETE', params: id('webhookEndpointId') },
  { route: 'account/api-keys/[id]', method: 'DELETE', params: id('apiKeyId') },
  { route: 'account/members/[userId]', method: 'PATCH', params: (b) => ({ userId: b.users.agent.userId }), body: () => ({ role: 'viewer' }) },
  { route: 'account/members/[userId]', method: 'DELETE', params: (b) => ({ userId: b.users.agent.userId }) },
  { route: 'workspace-attributes/[key]', method: 'DELETE', params: (b) => ({ key: b.extra.attribute }) },
  { route: 'teams/[id]', method: 'PUT', params: extra('team'), body: () => ({ name: 'p15 tamper' }) },
  { route: 'teams/[id]', method: 'DELETE', params: extra('team') },
  // Quick replies, templates, knowledge, forms, numbers
  { route: 'quick-replies/[id]', method: 'PATCH', params: rid('quick_replies'), body: () => ({ title: 'p15 tamper' }) },
  { route: 'quick-replies/[id]', method: 'DELETE', params: rid('quick_replies') },
  { route: 'whatsapp/templates/[id]', method: 'DELETE', params: rid('message_templates') },
  { route: 'whatsapp/templates/[id]/duplicate', method: 'POST', params: rid('message_templates'), body: () => ({}) },
  { route: 'whatsapp/templates/[id]/events', method: 'GET', params: rid('message_templates') },
  { route: 'ai/knowledge/[id]', method: 'GET', params: rid('ai_knowledge_documents') },
  { route: 'ai/knowledge/[id]', method: 'PATCH', params: rid('ai_knowledge_documents'), body: () => ({ title: 'p15 tamper' }) },
  { route: 'ai/knowledge/[id]', method: 'DELETE', params: rid('ai_knowledge_documents') },
  { route: 'whatsapp/forms/[id]', method: 'GET', params: extra('form') },
  { route: 'whatsapp/forms/[id]', method: 'DELETE', params: extra('form') },
  { route: 'whatsapp/forms/[id]/responses', method: 'GET', params: extra('form') },
  { route: 'whatsapp/numbers/[id]', method: 'PATCH', params: id('whatsappConfigId'), body: () => ({ display_name: 'p15 tamper' }) },
  { route: 'whatsapp/numbers/[id]', method: 'DELETE', params: id('whatsappConfigId') },
  // Inbox and reports
  { route: 'inbox/saved-filters/[id]', method: 'PATCH', params: extra('savedFilter'), body: () => ({ name: 'p15 tamper' }) },
  { route: 'inbox/saved-filters/[id]', method: 'DELETE', params: extra('savedFilter') },
  { route: 'analytics/reports/schedules/[id]', method: 'PATCH', params: extra('schedule'), body: () => ({ paused: true }) },
  { route: 'analytics/reports/schedules/[id]', method: 'DELETE', params: extra('schedule') },
];

/**
 * Mutation cases that refuse even on the caller's own fresh rows, for a state reason (not the tenant
 * lookup); the positive control expects exactly this status. Any other own-row 403/404 fails it.
 */
export const OWN_ROW_REFUSALS: Record<string, { status: number; reason: string }> = {};

/** Dynamic routes outside tenant-session id semantics, with the reason. */
export const EXEMPT: Record<string, string> = {
  'auth/[action]': 'pre-session auth endpoints',
  'invitations/[token]/peek': 'invitation token, not a tenant id',
  'invitations/[token]/redeem': 'invitation token, not a tenant id',
  'crm/[resource]': 'data gateway: covered resource by resource in cross-tenant.contracts.integration.test.ts',
  'crm/actions/[operation]': 'fixed RPCs: covered in cross-tenant.contracts.integration.test.ts',
  'payments/razorpay/webhook/[accountId]': 'signature-authenticated webhook: worker-db route test',
  'fulfilment/tracking/[accountId]': 'signature-authenticated webhook: worker-db route test',
  'integrations/woocommerce/webhook/[storeId]': 'signature-authenticated webhook: worker-db route test',
  'whatsapp/forms/endpoint/[accountId]': 'Meta-encrypted data exchange endpoint, key per account',
  'reports/shared/[shareId]': 'public share link (token-authorized)',
  'reports/shared/[shareId]/info': 'public share link (token-authorized)',
};
const EXEMPT_PREFIXES = ['public/', 'platform/', 'v1/'];

/**
 * Dynamic routes with no case yet (the visible gap, published in the release evidence). New routes
 * must be added to CASES or EXEMPT; this list may only shrink.
 */
export const KNOWN_UNMAPPED = [
  'account/export/[id]/download',
  'account/invitations/[id]',
  'account/support-grants/[id]',
  'ai/assess/conversation/[id]',
  'ai/assess/conversation/[id]/refresh',
  'ai/assist/suggestions/[id]/decision',
  'ai/autoreply/[conversationId]',
  'ai/insights/[id]',
  'ai/knowledge/sources/[id]',
  'ai/unanswered/[id]',
  'analytics/reports/[id]/download',
  'analytics/reports/[id]/shares',
  'analytics/reports/[id]/shares/[shareId]',
  'appointments/[id]/meeting',
  'appointments/booking-pages/[id]',
  'appointments/exceptions/[id]',
  'appointments/messages/[id]/resolve',
  'appointments/staff/[id]',
  'appointments/tasks/[id]',
  'billing/invoices/[id]',
  'commerce/catalogs/[id]',
  'commerce/catalogs/[id]/sync',
  'commerce/coupons/[id]',
  'commerce/documents/[id]',
  'commerce/events/[id]/resolve',
  'commerce/inventory/[variantId]/adjust',
  'commerce/inventory/[variantId]/threshold',
  'commerce/orders/[id]/feedback',
  'commerce/orders/[id]/shipment/awb',
  'commerce/orders/[id]/shipment/label',
  'commerce/payment-exceptions/[id]/resolve',
  'commerce/returns/[id]',
  'commerce/shipment-exceptions/[id]',
  'commerce/shipping-rates/[id]',
  'commerce/shop/categories/[id]',
  'commerce/shop/products/[id]',
  'commerce/shop/products/[id]/archive',
  'commerce/shop/products/[id]/publish',
  'commerce/shop/products/[id]/variants',
  'commerce/shop/products/[id]/variants/[variantId]',
  'commerce/storefront-links/[id]',
  'contacts/[id]/identities/link',
  'contacts/[id]/identities/unlink',
  'flows/[id]/dry-run',
  'flows/[id]/number',
  'flows/[id]/runs/[runId]',
  'flows/[id]/runs/[runId]/replay',
  'flows/[id]/runs/cancel',
  'flows/[id]/runs/migrate',
  'flows/[id]/versions/[versionId]',
  'inbox/routing-rules/[id]',
  'instagram/accounts/[id]',
  'instagram/accounts/[id]/comment-rules',
  'instagram/accounts/[id]/comment-rules/[ruleId]',
  'instagram/accounts/[id]/health',
  // Calls Instagram for the caller's own account (no positive control here); tenancy.integration.test.ts covers B's id -> not_found.
  'instagram/accounts/[id]/posts',
  'meta-ads/conversions/[id]/resolve',
  'meta-ads/leads/[id]',
  'payments/customer-payments/[id]/refund',
  'payments/refunds/[id]',
  'whatsapp/forms/[id]/duplicate',
  'whatsapp/forms/[id]/publish',
  'whatsapp/forms/[id]/responses/export',
  'whatsapp/media/[mediaId]',
  'whatsapp/numbers/[id]/profile',
];

function dynamicRoutes(): string[] {
  return Object.keys(routeModules)
    .map((path) => path.replace(/^\/src\/app\/api\//, '').replace(/\/route\.ts$/, ''))
    .filter((route) => route.includes('['))
    .sort();
}

describe('[TEN-01][SEC-03] cross-tenant route coverage', () => {
  it('every dynamic route is mapped, exempt, or a pinned known gap', () => {
    const mapped = new Set(CASES.map((c) => c.route));
    const unmapped = dynamicRoutes().filter((route) => !mapped.has(route) && !Object.hasOwn(EXEMPT, route)
      && !EXEMPT_PREFIXES.some((prefix) => route.startsWith(prefix)));
    // New dynamic routes must be covered; a newly mapped route must leave KNOWN_UNMAPPED.
    expect(unmapped.filter((route) => !KNOWN_UNMAPPED.includes(route))).toEqual([]);
    expect(KNOWN_UNMAPPED.filter((route) => !unmapped.includes(route))).toEqual([]);
  });

  it('every case points at a real route file and method', async () => {
    const problems: string[] = [];
    for (const c of CASES) {
      const loader = routeModules[`/src/app/api/${c.route}/route.ts`];
      if (!loader) { problems.push(`missing ${c.route}`); continue; }
      const mod = (await loader()) as Record<string, unknown>;
      if (typeof mod[c.method] !== 'function') problems.push(`${c.method} ${c.route}`);
    }
    expect(problems).toEqual([]);
  }, 120000);
});

const TABLES = ['contacts', 'conversations', 'messages', 'tags', 'contact_tags', 'orders', 'appointments', 'appointment_services',
  'appointment_locations', 'broadcasts', 'broadcast_recipients', 'flows', 'flow_nodes', 'flow_runs', 'automations', 'automation_steps',
  'contact_lists', 'contact_list_members', 'segments', 'teams', 'payment_links', 'media_objects', 'conversation_notes',
  'workspace_attributes', 'report_schedules', 'saved_filters', 'whatsapp_forms', 'webhook_endpoints', 'api_keys',
  'account_memberships', 'quick_replies', 'message_templates', 'ai_knowledge_documents', 'whatsapp_config', 'accounts'];

async function existingTables(): Promise<string[]> {
  const rows = await fixtureOwnerPool().query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])", [TABLES]);
  return rows.rows.map((r) => r.t).sort();
}

async function snapshot(accountId: string, tables: string[]): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    const column = table === 'accounts' ? 'id' : 'account_id';
    const rows = await fixtureOwnerPool().query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.${column}=$1::uuid ORDER BY to_jsonb(t)::text`, [accountId]);
    out[table] = rows.rows.map((r) => r.row);
  }
  return out;
}

/** Tenant-owned rows the base fixture does not make, created as owner for the route cases. */
async function addExtras(t: TenantFixture, tag: string): Promise<Extra> {
  const pool = fixtureOwnerPool();
  const one = async (sql: string, values: unknown[]) => String((await pool.query<{ id: string }>(`${sql} RETURNING id`, values)).rows[0].id);
  const u = t.users.owner.userId, a = t.accountId;
  const mediaKey = `account-${a}/library/${randomUUID()}.png`;
  return {
    list: await one('INSERT INTO contact_lists(account_id,user_id,name) VALUES($1,$2,$3)', [a, u, `p15 list ${tag}`]),
    segment: await one('INSERT INTO segments(account_id,user_id,name,filter) VALUES($1,$2,$3,$4::jsonb)', [a, u, `p15 segment ${tag}`,
      JSON.stringify({ conditions: [{ field: 'tags', op: 'has_any', tagIds: [t.ids.tags] }] })]),
    team: await one('INSERT INTO teams(account_id,name) VALUES($1,$2)', [a, `p15 team ${tag}`]),
    paymentLink: await one("INSERT INTO payment_links(account_id,provider,reference_id,amount_minor,currency,order_id,contact_id,status) VALUES($1,'razorpay',$2,1000,'INR',$3,$4,'created')",
      [a, `p15${randomUUID().replaceAll('-', '')}`.slice(0, 32), t.orderId, t.contactId]),
    media: await one("INSERT INTO media_objects(account_id,uploaded_by,object_key,bucket,content_type,byte_size,original_name,in_library) VALUES($1,$2,$3,'chat-media','image/png',10,'p15.png',true)",
      [a, u, mediaKey]),
    mediaKey,
    note: await one('INSERT INTO conversation_notes(account_id,conversation_id,author_id,body) VALUES($1,$2,$3,$4)', [a, t.conversationId, u, `p15 note ${tag}`]),
    attribute: (await pool.query('INSERT INTO workspace_attributes(account_id,key,value) VALUES($1,$2,$3) RETURNING key', [a, `p15_${tag}_only`, `value ${tag}`])).rows[0].key,
    schedule: await one("INSERT INTO report_schedules(account_id,kind,cadence,recipients,created_by,next_run_at) VALUES($1,'campaign_summary','weekly',ARRAY[$2::uuid],$2,NOW()+interval '1 day')",
      [a, u]),
    savedFilter: await one("INSERT INTO saved_filters(account_id,user_id,name) VALUES($1,$2,'p15 view')", [a, u]),
    form: await one("INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition) VALUES($1,$2,$3,'OTHER',$4::jsonb)",
      [a, u, `p15 form ${tag}`, JSON.stringify({ screens: [] })]),
  };
}

async function invoke(c: Case, caller: Ids, target: Ids): Promise<Response> {
  const mod = (await routeModules[`/src/app/api/${c.route}/route.ts`]()) as Record<string, (r: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const params = c.params(target);
  const path = `/api/${c.route.replace(/\[([^\]]+)\]/g, (_m, key: string) => encodeURIComponent(params[key]))}${c.query ? `?${c.query(target)}` : ''}`;
  const request = await signedRequest(caller.users[c.as ?? 'owner'], c.method, path, c.method === 'GET' ? undefined : (c.body?.(caller, target) ?? {}));
  const saved = Object.fromEntries(Object.keys(c.env ?? {}).map((key) => [key, process.env[key]]));
  Object.assign(process.env, c.env ?? {});
  try {
    return await callRoute(mod[c.method], request, params);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe.skipIf(!databases)('[TEN-01][SEC-03] cross-tenant id routes', () => {
  let pair: TenantPair;
  let a: Ids, b: Ids;
  let tables: string[];

  beforeAll(async () => {
    pair = await createTenantPair({ label: 'routes' });
    a = { ...pair.a, extra: await addExtras(pair.a, 'a') };
    b = { ...pair.b, extra: await addExtras(pair.b, 'b') };
    tables = await existingTables();
  }, 120000);
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('tenant A with tenant B ids is refused and B is unchanged, for every case', async () => {
    const before = await snapshot(b.accountId, tables);
    const wrong: string[] = [];
    for (const c of CASES) {
      const response = await invoke(c, a, b);
      const text = await response.text();
      for (const value of [b.contactId, b.conversationId, b.orderId, b.extra.mediaKey])
        if (text.includes(value)) wrong.push(`${c.method} ${c.route} leaked a B id`);
      const allowed = c.validatesBodyFirst ? [400, 403, 404] : [403, 404];
      if (!allowed.includes(response.status)) wrong.push(`${c.method} ${c.route} -> ${response.status}`);
    }
    expect(wrong).toEqual([]);
    expect(await snapshot(b.accountId, tables)).toEqual(before);
  }, 300000);

  it('positive control: the GET cases answer 200 for the caller\'s own ids, so the refusals are not a harness fault', async () => {
    const wrong: string[] = [];
    for (const c of CASES.filter((x) => x.method === 'GET')) {
      const response = await invoke(c, a, a);
      if (response.status !== 200) wrong.push(`GET ${c.route} -> ${response.status}`);
    }
    expect(wrong).toEqual([]);
  }, 120000);

  it('positive control: each mutation case as A on its own fresh rows is not refused with 403/404, so the cross-tenant refusals come from the tenant lookup', async () => {
    const wrong: string[] = [];
    for (const c of CASES.filter((x) => x.method !== 'GET')) {
      // A fresh pair per case: mutations (deletes, cancels) would otherwise change the rows later cases need.
      const fresh = await createTenantPair({ label: 'routes-pc' });
      try {
        const own: Ids = { ...fresh.a, extra: await addExtras(fresh.a, 'pc') };
        const response = await invoke(c, own, own);
        const expected = OWN_ROW_REFUSALS[`${c.method} ${c.route}`];
        if (expected ? response.status !== expected.status : [403, 404].includes(response.status))
          wrong.push(`${c.method} ${c.route} -> ${response.status}`);
      } finally {
        await cleanupTenants([fresh.a.accountId, fresh.b.accountId]);
      }
    }
    expect(wrong).toEqual([]);
  }, 600000);

  it('a storage object key under tenant B is refused before any storage access', async () => {
    const mod = (await routeModules['/src/app/api/media/object/route.ts']()) as { GET: (r: Request) => Promise<Response> };
    const request = await signedRequest(a.users.owner, 'GET', `/api/media/object?bucket=chat-media&key=${encodeURIComponent(b.extra.mediaKey)}`);
    const response = await callRoute(mod.GET, request);
    expect([403, 404]).toContain(response.status);
  }, 30000);

  it('list routes return no tenant B ids to tenant A', async () => {
    const lists: [string, string, string?][] = [['lists', 'GET'], ['segments', 'GET'], ['teams', 'GET'], ['account/webhooks', 'GET'],
      ['workspace-attributes', 'GET'], ['notifications/preferences', 'GET'], ['inbox/saved-filters', 'GET'], ['whatsapp/forms', 'GET'],
      ['media/library', 'GET'], ['account/api-keys', 'GET'], ['account/members', 'GET'], ['commerce/orders', 'GET'],
      ['appointments', 'GET', `from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 30 * 86400000).toISOString()}`],
      ['payments/links', 'GET'], ['analytics/reports/schedules', 'GET'], ['flows', 'GET'], ['automations', 'GET']];
    const bIds = [...Object.values(b.ids), ...Object.values(b.extra),
      ...Object.values(b.users).map((u) => u.userId)];
    const leaks: string[] = [];
    const checked: string[] = [];
    const wrong: string[] = [];
    const bodies: string[] = [];
    for (const [route, method, query] of lists) {
      const loader = routeModules[`/src/app/api/${route}/route.ts`];
      if (!loader) continue;
      const mod = (await loader()) as Record<string, (r: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
      if (typeof mod[method] !== 'function') continue;
      const response = await callRoute(mod[method], await signedRequest(a.users.owner, method, `/api/${route}${query ? `?${query}` : ''}`));
      const text = await response.text();
      checked.push(route);
      // A refusal body has no B ids either, so every list must actually answer.
      if (response.status !== 200) wrong.push(`${route} -> ${response.status}`);
      else bodies.push(text);
      for (const value of bIds) if (text.includes(value)) leaks.push(`${route} leaked ${value === b.accountId ? 'B account' : 'a B id'}`);
    }
    expect(checked).toHaveLength(lists.length);
    expect(wrong).toEqual([]);
    expect(leaks).toEqual([]);
    // Positive control: the lists really read A's rows.
    const all = bodies.join('\n');
    const ownIds = { list: a.extra.list, segment: a.extra.segment, team: a.extra.team, schedule: a.extra.schedule,
      savedFilter: a.extra.savedFilter, form: a.extra.form, flow: a.ids.flows, automation: a.ids.automations, appointment: a.appointmentId };
    expect(Object.entries(ownIds).filter(([, value]) => !all.includes(value)).map(([key]) => key)).toEqual([]);
  }, 120000);

  // Role matrix on A's own rows: a role below the route's requirement gets 403 and nothing changes.
  const ROLE_CASES: (Case & { permission?: keyof typeof FEATURE_PERMISSIONS; target: (a: Ids) => Record<string, string> })[] = [
    { route: 'account/webhooks/[id]', method: 'DELETE', as: 'agent', params: id('webhookEndpointId'), target: id('webhookEndpointId') },
    { route: 'account/api-keys/[id]', method: 'DELETE', as: 'agent', params: id('apiKeyId'), target: id('apiKeyId') },
    { route: 'teams/[id]', method: 'DELETE', as: 'agent', params: extra('team'), target: extra('team') },
    { route: 'workspace-attributes/[key]', method: 'DELETE', as: 'agent', params: (t) => ({ key: t.extra.attribute }), target: (t) => ({ key: t.extra.attribute }) },
    { route: 'account/members/[userId]', method: 'PATCH', as: 'agent', params: (t) => ({ userId: t.users.viewer.userId }), body: () => ({ role: 'agent' }), target: (t) => ({ userId: t.users.viewer.userId }) },
    { route: 'quick-replies/[id]', method: 'DELETE', as: 'viewer', params: rid('quick_replies'), target: rid('quick_replies') },
    { route: 'flows/[id]', method: 'DELETE', as: 'viewer', params: rid('flows'), target: rid('flows') },
    { route: 'flows/[id]/activate', method: 'POST', as: 'viewer', permission: 'flows.publish', params: rid('flows'), body: () => ({ status: 'active' }), target: rid('flows') },
    { route: 'whatsapp/templates/[id]', method: 'DELETE', as: 'agent', permission: 'templates.submit', params: rid('message_templates'), target: rid('message_templates') },
    { route: 'ai/knowledge/[id]', method: 'DELETE', as: 'agent', permission: 'ai.knowledge', params: rid('ai_knowledge_documents'), target: rid('ai_knowledge_documents') },
    { route: 'whatsapp/broadcast/[id]/resume', method: 'POST', as: 'viewer', permission: 'campaigns.send', params: id('broadcastId'), body: () => ({}), target: id('broadcastId') },
    { route: 'broadcasts/[id]/schedule', method: 'DELETE', as: 'viewer', permission: 'campaigns.send', params: id('broadcastId'), target: id('broadcastId') },
    { route: 'commerce/orders/[id]/offline-payment', method: 'POST', as: 'agent', permission: 'commerce.record_payments', params: id('orderId'), body: () => ({ amount: '10.00', method: 'cash', client_request_id: randomUUID() }), target: id('orderId') },
    { route: 'appointments/[id]', method: 'PATCH', as: 'viewer', permission: 'appointments.manage', params: id('appointmentId'), body: () => ({ action: 'cancel', reason: 'staff', expected_version: 1 }), target: id('appointmentId') },
    { route: 'appointments/services/[id]', method: 'PATCH', as: 'agent', permission: 'appointments.settings', params: rid('appointment_services'), body: () => ({ name: 'p15 tamper' }), target: rid('appointment_services') },
    { route: 'whatsapp/forms/[id]', method: 'DELETE', as: 'agent', params: extra('form'), target: extra('form') },
    { route: 'whatsapp/numbers/[id]', method: 'DELETE', as: 'agent', params: id('whatsappConfigId'), target: id('whatsappConfigId') },
    { route: 'payments/refunds/[id]', method: 'POST', as: 'agent', permission: 'commerce.refunds', params: () => ({ id: randomUUID() }), body: () => ({}), target: () => ({}) },
  ];

  it('a role below the route requirement gets 403 on its own workspace and nothing changes', async () => {
    const before = await snapshot(a.accountId, tables);
    const wrong: string[] = [];
    for (const c of ROLE_CASES) {
      const response = await invoke({ ...c, params: c.target }, a, a);
      if (response.status !== 403) wrong.push(`${c.as} ${c.method} ${c.route} -> ${response.status}`);
    }
    expect(wrong).toEqual([]);
    expect(await snapshot(a.accountId, tables)).toEqual(before);
  }, 120000);
});
