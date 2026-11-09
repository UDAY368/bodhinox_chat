// Phase 15 (design 1.2.2): every data-gateway resource and every fixed RPC, called as tenant A with
// tenant B's ids, returns nothing or is rejected, and leaves B's rows and outbox untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { resources, type Resource } from '@/lib/data/contracts';
import type { QuerySpec, TenantContext } from '@/lib/data/types';
import { executeQuery } from './crm';
import { executeRpc } from './rpc';
import { rpcContracts } from './rpc-contracts';
import {
  cleanupTenants, closeFixture, createTenantPair, fixtureDatabaseUrls, fixtureOwnerPool, type TenantFixture,
  type TenantPair,
} from '@/test/tenancy/fixtures';

const databases = fixtureDatabaseUrls();
// Resources whose row key is not "id".
const KEY_COLUMN: Record<string, string> = { member_presence: 'user_id' };

/** Every row the fixture made for one tenant, read by the owner connection (setup-only role). */
async function snapshot(tenant: TenantFixture): Promise<Record<string, unknown>> {
  const pool = fixtureOwnerPool();
  const out: Record<string, unknown> = {};
  for (const [table, id] of Object.entries(tenant.ids)) {
    const column = KEY_COLUMN[table] ?? 'id';
    const rows = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.${column}=$1::uuid AND ${table === 'accounts' ? 't.id' : 't.account_id'}=$2::uuid`,
      [id, tenant.accountId]);
    out[table] = rows.rows.map((r) => r.row);
  }
  const outbox = await pool.query('SELECT count(*)::int AS n FROM outbox_events WHERE account_id=$1::uuid', [tenant.accountId]);
  out.__outbox = outbox.rows[0].n;
  return out;
}

/** A value for the first simple writable column, so the update spec itself is valid. */
function tamper(resource: Resource): Record<string, unknown> | null {
  const column = resource.columns.find((c) => resource.writable.includes(c.name) && !c.reference
    && !['account_id', 'user_id', 'id'].includes(c.name) && /^(text|boolean|bool)$/i.test(c.type));
  if (!column) return null;
  return { [column.name]: /bool/i.test(column.type) ? true : 'p15-cross-tenant' };
}

const run = (context: TenantContext, spec: Omit<QuerySpec, 'filters'> & { filters?: QuerySpec['filters'] }, browser = false, worker = false) =>
  executeQuery({ filters: [], ...spec } as QuerySpec, context, browser, worker);

describe.skipIf(!databases)('[TEN-01][SEC-03] data gateway contracts reject cross-tenant ids', () => {
  let pair: TenantPair;
  beforeAll(async () => { pair = await createTenantPair({ label: 'contracts' }); }, 60000);
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  it('has a tenant B row for every resource in the contract map', () => {
    const missing = Object.keys(resources).filter((name) => !pair.b.ids[name]);
    expect(missing).toEqual([]);
  });

  it('positive control: the same specs find A rows as A, so the negative checks are not vacuous', async () => {
    const unseen: string[] = [];
    for (const name of Object.keys(resources)) {
      const key = KEY_COLUMN[name] ?? 'id';
      const own = await run(pair.a.context, { resource: name, operation: 'select', projection: key,
        filters: [{ field: key, op: 'eq', value: pair.a.ids[name] }] });
      if (own.error || (own.data as unknown[]).length !== 1) unseen.push(name);
    }
    expect(unseen).toEqual([]);
  }, 60000);

  it('select, update and delete by B ids return nothing and change nothing, for every resource and path', async () => {
    const { a, b } = pair;
    const before = await snapshot(b);
    const leaks: string[] = [];
    for (const [name, resource] of Object.entries(resources)) {
      const key = KEY_COLUMN[name] ?? 'id';
      const id = b.ids[name];
      const byId = [{ field: key, op: 'eq' as const, value: id }];
      // Server path (owner), browser path when the resource is browser-visible, and the worker path.
      const paths: [string, TenantContext, boolean, boolean][] = [['server', a.context, false, false], ['worker', a.context, false, true]];
      if (resource.browser) paths.push(['browser', a.context, true, false]);
      for (const [path, context, browser, worker] of paths) {
        const selected = await run(context, { resource: name, operation: 'select', projection: key, filters: byId }, browser, worker);
        if (!selected.error && Array.isArray(selected.data) && selected.data.length) leaks.push(`${path} select ${name}`);
        const scoped = await run(context, { resource: name, operation: 'select', projection: key,
          filters: [{ field: name === 'accounts' ? 'id' : 'account_id', op: 'eq', value: b.accountId }] }, browser, worker);
        if (!scoped.error && Array.isArray(scoped.data) && scoped.data.length) leaks.push(`${path} select ${name} by account`);
        const values = tamper(resource);
        if (values) {
          const updated = await run(context, { resource: name, operation: 'update', values, filters: byId, returning: true, projection: key }, browser, worker);
          if (!updated.error && Array.isArray(updated.data) && updated.data.length) leaks.push(`${path} update ${name}`);
        }
        const deleted = await run(context, { resource: name, operation: 'delete', filters: byId, returning: true, projection: key }, browser, worker);
        if (!deleted.error && Array.isArray(deleted.data) && deleted.data.length) leaks.push(`${path} delete ${name}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(await snapshot(b)).toEqual(before);
  }, 180000);

  it('an insert naming tenant B is rejected or stays in tenant A', async () => {
    const { a, b } = pair;
    const before = await snapshot(b);
    const inserted = await run(a.context, { resource: 'contacts', operation: 'insert',
      values: { account_id: b.accountId, phone: '910000000001', name: 'p15 cross insert' }, returning: true, projection: 'id,account_id' });
    if (!inserted.error) {
      const rows = inserted.data as { id: string; account_id: string }[];
      expect(rows.every((row) => row.account_id === a.accountId)).toBe(true);
    }
    const note = await run(a.context, { resource: 'contact_notes', operation: 'insert',
      values: { contact_id: b.contactId, note_text: 'p15 foreign parent' }, returning: true, projection: 'id' });
    expect(note.error).not.toBeNull();
    const message = await run(a.context, { resource: 'deals', operation: 'insert',
      values: { pipeline_id: b.ids.pipelines, stage_id: b.ids.pipeline_stages, title: 'p15 foreign deal' }, returning: true, projection: 'id' });
    expect(message.error).not.toBeNull();
    expect(await snapshot(b)).toEqual(before);
  }, 60000);
});

