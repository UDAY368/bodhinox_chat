import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { PlanLimitError } from '@/lib/billing/entitlements';
import { requireScheduledSendingAllowed } from '@/lib/automations/schedule-gate';
import { handleJob } from './handlers';
import type { Job } from './queue';

// A time_based automation that sends to an audience is a recurring campaign:
// it needs campaign_scheduling and must fit campaign_recipients, on save and
// on every occurrence (the plan can change after activation).
const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const account = randomUUID(), user = randomUUID(), automation = randomUUID();
const contacts = [randomUUID(), randomUUID()];
const plan = `test_sched_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
const sendStep = { step_type: 'send_template', step_config: { template_name: 'promo' } };
let owner: pg.Client;
let minute = 0;
const q = (sql: string, params: unknown[] = []) => owner.query(sql, params);

function scheduleJob(): { job: Job; slot: string } {
  const slot = new Date(Date.UTC(2026, 9, 20, 9, minute++)).toISOString();
  return {
    slot,
    job: { id: randomUUID(), type: 'automation.schedule', payload: { minute: slot }, tenant_id: account,
      attempts: 1, max_attempts: 5, lease_token: randomUUID() },
  };
}
async function setPlan(features: Record<string, boolean>, recipients: number) {
  await q('UPDATE plans SET features=$2, limits=$3 WHERE id=$1',
    [plan, JSON.stringify(features), JSON.stringify({ campaign_recipients: recipients })]);
  await q('UPDATE automations SET is_active=true WHERE id=$1', [automation]);
}
async function queued(slot: string) {
  return (await q("SELECT id FROM jobs WHERE tenant_id=$1 AND type='automation.trigger' AND payload->>'slot'=$2",
    [account, slot])).rowCount;
}
async function state() {
  const row = (await q('SELECT is_active FROM automations WHERE id=$1', [automation])).rows[0];
  const logs = (await q("SELECT error_message FROM automation_logs WHERE automation_id=$1 AND status='failed' ORDER BY created_at",
    [automation])).rows.map((r) => r.error_message as string);
  return { active: row.is_active as boolean, logs };
}

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('scheduled send automations obey campaign plan gates', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await q('SELECT current_database() AS name')).rows[0].name))
      throw new Error('Requires an isolated test database');
    await q("INSERT INTO plans(id,name,sort,features,limits) VALUES($1,'Schedule gate test',99,'{}','{}')", [plan]);
    await q("INSERT INTO auth_users(id,email,full_name,password_hash,email_verified_at) VALUES($1,$2,'Gate owner','test-only',NOW())",
      [user, `${user}@example.invalid`]);
    await q("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Schedule gate',$2)", [account, user]);
    await q("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner')", [account, user]);
    await q('INSERT INTO account_subscriptions(account_id,plan_id) VALUES($1,$2)', [account, plan]);
    await q("INSERT INTO contacts(id,account_id,user_id,phone,name) VALUES($1,$3,$4,'+14155550201','A'),($2,$3,$4,'+14155550202','B')",
      [contacts[0], contacts[1], account, user]);
    await q("INSERT INTO automations(id,account_id,user_id,name,trigger_type,trigger_config,is_active) VALUES($1,$2,$3,'Daily promo','time_based',$4,true)",
      [automation, account, user, JSON.stringify({ schedule: '* * * * *', timezone: 'UTC', audience: { type: 'all' } })]);
    await q('INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position) VALUES($1,$2,$3,$4,0)',
      [account, automation, sendStep.step_type, JSON.stringify(sendStep.step_config)]);
  });
  afterAll(async () => {
    if (owner) {
      await q('DELETE FROM accounts WHERE id=$1', [account]);
      await q('DELETE FROM auth_users WHERE id=$1', [user]);
      await q('DELETE FROM plans WHERE id=$1', [plan]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('refuses activating a scheduled send without campaign_scheduling, but not other schedules', async () => {
    await setPlan({}, 1000);
    await expect(requireScheduledSendingAllowed(account, 'time_based', [sendStep])).rejects.toBeInstanceOf(PlanLimitError);
    const nested = [{ step_type: 'condition', step_config: {}, branches: { yes: [sendStep] } }];
    await expect(requireScheduledSendingAllowed(account, 'time_based', nested)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(requireScheduledSendingAllowed(account, 'time_based', [{ step_type: 'add_tag', step_config: {} }])).resolves.toBeUndefined();
    await expect(requireScheduledSendingAllowed(account, 'keyword_match', [sendStep])).resolves.toBeUndefined();
    await setPlan({ campaign_scheduling: true }, 1000);
    await expect(requireScheduledSendingAllowed(account, 'time_based', [sendStep])).resolves.toBeUndefined();
  });

  it('turns the schedule off and logs once when the plan drops campaign_scheduling after activation', async () => {
    await setPlan({}, 1000);
    const first = scheduleJob();
    await handleJob(first.job);
    expect(await queued(first.slot)).toBe(0);
    const after = await state();
    expect(after.active).toBe(false);
    expect(after.logs.at(-1)).toMatch(/Schedule turned off: Scheduled campaigns/);
    const next = scheduleJob();
    await handleJob(next.job);
    expect((await state()).logs).toHaveLength(after.logs.length);
  });

  it('turns the schedule off when the audience exceeds campaign_recipients', async () => {
    await setPlan({ campaign_scheduling: true }, 1);
    const { job, slot } = scheduleJob();
    await handleJob(job);
    expect(await queued(slot)).toBe(0);
    const after = await state();
    expect(after.active).toBe(false);
    expect(after.logs.at(-1)).toMatch(/recipients per campaign/);
  });

  it('queues every contact when the plan allows the schedule and its audience', async () => {
    await setPlan({ campaign_scheduling: true }, 2);
    const { job, slot } = scheduleJob();
    await handleJob(job);
    expect(await queued(slot)).toBe(2);
    expect((await state()).active).toBe(true);
  });
});
