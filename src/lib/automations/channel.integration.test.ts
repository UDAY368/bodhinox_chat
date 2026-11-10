/**
 * Stage 1 on PostgreSQL: automations.channel under the real roles. The engine
 * (worker role, job scope) runs only the dispatch channel's automations and
 * refuses a conversation of the other channel; nothing crosses a workspace;
 * the app role (RLS) reads and filters the column inside its own tenant only.
 * Steps here write a contact field only, so nothing is sent.
 */
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectDatabases } from '@/lib/db/prisma';
import { createScopedClient } from '@/lib/data/server';
import { withJobScope } from '@/lib/jobs/scope';
import { runAutomationsForTrigger } from './engine';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), agentA = randomUUID(), ownerB = randomUUID();
const seed = String(Date.now()).slice(-9);
let owner: pg.Client;
let contactA = '', waConvA = '', igConvA = '', waAutomation = '', igAutomation = '';

const runsOf = async (automationId: string) =>
  (await owner.query('SELECT count(*)::int AS n FROM automation_logs WHERE automation_id=$1', [automationId])).rows[0].n as number;

async function automation(name: string, channel: 'whatsapp' | 'instagram' | null): Promise<string> {
  // null: written without the column, as every automation before Stage 1.
  const id = channel === null
    ? (await owner.query(`INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active)
        VALUES($1,$2,$3,'new_message_received','{}',true) RETURNING id`, [accountA, ownerA, name])).rows[0].id
    : (await owner.query(`INSERT INTO automations(account_id,user_id,name,trigger_type,trigger_config,is_active,channel)
        VALUES($1,$2,$3,'new_message_received','{}',true,$4) RETURNING id`, [accountA, ownerA, name, channel])).rows[0].id;
  await owner.query(`INSERT INTO automation_steps(account_id,automation_id,step_type,step_config,position)
    VALUES($1,$2,'update_contact_field',$3,0)`, [accountA, id, { field: 'company', value: `ran-${name}` }]);
  return id;
}

const dispatch = (accountId: string, channel: 'whatsapp' | 'instagram', conversationId: string, contactId = contactA) =>
  withJobScope({ accountId, role: 'owner' }, () => runAutomationsForTrigger({
    accountId, channel, triggerType: 'new_message_received', contactId, context: { message_text: 'hi', conversation_id: conversationId },
  }));

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('automations.channel on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name))
      throw new Error('Automation channel tests require an isolated test database');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Automation channel test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[ownerA, agentA, ownerB]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Auto channel A',$2),($3,'Auto channel B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, ownerA, agentA, accountB, ownerB]);
    const igAccount = (await owner.query(`INSERT INTO instagram_accounts(account_id,ig_user_id,username,access_token_enc,connected_by_user_id)
      VALUES($1,$2,'auto_channel_a','enc-test-token',$3) RETURNING id`, [accountA, `93${seed}`, ownerA])).rows[0].id;
    contactA = (await owner.query('INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,$4) RETURNING id',
      [accountA, ownerA, `+1419${seed.slice(-7)}`, 'Both channels'])).rows[0].id;
    waConvA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
      [accountA, ownerA, contactA])).rows[0].id;
    igConvA = (await owner.query(`INSERT INTO conversations(account_id,user_id,contact_id,channel,instagram_account_id)
      VALUES($1,$2,$3,'instagram',$4) RETURNING id`, [accountA, ownerA, contactA, igAccount])).rows[0].id;
    waAutomation = await automation('wa', null);
    igAutomation = await automation('ig', 'instagram');
  });

  beforeEach(async () => {
    await owner.query('DELETE FROM automation_logs WHERE account_id=$1', [accountA]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id IN ($1,$2)', [accountA, accountB]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[ownerA, agentA, ownerB]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('stores an automation written without the column as WhatsApp', async () => {
    const rows = (await owner.query('SELECT id, channel FROM automations WHERE account_id=$1 ORDER BY name DESC', [accountA])).rows;
    expect(rows).toEqual([{ id: waAutomation, channel: 'whatsapp' }, { id: igAutomation, channel: 'instagram' }]);
  });

  it('runs only the dispatch channel\'s automations', async () => {
    expect(await dispatch(accountA, 'whatsapp', waConvA)).toBe(true);
    expect([await runsOf(waAutomation), await runsOf(igAutomation)]).toEqual([1, 0]);
    expect(await dispatch(accountA, 'instagram', igConvA)).toBe(true);
    expect([await runsOf(waAutomation), await runsOf(igAutomation)]).toEqual([1, 1]);
  });

  it('refuses a conversation of the other channel, running nothing', async () => {
    expect(await dispatch(accountA, 'whatsapp', igConvA)).toBe(false);
    expect(await dispatch(accountA, 'instagram', waConvA)).toBe(false);
    expect([await runsOf(waAutomation), await runsOf(igAutomation)]).toEqual([0, 0]);
  });

  it('never runs or reveals another workspace\'s automations', async () => {
    // B's job scope with A's contact and conversation: refused, nothing logged anywhere.
    await dispatch(accountB, 'instagram', igConvA);
    await dispatch(accountB, 'whatsapp', waConvA);
    expect([await runsOf(waAutomation), await runsOf(igAutomation)]).toEqual([0, 0]);
    const asB = createScopedClient({ accountId: accountB, userId: ownerB, role: 'owner' });
    const seen = await asB.from('automations').select('id,channel').eq('channel', 'instagram');
    expect(seen.error).toBeNull();
    expect(seen.data).toEqual([]);
  });

  it('lets the app role read and filter the channel inside its own workspace', async () => {
    const asAgent = createScopedClient({ accountId: accountA, userId: agentA, role: 'agent' });
    const instagram = await asAgent.from('automations').select('id,channel').eq('channel', 'instagram');
    expect(instagram.error).toBeNull();
    expect(instagram.data).toEqual([{ id: igAutomation, channel: 'instagram' }]);
    const whatsapp = await asAgent.from('automations').select('id').eq('channel', 'whatsapp');
    expect(whatsapp.data).toEqual([{ id: waAutomation }]);
  });
});
