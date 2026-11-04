// Real-database proof that a flow dry run has no side effects (Phase 12,
// design §3.1 and §7.2). A flow with a send, a template, a tag, an attribute,
// an API call, a payment link, a booking and a conversion event is dry-run
// end to end through the POST route as a masked agent. Every row count and
// timestamp it could touch is unchanged except one audit row, fetch is never
// called, and inside withDryRun a worker-connection write raises 25006 while
// enqueueJob, dispatchOnce and safeFetch throw before doing anything.
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ctx: { accountId: '', userId: '', role: 'agent' as const } }));
vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ ...h.ctx, sessionId: 's' }),
  assertMutation: async () => {},
}));
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: async () => ({ ...h.ctx, db: {}, account: { id: h.ctx.accountId, name: 'Dry' } }),
}));

import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { enqueueJob } from '@/lib/jobs/queue';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { safeFetch } from '@/lib/webhooks/safe-fetch';
import { DryRunSideEffectError, withDryRun } from '@/lib/runtime/dry-run-guard';
import { POST } from '@/app/api/flows/[id]/dry-run/route';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const A = randomUUID(), owner = randomUUID(), agent = randomUUID();
const flowId = randomUUID(), contactId = randomUUID(), conversationId = randomUUID(), tagId = randomUUID();
const phone = `1415${String(Date.now()).slice(-8)}9`;
let db: pg.Client;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);

const NODES = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'hello' } },
  { node_key: 'hello', node_type: 'send_message', config: { text: 'Hi from {{workspace.shop}} {{workspace.api_token}}', next_node_key: 'tpl' } },
  { node_key: 'tpl', node_type: 'send_template', config: { template_name: 'welcome', language: 'en', next_node_key: 'tag' } },
  { node_key: 'tag', node_type: 'set_tag', config: { mode: 'add', tag_id: tagId, next_node_key: 'attr' } },
  { node_key: 'attr', node_type: 'set_attribute', config: { target: 'contact_field', key: 'company', value: 'Changed', next_node_key: 'check' } },
  { node_key: 'check', node_type: 'condition', config: { subject: 'tag', subject_key: tagId, operator: 'present', true_next: 'api', false_next: 'done' } },
  { node_key: 'api', node_type: 'api_request', config: { method: 'POST', url: 'https://crm.example.com/hook?key={{workspace.api_token}}',
    routes: [{ status: '200', next_node_key: 'pay' }], fallback_next: 'done' } },
  { node_key: 'pay', node_type: 'payment_link', config: { amount: '499', currency: 'INR', message: 'Pay here', paid_next: 'book' } },
  { node_key: 'book', node_type: 'book_appointment', config: { mode: 'service', success_next: 'conv' } },
  { node_key: 'conv', node_type: 'conversion_event', config: { event_name: 'Purchase', next_node_key: 'done' } },
  { node_key: 'done', node_type: 'end', config: {} },
];

