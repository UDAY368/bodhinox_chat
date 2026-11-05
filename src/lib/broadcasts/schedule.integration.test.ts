import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantContext } from '@/lib/db/tenant';
import { createCampaign, parseSchedule } from './create-campaign';
import { handleJob } from '@/lib/jobs/handlers';
import {
  broadcastDispatchable, cancelScheduledBroadcast, claimBroadcastStart, lockBroadcastDelivery, rescheduleBroadcast, unlockBroadcastDelivery,
} from './schedule';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), other = randomUUID(), agent = randomUUID(), outsider = randomUUID();
const templateId = randomUUID(), tier = randomUUID();
const a: TenantContext = { accountId: account, userId: agent, role: 'agent' };
const b: TenantContext = { accountId: other, userId: outsider, role: 'owner' };
const CONTACTS = 2_500;
let owner: pg.Client;

const campaign = (scheduledAt?: string) => ({
  name: 'Big campaign', templateId, audience: { type: 'all' as const },
  variables: { '1': { type: 'field' as const, value: 'name' as const }, '2': { type: 'custom_field' as const, value: tier }, '3': { type: 'static' as const, value: 'Diwali' } },
  ...(scheduledAt ? { scheduledAt } : {}),
});
const inMinutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const row = async (id: string) => (await owner.query('SELECT status, scheduled_at, total_recipients FROM broadcasts WHERE id=$1', [id])).rows[0];
const job = async (id: string) => (await owner.query('SELECT status, run_at FROM jobs WHERE dedupe_key=$1', [`broadcast:${id}:initial`])).rows[0];

