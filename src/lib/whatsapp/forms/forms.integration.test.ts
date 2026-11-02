import { randomBytes, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { buildQuery } from '@/lib/data/builder';
import { getResource } from '@/lib/data/contracts';
import { executeQuery } from '@/lib/repositories/crm';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), viewer = randomUUID(), outsider = randomUUID();
const contactA = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const asViewer: TenantContext = { accountId: accountA, userId: viewer, role: 'viewer' };
const asB: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
const definition = JSON.stringify({ version: 1, screens: [] });
const token = () => randomBytes(32).toString('base64url');
let owner: pg.Client;
let formA = '', formB = '';

const insertForm = (ctx: TenantContext, name: string, category = 'LEAD_GENERATION', db = getPrisma()) =>
  withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`
    INSERT INTO whatsapp_forms(user_id,name,category,definition)
    VALUES(${ctx.userId}::uuid,${name},${category},${definition}::jsonb) RETURNING id::text`, db).then((rows) => rows[0].id);
const listForms = (ctx: TenantContext, db = getPrisma()) =>
  withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM whatsapp_forms ORDER BY created_at`, db);
const insertSession = (ctx: TenantContext, formId: string, db = getPrisma(), flowToken = token()) =>
  withTenant(ctx, (tx) => tx.$queryRaw<{ id: string }[]>`
    INSERT INTO whatsapp_form_sessions(flow_token,form_id,contact_id,expires_at)
    VALUES(${flowToken},${formId}::uuid,${ctx.accountId === accountA ? contactA : null}::uuid,now() + interval '1 day')
    RETURNING id::text`, db).then((rows) => rows[0].id);
const insertResponse = (ctx: TenantContext, formId: string | null, sessionId: string | null, messageId: string, db = getPrisma()) =>
  withTenant(ctx, (tx) => tx.$executeRaw`
    INSERT INTO whatsapp_form_responses(form_id,session_id,message_id,response)
    VALUES(${formId}::uuid,${sessionId}::uuid,${messageId},'{"name":"Ana"}'::jsonb)
    ON CONFLICT (account_id, message_id) DO NOTHING`, db);
const browser = (ctx: TenantContext) => (table: string) => buildQuery(table, (spec) => executeQuery(spec, ctx, true));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('WhatsApp forms schema on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Forms test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, viewer, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Forms A',$2),($3,'Forms B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($1,$4,'viewer'),($5,$6,'owner')",
      [accountA, admin, agent, viewer, accountB, outsider]);
    await owner.query("INSERT INTO contacts(id,account_id,user_id,phone) VALUES($1,$2,$3,'15550001111')", [contactA, accountA, admin]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, viewer, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets admins write forms, members read them and the worker only read', async () => {
    formA = await insertForm(asAdmin, 'Lead form');
    formB = await insertForm(asB, 'Lead form');
    expect((await listForms(asViewer)).map((r) => r.id)).toEqual([formA]);
    expect((await listForms(asAdmin, getWorkerPrisma())).map((r) => r.id)).toEqual([formA]);
    expect((await listForms(asB)).map((r) => r.id)).toEqual([formB]);
    await expect(insertForm(asAgent, 'Agent form')).rejects.toThrow();
    await expect(insertForm(asAdmin, 'Worker form', 'OTHER', getWorkerPrisma())).rejects.toThrow(/permission denied/);
    // An agent's update matches no rows; another account cannot touch the form.
    expect(await withTenant(asAgent, (tx) => tx.$executeRaw`UPDATE whatsapp_forms SET status='published' WHERE id=${formA}::uuid`)).toBe(0);
    expect(await withTenant(asB, (tx) => tx.$executeRaw`UPDATE whatsapp_forms SET status='published' WHERE id=${formA}::uuid`)).toBe(0);
    await expect(withTenant(asB, (tx) => tx.$executeRaw`
      INSERT INTO whatsapp_forms(account_id,user_id,name,category,definition)
      VALUES(${accountA}::uuid,${outsider}::uuid,'Smuggled','OTHER',${definition}::jsonb)`)).rejects.toThrow();
    const row = (await owner.query('SELECT status, uses_endpoint, updated_at FROM whatsapp_forms WHERE id=$1', [formA])).rows[0];
    expect(row).toMatchObject({ status: 'draft', uses_endpoint: false });
  });

  it('constrains names, categories, statuses and JSON shapes', async () => {
    await expect(insertForm(asAdmin, 'Lead form')).rejects.toThrow();
    await expect(insertForm(asAdmin, 'Bad category', 'MARKETING')).rejects.toThrow();
    await expect(owner.query("UPDATE whatsapp_forms SET status='live' WHERE id=$1", [formA])).rejects.toThrow(/status/);
    await expect(owner.query("UPDATE whatsapp_forms SET definition='[]' WHERE id=$1", [formA])).rejects.toThrow(/definition/);
    await expect(owner.query("UPDATE whatsapp_forms SET validation_errors='{}' WHERE id=$1", [formA])).rejects.toThrow(/validation_errors/);
    await expect(owner.query("UPDATE whatsapp_forms SET name='' WHERE id=$1", [formA])).rejects.toThrow(/name/);
    const before = (await owner.query('SELECT updated_at FROM whatsapp_forms WHERE id=$1', [formA])).rows[0].updated_at as Date;
    await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE whatsapp_forms SET status='published', published_at=now() WHERE id=${formA}::uuid`);
    const after = (await owner.query('SELECT updated_at FROM whatsapp_forms WHERE id=$1', [formA])).rows[0].updated_at as Date;
    expect(after.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('issues sessions for agents and the worker, scoped to the account and its own forms', async () => {
    const byAgent = await insertSession(asAgent, formA);
    const byWorker = await insertSession(asAdmin, formA, getWorkerPrisma());
    await expect(insertSession(asViewer, formA)).rejects.toThrow();
    // Account B cannot attach a session to account A's form (composite FK under its own account).
    await expect(insertSession(asB, formA)).rejects.toThrow();
    await expect(insertSession(asAgent, formA, getPrisma(), 'short')).rejects.toThrow(/flow_token/);
    const reused = token();
    await insertSession(asAgent, formA, getPrisma(), reused);
    await expect(insertSession(asB, formB, getPrisma(), reused)).rejects.toThrow();
    expect(await withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE whatsapp_form_sessions SET completed_at=now() WHERE id=${byAgent}::uuid`, getWorkerPrisma())).toBe(1);
    expect(await withTenant(asB, (tx) => tx.$executeRaw`UPDATE whatsapp_form_sessions SET completed_at=now() WHERE id=${byWorker}::uuid`)).toBe(0);
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`DELETE FROM whatsapp_form_sessions WHERE id=${byWorker}::uuid`)).rejects.toThrow(/permission denied/);
    const visible = await withTenant(asViewer, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_form_sessions`);
    expect(visible[0].n).toBe(3);
    const foreign = await withTenant(asB, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM whatsapp_form_sessions`);
    expect(foreign[0].n).toBe(0);
  });

  it('stores each submission once per inbound message and keeps it after the form is deleted', async () => {
    const session = await insertSession(asAgent, formA);
    expect(await insertResponse(asAdmin, formA, session, 'wamid.R1', getWorkerPrisma())).toBe(1);
    expect(await insertResponse(asAgent, formA, session, 'wamid.R1')).toBe(0);
    expect(await insertResponse(asB, formB, null, 'wamid.R1')).toBe(1);
    await expect(insertResponse(asViewer, formA, null, 'wamid.R2')).rejects.toThrow();
    await expect(insertResponse(asB, formA, null, 'wamid.R3')).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE whatsapp_form_responses SET response='{}'::jsonb`)).rejects.toThrow(/permission denied/);
    const own = await withTenant(asViewer, (tx) => tx.$queryRaw<{ message_id: string }[]>`SELECT message_id FROM whatsapp_form_responses`);
    expect(own.map((r) => r.message_id)).toEqual(['wamid.R1']);

    await withTenant(asAdmin, (tx) => tx.$executeRaw`DELETE FROM whatsapp_forms WHERE id=${formA}::uuid`);
    const kept = (await owner.query('SELECT form_id, session_id, response FROM whatsapp_form_responses WHERE account_id=$1', [accountA])).rows;
    expect(kept).toEqual([{ form_id: null, session_id: null, response: { name: 'Ana' } }]);
    expect((await owner.query('SELECT count(*)::int AS n FROM whatsapp_form_sessions WHERE account_id=$1', [accountA])).rows[0].n).toBe(0);
  });

  it('accepts the send_form node and form events in flows', async () => {
    const defs = (await owner.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('flow_nodes_node_type_check','flow_run_events_event_type_check')`)).rows as { conname: string; def: string }[];
    const byName = Object.fromEntries(defs.map((d) => [d.conname, d.def]));
    expect(byName.flow_nodes_node_type_check).toContain("'send_form'");
    expect(byName.flow_nodes_node_type_check).toContain("'assign_agent'");
    expect(byName.flow_run_events_event_type_check).toContain("'form_sent'");
    expect(byName.flow_run_events_event_type_check).toContain("'form_submitted'");
    expect(byName.flow_run_events_event_type_check).toContain("'agent_assigned'");
  });

  it('never exposes the forms key columns through the browser resource layer', async () => {
    const read = getResource('whatsapp_config', true).read;
    expect(read).not.toContain('forms_public_key');
    expect(read).not.toContain('forms_private_key_enc');
    expect(read).toContain('forms_key_uploaded_at');
    const phone = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
    await owner.query(`INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token,forms_public_key,forms_private_key_enc,forms_key_uploaded_at)
      VALUES($1,$2,$3,'fixture-unused-encrypted-value','-----BEGIN PUBLIC KEY-----test','fixture-encrypted-private-key',now())`, [accountA, admin, phone]);
    const db = browser(asAdmin);
    expect((await db('whatsapp_config').select('forms_private_key_enc')).error).not.toBeNull();
    expect((await db('whatsapp_config').select('forms_public_key')).error).not.toBeNull();
    const all = await db('whatsapp_config').select('*');
    expect(all.error).toBeNull();
    const rows = all.data as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('forms_private_key_enc');
    expect(rows[0]).not.toHaveProperty('forms_public_key');
    expect(rows[0].forms_key_uploaded_at).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain('fixture-encrypted-private-key');
    // The new tables have no generic browser resource at all.
    for (const table of ['whatsapp_forms', 'whatsapp_form_sessions', 'whatsapp_form_responses']) {
      expect(() => getResource(table, true)).toThrow();
    }
  });
});