describe.skipIf(!databases)('[TEN-01][SEC-03] fixed RPCs reject cross-tenant ids', () => {
  let pair: TenantPair;
  beforeAll(async () => { pair = await createTenantPair({ label: 'rpc' }); }, 60000);
  afterAll(async () => {
    if (pair) await cleanupTenants([pair.a.accountId, pair.b.accountId]);
    await closeFixture();
    await disconnectDatabases();
  }, 60000);

  // Tenant A's call with B's ids in every id-typed argument. A contract without a case fails below.
  const cases = (a: TenantFixture, b: TenantFixture): Record<string, Record<string, unknown>[]> => ({
    mark_conversation_read: [{ p_conversation_id: b.conversationId }],
    set_media_retention: [{ p_enabled: true }],
    filter_contacts_by_tags: [{ p_tag_ids: [b.ids.tags] }],
    touch_presence: [{ p_status: 'away' }],
    increment_automation_execution_count: [{ p_automation_id: b.ids.automations }],
    increment_flow_execution_count: [{ p_flow_id: b.ids.flows }],
    claim_ai_reply_slot: [{ conversation_id: b.conversationId, max_replies: 5 }],
    bump_conversation_on_inbound: [{ p_conversation_id: b.conversationId, p_last_message_text: 'p15 foreign bump' }],
    create_broadcast_with_recipients: [
      { p_account_id: b.accountId, p_user_id: b.users.owner.userId, p_name: 'x', p_template_name: 'x', p_template_language: 'en_US', p_total_recipients: 1, p_contact_ids: [b.contactId] },
      { p_account_id: a.accountId, p_user_id: a.users.owner.userId, p_name: 'p15 foreign recipients', p_template_name: 'x', p_template_language: 'en_US', p_total_recipients: 1, p_contact_ids: [b.contactId] },
    ],
    match_ai_knowledge_fts: [{ p_account_id: b.accountId, p_query: 'Synthetic', p_match_count: 5 }, { p_account_id: a.accountId, p_query: 'Synthetic', p_match_count: 50 }],
    match_ai_knowledge_semantic: [{ p_account_id: b.accountId, p_query_embedding: '[0]', p_match_count: 5 }],
    match_ai_knowledge_fts_v2: [{ p_account_id: b.accountId, p_query: 'Synthetic', p_match_count: 5, p_audience: 'customer' }, { p_account_id: a.accountId, p_query: 'Synthetic', p_match_count: 50, p_audience: 'customer' }],
    match_ai_knowledge_semantic_v2: [{ p_account_id: b.accountId, p_query_embedding: '[0]', p_match_count: 5, p_audience: 'customer' }],
    record_webhook_failure: [{ endpoint_id: b.webhookEndpointId, max_failures: 1 }],
    record_webhook_attempt: [{ p_endpoint_id: b.webhookEndpointId, p_event: 'message.received', p_delivery_id: null, p_attempt: 1,
      p_delivered: false, p_http_status: 0, p_error: 'p15_foreign', p_min_failures: 1, p_disable_after_minutes: 0 }],
    recompute_broadcast_counts: [{ bid: b.broadcastId }],
  });

  it("membership RPCs naming B's members are a not-found and leave B's memberships alone", async () => {
    const { a, b } = pair;
    const memberships = async () => (await fixtureOwnerPool().query(
      'SELECT user_id::text, role FROM account_memberships WHERE account_id=$1::uuid ORDER BY user_id', [b.accountId])).rows;
    const before = await memberships();
    for (const [name, args] of [
      ['set_member_role', { p_user_id: b.users.agent.userId, p_new_role: 'viewer' }],
      ['remove_account_member', { p_user_id: b.users.viewer.userId }],
      ['transfer_account_ownership', { p_new_owner_user_id: b.users.admin.userId }],
    ] as const) {
      const result = await executeRpc(name, args, a.context);
      expect(result.error?.code, name).toBe('P0002');
    }
    expect(await memberships()).toEqual(before);
  }, 60000);

  it('covers every RPC contract', () => {
    expect(Object.keys(rpcContracts).filter((name) => !(name in cases(pair.a, pair.b)))).toEqual([]);
  });

  it('every RPC with B ids is rejected or has no effect on B, through the app and worker roles', async () => {
    const { a, b } = pair;
    const before = await snapshot(b);
    const bIds = new Set(Object.values(b.ids));
    const leaks: string[] = [];
    for (const [name, list] of Object.entries(cases(a, b))) {
      for (const args of list) {
        for (const worker of [false, true]) {
          const result = await executeRpc(name, args, a.context, false, worker);
          const text = JSON.stringify(result.data ?? null);
          if ([...bIds].some((id) => text.includes(id))) leaks.push(`${name}${worker ? ' (worker)' : ''} returned a B id`);
          if (args.p_account_id === b.accountId) expect(result.error?.code, name).toBe('TENANT_MISMATCH');
        }
      }
    }
    expect(leaks).toEqual([]);
    expect(await snapshot(b)).toEqual(before);
    // The A-side broadcast never got B's contact as a recipient.
    const foreign = await fixtureOwnerPool().query(
      'SELECT count(*)::int AS n FROM broadcast_recipients WHERE contact_id=$1::uuid AND account_id<>$2::uuid', [b.contactId, b.accountId]);
    expect(foreign.rows[0].n).toBe(0);
  }, 120000);
});
