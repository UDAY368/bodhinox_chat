import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminClient } from '@/lib/data/admin';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { addApiCampaignRecipients, createApiCampaign } from './api-campaign';
import { recordClick } from './clicks';
import { createCampaign } from './create-campaign';
import { appOrigin } from './tracking';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), other = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const trackedTemplate = randomUUID(), plainTemplate = randomUUID();
const a: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const b: TenantContext = { accountId: other, userId: outsider, role: 'owner' };
let owner: pg.Client;

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('click tracking and API campaigns on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Track test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Track A',$2),($3,'Track B',$4)", [account, agent, other, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [account, agent, other, outsider]);
    const buttons = JSON.stringify([{ type: 'URL', text: 'Shop now', url: `${appOrigin()}/r/{{1}}`, example: 'abc' }]);
    await owner.query(`INSERT INTO message_templates(id,account_id,user_id,name,body_text,status,buttons) VALUES
      ($1,$3,$4,'tracked_template','Sale is live','APPROVED',$5::jsonb),($2,$3,$4,'plain_template','Hello {{1}}','APPROVED',NULL)`, [trackedTemplate, plainTemplate, account, agent, buttons]);
    await owner.query(`INSERT INTO contacts(account_id,user_id,name,phone,opted_out_at) VALUES
      ($1,$2,'Track 1','14158880001',NULL),($1,$2,'Track 2','14158880002',NULL),($1,$2,'Track 3','14158880003',now())`, [account, agent]);
    await owner.query("INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,access_token) VALUES($1,$2,'pn-track','not-used-in-tests')", [account, agent]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id = ANY($1::uuid[])', [[account, other]]);
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[account, other]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[agent, outsider]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('gives each recipient of a tracked campaign a token and counts each person once', async () => {
    await expect(createCampaign(a, { name: 'No link', templateId: trackedTemplate, audience: { type: 'all' }, variables: {} }))
      .rejects.toThrow(/tracks link clicks/);
    await expect(createCampaign(a, { name: 'Bad link', templateId: trackedTemplate, audience: { type: 'all' }, variables: {}, trackedUrl: 'http://shop.example' }))
      .rejects.toMatchObject({ status: 400 });
    const { id } = await createCampaign(a, { name: 'Sale', templateId: trackedTemplate, audience: { type: 'all' }, variables: {}, trackedUrl: 'https://shop.example/sale' });
    const rows = (await owner.query('SELECT id, click_token FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY id', [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => /^[0-9a-f]{32}$/.test(r.click_token))).toBe(true);
    expect(new Set(rows.map((r) => r.click_token)).size).toBe(2);

    expect(await recordClick(rows[0].click_token, '203.0.113.9')).toBe('https://shop.example/sale');
    expect(await recordClick(rows[0].click_token, '203.0.113.9')).toBe('https://shop.example/sale');
    expect(await recordClick(rows[1].click_token, null)).toBe('https://shop.example/sale');
    const campaign = (await owner.query('SELECT click_count, tracked_url FROM broadcasts WHERE id=$1', [id])).rows[0];
    expect(campaign).toEqual({ click_count: 2, tracked_url: 'https://shop.example/sale' });
    const clicks = (await owner.query('SELECT ip_hash FROM broadcast_clicks WHERE broadcast_id=$1', [id])).rows;
    expect(clicks).toHaveLength(3);
    expect(clicks.some((c) => c.ip_hash?.includes('203.0.113.9'))).toBe(false);

    expect(await recordClick('0'.repeat(32), null)).toBeNull();
    expect(await recordClick("x' OR '1'='1", null)).toBeNull();
  });

  it('adds API batches to one campaign, sending repeats once and rejecting bad or opted-out numbers', async () => {
    await expect(createApiCampaign(a, { name: 'Tracked API', templateId: trackedTemplate })).rejects.toThrow(/Click-tracked/);
    // A link button with its own variable could never be filled by the API.
    const dynamicLink = randomUUID();
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status,buttons) VALUES($1,$2,$3,'dynamic_link','Hi','APPROVED',$4::jsonb)",
      [dynamicLink, account, agent, JSON.stringify([{ type: 'URL', text: 'Open', url: 'https://shop.example/{{1}}', example: 'a' }])]);
    await expect(createApiCampaign(a, { name: 'Dynamic', templateId: dynamicLink })).rejects.toThrow(/cannot supply/);
    const { id } = await createApiCampaign(a, { name: 'Orders API', templateId: plainTemplate });
    expect((await owner.query('SELECT kind, status, total_recipients FROM broadcasts WHERE id=$1', [id])).rows[0])
      .toEqual({ kind: 'api', status: 'sent', total_recipients: 0 });

    const db = createAdminClient({ accountId: account, role: 'owner' });
    const first = await addApiCampaignRecipients(db, account, agent, id, [
      { to: '+14158880001', params: ['One'] }, { to: '+14158880001', params: ['Dup'] }, { to: '4158880002' }, { to: '+14158880003', params: ['Out'] },
    ]);
    // The in-batch repeat is sent once; the malformed and opted-out numbers are rejected.
    expect(first).toEqual({ accepted: 1, rejected: 2, duplicates: 0 });
    // A retried batch (lost 202) sends nobody twice.
    expect(await addApiCampaignRecipients(db, account, agent, id, [{ to: '+14158880001', params: ['One'] }]))
      .toEqual({ accepted: 0, rejected: 0, duplicates: 1 });
    // A recipient missing the template's {{1}} value is rejected, not queued to fail.
    expect(await addApiCampaignRecipients(db, account, agent, id, [{ to: '+14158880002' }, { to: '+14158880002', params: ['  '] }]))
      .toEqual({ accepted: 0, rejected: 1, duplicates: 0 });
    const second = await addApiCampaignRecipients(db, account, agent, id, [{ to: '+14158880002', params: ['Two'] }]);
    expect(second).toEqual({ accepted: 1, rejected: 0, duplicates: 0 });
    expect((await owner.query('SELECT total_recipients FROM broadcasts WHERE id=$1', [id])).rows[0].total_recipients).toBe(2);
    expect((await owner.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id=$1 AND dedupe_key LIKE $2", [account, `broadcast:${id}:api:%`])).rows[0].n).toBe(2);
    expect((await owner.query('SELECT template_params FROM broadcast_recipients WHERE broadcast_id=$1 ORDER BY created_at', [id])).rows.map((r) => r.template_params))
      .toEqual([['One'], ['Two']]);

    const standard = await createCampaign(a, { name: 'Standard', templateId: plainTemplate, audience: { type: 'all' }, variables: { '1': { type: 'static', value: 'x' } } });
    await expect(addApiCampaignRecipients(db, account, agent, standard.id, [{ to: '+14158880001' }])).rejects.toMatchObject({ status: 409 });
    await expect(addApiCampaignRecipients(createAdminClient({ accountId: other, role: 'owner' }), other, outsider, id, [{ to: '+14158880001' }]))
      .rejects.toMatchObject({ status: 404 });
    await expect(createApiCampaign(b, { name: 'Steal', templateId: plainTemplate })).rejects.toMatchObject({ status: 404 });
    await expect(addApiCampaignRecipients(db, account, agent, id, [])).rejects.toMatchObject({ status: 400 });
  });
});