async function snapshot() {
  const count = async (table: string, column = 'account_id') =>
    Number((await q(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [A])).rows[0].n);
  return {
    messages: await count('messages'),
    outbound_intents: await count('outbound_intents'),
    flow_runs: await count('flow_runs'),
    flow_run_events: await count('flow_run_events'),
    contact_tags: await count('contact_tags'),
    payment_links: await count('payment_links'),
    appointments: await count('appointments'),
    capi_events: await count('capi_events'),
    jobs: await count('jobs', 'tenant_id'),
    contact: (await q('SELECT updated_at, company FROM contacts WHERE id=$1', [contactId])).rows[0],
    flow: (await q('SELECT updated_at, status, published_version_id FROM flows WHERE id=$1', [flowId])).rows[0],
    audit: await count('audit_logs'),
  };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('flow dry run on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: ownerUrl });
    await db.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    for (const id of [owner, agent]) {
      await q("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Dry','test-only-hash')", [id, `${id}@example.invalid`]);
    }
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Dry',$2)", [A, owner]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [A, owner]);
    await q("INSERT INTO account_memberships(account_id,user_id,role,mask_phone_numbers) VALUES($1,$2,'agent',true)", [A, agent]);
    await q(`INSERT INTO flows(id,account_id,user_id,name,status,trigger_type,trigger_config,entry_node_id)
      VALUES($1,$2,$3,'Dry','draft','keyword','{"keywords":["dry"]}','start')`, [flowId, A, owner]);
    for (const n of NODES) {
      await q('INSERT INTO flow_nodes(account_id,flow_id,node_key,node_type,config) VALUES($1,$2,$3,$4,$5)', [A, flowId, n.node_key, n.node_type, JSON.stringify(n.config)]);
    }
    await q("INSERT INTO tags(id,account_id,user_id,name) VALUES($1,$2,$3,'vip')", [tagId, A, owner]);
    await q("INSERT INTO contacts(id,account_id,user_id,name,phone,company) VALUES($1,$2,$3,'Asha',$4,'Clinic')", [contactId, A, owner, phone]);
    await q("INSERT INTO conversations(id,account_id,user_id,contact_id,status) VALUES($1,$2,$3,$4,'open')", [conversationId, A, owner, contactId]);
    await q('INSERT INTO contact_tags(account_id,contact_id,tag_id) VALUES($1,$2,$3)', [A, contactId, tagId]);
    await q("INSERT INTO workspace_attributes(account_id,key,value,is_secret) VALUES($1,'shop','Acme',false)", [A]);
    await q("INSERT INTO workspace_attributes(account_id,key,value,value_encrypted,is_secret) VALUES($1,'api_token',NULL,'opaque-ciphertext',true)", [A]);
    h.ctx = { accountId: A, userId: agent, role: 'agent' };
  });
  afterAll(async () => {
    if (db) {
      await q('DELETE FROM jobs WHERE tenant_id=$1', [A]).catch(() => undefined);
      await q('DELETE FROM accounts WHERE id=$1', [A]).catch(() => undefined);
      await q('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[owner, agent]]).catch(() => undefined);
      await db.end();
    }
    await disconnectDatabases();
  });

  it('walks every side-effecting step and changes nothing but one audit row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = await snapshot();
    const res = await POST(new Request('http://localhost/api/flows/x/dry-run', {
      method: 'POST',
      body: JSON.stringify({ source: 'draft', contact_id: contactId, inputs: [{ option_id: 'paid' }, { option_id: 'success' }], api_ports: { api: 'route:0' } }),
    }), { params: Promise.resolve({ id: flowId }) });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.ended).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.notes.map((n: { code: string }) => n.code)).toEqual([
      'would_send_message', 'would_send_template', 'would_tag', 'would_set_attribute', 'would_call_api',
      'would_create_payment_link', 'would_book', 'would_send_conversion',
    ]);
    expect(result.trace[0].text).toBe('Hi from Acme [secret]');
    expect(result.notes.find((n: { code: string }) => n.code === 'would_call_api').params).toEqual({ method: 'POST', host: 'crm.example.com' });
    // The condition on the contact's tag was evaluated, not asked.
    expect(result.trace.some((m: { note?: string; detail?: string }) => m.note === 'condition_result' && m.detail === 'true')).toBe(true);
    // A masked agent sees only the masked number.
    expect(result.contact.phone).not.toBe(phone);
    expect(result.contact.phone).not.toContain(phone.slice(0, 8));
    expect(JSON.stringify(result)).not.toContain('opaque-ciphertext');

    const after = await snapshot();
    expect(after).toEqual({ ...before, audit: before.audit + 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const audit = (await q("SELECT user_id, metadata FROM audit_logs WHERE account_id=$1 AND action='flows.dry_run'", [A])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe(agent);
    expect(audit[0].metadata).toMatchObject({ flow_id: flowId, source: 'draft', with_contact: true });
    expect(JSON.stringify(audit[0].metadata)).not.toContain('Acme');
  });

  it('dry-runs a published version and refuses another workspace\'s or a missing source', async () => {
    const version = await withTenant({ accountId: A, userId: owner, role: 'owner' }, (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO flow_versions(flow_id,version,trigger_type,trigger_config,entry_node_id,fallback_policy,channel_scope,nodes,published_by)
      VALUES(${flowId}::uuid,1,'keyword','{"keywords":["dry"]}'::jsonb,'start','{}'::jsonb,'whatsapp',
        ${JSON.stringify([NODES[0], { ...NODES[1], config: { text: 'Version one', next_node_key: 'done' } }, NODES[10]])}::jsonb,${owner}::uuid)
      RETURNING id::text`);
    const call = (body: unknown, id = flowId) => POST(new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) });
    const ok = await call({ source: version[0].id });
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.version).toBe(1);
    expect(json.trace[0].text).toBe('Version one');
    // No published version is set on the flow itself.
    expect((await call({ source: 'published' })).status).toBe(409);
    expect((await call({ source: randomUUID() })).status).toBe(404);
    expect((await call({}, randomUUID())).status).toBe(404);
    expect((await call({ contact_id: randomUUID() })).status).toBe(404);
  });

  it('inside withDryRun, a worker write raises 25006 and jobs, sends and fetches throw first', async () => {
    const scope = { accountId: A, role: 'owner' as const };
    const send = vi.fn(async () => ({ ok: true }));
    await withDryRun(async () => {
      const write = await withTenant(scope, (tx) => tx.$executeRaw`UPDATE contacts SET company='X' WHERE id=${contactId}::uuid`, getWorkerPrisma())
        .then(() => null, (e: unknown) => e);
      expect(String((write as { message?: string })?.message ?? write)).toMatch(/25006|read-only/i);
      await expect(enqueueJob('flow.sweep', {}, { tenantId: A })).rejects.toBeInstanceOf(DryRunSideEffectError);
      await expect(dispatchOnce(A, `dry:${randomUUID()}`, send)).rejects.toBeInstanceOf(DryRunSideEffectError);
      await expect(safeFetch('https://example.com/', { method: 'GET', headers: {} })).rejects.toBeInstanceOf(DryRunSideEffectError);
    });
    expect(send).not.toHaveBeenCalled();
    expect((await q('SELECT company FROM contacts WHERE id=$1', [contactId])).rows[0].company).toBe('Clinic');
  });
});
