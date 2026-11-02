import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { exportContactsCsv } from '@/lib/audience/export';
import { createList } from '@/lib/audience/lists';
import { createSegment, previewAudience } from '@/lib/audience/segments';
import { createApiCampaign } from '@/lib/broadcasts/api-campaign';
import { createCampaign } from '@/lib/broadcasts/create-campaign';
import { saveAttribute } from '@/lib/workspace/attributes';
import { getEntitlements, PlanLimitError } from './entitlements';
import { currentUsage } from './usage';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), admin = randomUUID(), templateId = randomUUID(), pastCampaign = randomUUID();
const plan = `tiny_${randomUUID().slice(0, 8)}`;
const a: TenantContext = { accountId: account, userId: admin, role: 'admin' };
let owner: pg.Client;
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('plan entitlements on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) VALUES($1,$2,'Plan test','test-only-hash')", [admin, `${admin}@example.invalid`]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Plans A',$2)", [account, admin]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin')", [account, admin]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'plan_template','Hi','APPROVED')", [templateId, account, admin]);
    await owner.query("INSERT INTO contacts(account_id,user_id,name,phone) VALUES($1,$2,'P1','14159990001'),($1,$2,'P2','14159990002')", [account, admin]);
    await owner.query("INSERT INTO broadcasts(id,account_id,user_id,name,template_name,status) VALUES($1,$2,$3,'Past','plan_template','sent')", [pastCampaign, account, admin]);
    // A deliberately small plan: no premium features, room for one segment, one list, one recipient.
    await owner.query(`INSERT INTO plans(id,name,features,limits) VALUES($1,'Tiny','{}','{"segments":1,"lists":1,"campaign_recipients":1,"seats":1}')`, [plan]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM jobs WHERE tenant_id=$1', [account]);
      await owner.query('DELETE FROM accounts WHERE id=$1', [account]);
      await owner.query('DELETE FROM auth_users WHERE id=$1', [admin]);
      await owner.query('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('leaves a workspace without a subscription unrestricted', async () => {
    const e = await withTenant(a, (tx) => getEntitlements(tx, account));
    expect(e.planId).toBe('enterprise');
    expect(Object.values(e.features).every(Boolean)).toBe(true);
    expect(Object.values(e.limits).every((v) => v === null)).toBe(true);
    const { id } = await createCampaign(a, { name: 'Free to schedule', templateId, audience: { type: 'all' }, variables: {}, scheduledAt: inMinutes(30) });
    expect(id).toBeTruthy();
  });

  it('enforces a smaller plan on every gated action through the server API', async () => {
    await owner.query('INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,$2)', [account, plan]);
    const refused = expect.any(PlanLimitError);

    await expect(createCampaign(a, { name: 'Later', templateId, audience: { type: 'all' }, variables: {}, scheduledAt: inMinutes(30) })).rejects.toEqual(refused);
    // Two contacts match but the plan allows one recipient per campaign.
    await expect(createCampaign(a, { name: 'Too big', templateId, audience: { type: 'all' }, variables: {} })).rejects.toThrow(/up to 1 recipients per campaign/);
    await expect(createApiCampaign(a, { name: 'API', templateId })).rejects.toEqual(refused);
    await expect(exportContactsCsv(a, null)).rejects.toEqual(refused);
    await expect(saveAttribute(a, { key: 'k', value: 'v' })).rejects.toEqual(refused);
    await expect(previewAudience(a, { filter: { conditions: [{ field: 'campaign', broadcastId: pastCampaign, op: 'read' }] } })).rejects.toEqual(refused);

    await createSegment(a, { name: 'One', filter: { conditions: [{ field: 'name', op: 'is_not_empty' }] } });
    await expect(createSegment(a, { name: 'Two', filter: { conditions: [{ field: 'name', op: 'is_empty' }] } })).rejects.toThrow(/up to 1 saved segments/);
    await createList(a, { name: 'One' });
    await expect(createList(a, { name: 'Two' })).rejects.toEqual(refused);

    const usage = await withTenant(a, (tx) => currentUsage(tx, account));
    expect(usage).toMatchObject({ seats: 1, segments: 1, lists: 1 });
    // A refused action leaves nothing behind.
    expect((await owner.query("SELECT count(*)::int AS n FROM broadcasts WHERE account_id=$1 AND name IN ('Later','Too big','API')", [account])).rows[0].n).toBe(0);
  });

  it('drops a cancelled subscription to the free plan', async () => {
    await owner.query("UPDATE account_subscriptions SET status='cancelled' WHERE account_id=$1", [account]);
    const e = await withTenant(a, (tx) => getEntitlements(tx, account));
    expect(e).toMatchObject({ planId: 'free', limits: { seats: 1, segments: 3 } });
    expect(e.features.campaign_scheduling).toBe(false);
  });
});
