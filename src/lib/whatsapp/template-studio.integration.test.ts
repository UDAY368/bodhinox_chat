import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const templateA = randomUUID(), templateB = randomUUID();
const asAdmin: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: outsider, role: 'owner' };
let owner: pg.Client;

const insertEvent = (ctx: TenantContext, templateId: string, status = 'PENDING', source = 'submit') =>
  withTenant(ctx, (tx) => tx.$executeRaw`
    INSERT INTO template_status_events(template_id,status,source) VALUES(${templateId}::uuid,${status},${source})`);
const listEvents = (ctx: TenantContext) =>
  withTenant(ctx, (tx) => tx.$queryRaw<{ template_id: string; status: string; account_id: string }[]>`
    SELECT template_id::text, status, account_id::text FROM template_status_events ORDER BY created_at`);

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('template studio schema on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Template studio test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[admin, agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Studio A',$2),($3,'Studio B',$4)", [accountA, admin, accountB, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')", [accountA, admin, agent, accountB, outsider]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text) VALUES($1,$2,$3,'studio_a','Hi'),($4,$5,$6,'studio_b','Hi')", [templateA, accountA, admin, templateB, accountB, outsider]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('defaults existing templates to the standard kind and constrains the new columns', async () => {
    const row = (await owner.query('SELECT template_kind, cards, auth_options, lto FROM message_templates WHERE id=$1', [templateA])).rows[0];
    expect(row).toEqual({ template_kind: 'standard', cards: null, auth_options: null, lto: null });
    await expect(owner.query("UPDATE message_templates SET template_kind='poll' WHERE id=$1", [templateA])).rejects.toThrow(/template_kind/);
    await expect(owner.query(`UPDATE message_templates SET cards='{"a":1}' WHERE id=$1`, [templateA])).rejects.toThrow(/cards/);
    await expect(owner.query("UPDATE message_templates SET cards=(SELECT jsonb_agg(x) FROM generate_series(1,11) x) WHERE id=$1", [templateA])).rejects.toThrow(/cards/);
    await expect(owner.query("UPDATE message_templates SET lto='[]' WHERE id=$1", [templateA])).rejects.toThrow(/lto/);
    await expect(owner.query("UPDATE message_templates SET header_type='sticker' WHERE id=$1", [templateA])).rejects.toThrow(/header_type/);
    await owner.query(`UPDATE message_templates SET header_type='location', template_kind='carousel',
      cards='[{"header_type":"image","body_text":"x","buttons":[]}]', auth_options='{"otp_type":"COPY_CODE"}',
      lto='{"text":"Sale","has_expiration":true}' WHERE id=$1`, [templateA]);
    await owner.query("UPDATE message_templates SET header_type=NULL, template_kind='standard', cards=NULL, auth_options=NULL, lto=NULL WHERE id=$1", [templateA]);
  });

  it('records status events for admins and the worker, scoped to the account', async () => {
    expect(await insertEvent(asAdmin, templateA, 'DRAFT', 'draft')).toBe(1);
    await withTenant(asAdmin, (tx) => tx.$executeRaw`
      INSERT INTO template_status_events(template_id,status,source) VALUES(${templateA}::uuid,'PENDING','submit')`, getWorkerPrisma());
    const rows = await listEvents(asAdmin);
    expect(rows.map((r) => [r.template_id, r.status])).toEqual([[templateA, 'DRAFT'], [templateA, 'PENDING']]);
    expect(rows.every((r) => r.account_id === accountA)).toBe(true);
    // Members below admin can read the history but not write it.
    expect(await listEvents(asAgent)).toHaveLength(2);
    await expect(insertEvent(asAgent, templateA)).rejects.toThrow();
    // Another account sees none of it.
    expect(await listEvents(asB)).toEqual([]);
  });

  it('refuses cross-account templates, unknown sources and any rewrite of history', async () => {
    await expect(insertEvent(asAdmin, templateB)).rejects.toThrow();
    await expect(insertEvent(asAdmin, templateA, 'APPROVED', 'magic')).rejects.toThrow();
    await expect(withTenant(asB, (tx) => tx.$executeRaw`
      INSERT INTO template_status_events(account_id,template_id,status,source) VALUES(${accountA}::uuid,${templateA}::uuid,'APPROVED','webhook')`)).rejects.toThrow();
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`UPDATE template_status_events SET status='APPROVED'`)).rejects.toThrow(/permission denied/);
    await expect(withTenant(asAdmin, (tx) => tx.$executeRaw`DELETE FROM template_status_events`)).rejects.toThrow(/permission denied/);
  });

  it('removes the history with its template', async () => {
    await owner.query('DELETE FROM message_templates WHERE id=$1', [templateA]);
    expect((await owner.query('SELECT count(*)::int AS n FROM template_status_events WHERE template_id=$1', [templateA])).rows[0].n).toBe(0);
  });
});