describe('parseSchedule', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  it('accepts 1 minute to 90 days ahead and nothing else', () => {
    expect(parseSchedule(undefined, now)).toBeNull();
    expect(parseSchedule('2026-11-02T10:05:00Z', now)?.toISOString()).toBe('2026-11-02T10:05:00.000Z');
    expect(() => parseSchedule('2026-11-02T10:00:30Z', now)).toThrow(/at least one minute/);
    expect(() => parseSchedule('2027-03-01T10:00:00Z', now)).toThrow(/90 days/);
    // Unparseable or zone-less times are a 400, never a server error or a guessed zone.
    expect(() => parseSchedule('tomorrow', now)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseSchedule('2026-11-05T10:00', now)).toThrow(/valid date/);
  });
});

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('scheduled and large campaigns on PostgreSQL', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
    if (!/test/i.test(app[0].name)) throw new Error('Requires constrained test app credentials');
    await getWorkerPrisma().$queryRaw`SELECT 1`;
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Schedule test', 'test-only-hash' FROM unnest($1::uuid[]) x", [[agent, outsider]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Schedule A',$2),($3,'Schedule B',$4)", [account, agent, other, outsider]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'agent'),($3,$4,'owner')", [account, agent, other, outsider]);
    await owner.query("INSERT INTO custom_fields(id,account_id,user_id,field_name) VALUES($1,$2,$3,'Tier')", [tier, account, agent]);
    await owner.query("INSERT INTO message_templates(id,account_id,user_id,name,body_text,status) VALUES($1,$2,$3,'big_template','Hi {{1}}, {{2}} {{3}}','APPROVED')", [templateId, account, agent]);
    // n=1 is opted out, n=2 blocked; both must be left out.
    await owner.query(`INSERT INTO contacts(account_id,user_id,name,phone,opted_out_at,blocked_at)
      SELECT $1,$2,'Contact '||n,'1415'||lpad(n::text,7,'0'),CASE WHEN n=1 THEN now() END,CASE WHEN n=2 THEN now() END
      FROM generate_series(1,$3::int) n`, [account, agent, CONTACTS]);
    await owner.query("INSERT INTO contact_custom_values(account_id,contact_id,custom_field_id,value) SELECT $1,id,$2,'Gold' FROM contacts WHERE account_id=$1 AND name='Contact 3'", [account, tier]);
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

  it('creates a campaign above the old 1,000 cap with parameters resolved per contact in SQL', async () => {
    const { id } = await createCampaign(a, campaign());
    expect(await row(id)).toMatchObject({ status: 'sending', total_recipients: CONTACTS - 2 });
    const params = (await owner.query(`SELECT c.name, r.template_params FROM broadcast_recipients r JOIN contacts c ON c.id=r.contact_id
      WHERE r.broadcast_id=$1 AND c.name IN ('Contact 3','Contact 4') ORDER BY c.name`, [id])).rows;
    expect(params).toEqual([
      { name: 'Contact 3', template_params: ['Contact 3', 'Gold', 'Diwali'] },
      { name: 'Contact 4', template_params: ['Contact 4', '', 'Diwali'] },
    ]);
    expect((await owner.query("SELECT count(*)::int AS n FROM broadcast_recipients r JOIN contacts c ON c.id=r.contact_id WHERE r.broadcast_id=$1 AND c.name IN ('Contact 1','Contact 2')", [id])).rows[0].n).toBe(0);
    expect(await job(id)).toMatchObject({ status: 'pending' });
  });

  it('holds a scheduled campaign until its time, then reschedules and cancels it without sending', async () => {
    const at = inMinutes(30);
    const { id } = await createCampaign(a, campaign(at));
    expect(await row(id)).toMatchObject({ status: 'scheduled' });
    expect((await job(id)).run_at.toISOString()).toBe(new Date(at).toISOString());
    // Not due yet: the dispatcher sends nothing.
    expect(await claimBroadcastStart(account, id)).toBe(false);

    const later = inMinutes(120);
    await rescheduleBroadcast(a, id, later);
    expect((await job(id)).run_at.toISOString()).toBe(new Date(later).toISOString());
    await expect(rescheduleBroadcast(a, id, inMinutes(0))).rejects.toThrow(/at least one minute/);
    // Another workspace's id is answered as not found, never as a state conflict.
    await expect(rescheduleBroadcast(b, id, inMinutes(60))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(cancelScheduledBroadcast(b, id)).rejects.toMatchObject({ status: 404, code: 'not_found' });

    expect(await cancelScheduledBroadcast(a, id)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'cancelled' });
    expect(await job(id)).toMatchObject({ status: 'done' });
    expect(await cancelScheduledBroadcast(a, id)).toBe(false);
    expect(await claimBroadcastStart(account, id)).toBe(false);
    await expect(rescheduleBroadcast(a, id, inMinutes(60))).rejects.toThrow(/Only scheduled/);
  });

  it('lets exactly one of a due start and a cancel win', async () => {
    const { id } = await createCampaign(a, campaign(inMinutes(5)));
    await owner.query("UPDATE broadcasts SET scheduled_at=now()-interval '1 second' WHERE id=$1", [id]);
    const [started, cancelled] = await Promise.all([claimBroadcastStart(account, id), cancelScheduledBroadcast(a, id)]);
    expect(started !== cancelled).toBe(true);
    expect((await row(id)).status).toBe(started ? 'sending' : 'cancelled');
  });

  it('allows one delivery pass per campaign at a time and frees a stale lock', async () => {
    const { id } = await createCampaign(a, campaign());
    expect(await lockBroadcastDelivery(account, id)).toBe(true);
    expect(await lockBroadcastDelivery(account, id)).toBe(false);
    expect(await lockBroadcastDelivery(other, id)).toBe(false);
    await unlockBroadcastDelivery(account, id);
    expect(await lockBroadcastDelivery(account, id)).toBe(true);
    await owner.query("UPDATE broadcasts SET delivery_locked_at=now()-interval '31 minutes' WHERE id=$1", [id]);
    expect(await lockBroadcastDelivery(account, id)).toBe(true);
    await unlockBroadcastDelivery(account, id);
  });

  it('skips a cancelled or future campaign and leaves the status alone when planning fails', async () => {
    const dispatch = (broadcastId: string) => handleJob({
      id: randomUUID(), type: 'broadcast.dispatch', tenant_id: account, payload: { broadcastId, scope: 'failed' },
      attempts: 1, max_attempts: 5, lease_token: randomUUID(),
    });
    const future = (await createCampaign(a, campaign(inMinutes(30)))).id;
    await dispatch(future);
    expect(await row(future)).toMatchObject({ status: 'scheduled' });

    // A finished campaign retried while WhatsApp is not configured: the pass fails, the status stays 'sent'.
    const { id } = await createCampaign(a, campaign());
    await owner.query("UPDATE broadcasts SET status='sent' WHERE id=$1", [id]);
    await owner.query("UPDATE broadcast_recipients SET status='failed' WHERE broadcast_id=$1 AND contact_id=(SELECT contact_id FROM broadcast_recipients WHERE broadcast_id=$1 LIMIT 1)", [id]);
    await expect(dispatch(id)).rejects.toMatchObject({ code: 'whatsapp_not_configured' });
    expect(await row(id)).toMatchObject({ status: 'sent' });
    expect((await owner.query('SELECT delivery_locked_at FROM broadcasts WHERE id=$1', [id])).rows[0].delivery_locked_at).toBeNull();
  });

  it('holds a due campaign while the workspace is admin-suspended or closing, and lets it go again once active', async () => {
    const { id } = await createCampaign(a, campaign());
    const pending = async () => Number((await owner.query("SELECT count(*)::int AS n FROM broadcast_recipients WHERE broadcast_id=$1 AND status='pending'", [id])).rows[0].n);
    const before = await pending();
    expect(await broadcastDispatchable(account, id)).toBe(true);
    await owner.query(`INSERT INTO account_lifecycle(account_id,status,suspended_at,suspend_reason) VALUES($1,'admin_suspended',now(),'abuse review')`, [account]);
    expect(await broadcastDispatchable(account, id)).toBe(false);
    // The dispatch job sends nothing for a held campaign (no WhatsApp call, recipients stay pending).
    await handleJob({ id: randomUUID(), type: 'broadcast.dispatch', tenant_id: account, payload: { broadcastId: id },
      attempts: 1, max_attempts: 5, lease_token: randomUUID() });
    expect(await pending()).toBe(before);
    await owner.query(`UPDATE account_lifecycle SET status='closing', deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE account_id=$1`, [account]);
    expect(await broadcastDispatchable(account, id)).toBe(false);
    expect(await broadcastDispatchable(other, id)).toBe(false);
    await owner.query(`UPDATE account_lifecycle SET status='active' WHERE account_id=$1`, [account]);
    expect(await broadcastDispatchable(account, id)).toBe(true);
    await owner.query('DELETE FROM account_lifecycle WHERE account_id=$1', [account]);
  });

  it('refuses to reschedule once the dispatch job has started', async () => {
    const { id } = await createCampaign(a, campaign(inMinutes(10)));
    await owner.query("UPDATE jobs SET status='running' WHERE dedupe_key=$1", [`broadcast:${id}:initial`]);
    await expect(rescheduleBroadcast(a, id, inMinutes(60))).rejects.toThrow(/already starting/);
    expect((await row(id)).scheduled_at.toISOString()).not.toBe(new Date(inMinutes(60)).toISOString());
  });
});
