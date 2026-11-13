import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { AgentError, createAgent, deleteAgent, duplicateAgent, getAgent, listAgents, pickAgentTx, updateAgent } from './agents';
import { readQualityDashboard, setRating } from './quality-dashboard';
import { recordReplyEvent } from './reply-events';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const admin = randomUUID(), agent = randomUUID(), ownerBUser = randomUUID();
const adminA: TenantContext = { accountId: accountA, userId: admin, role: 'admin' };
const agentA: TenantContext = { accountId: accountA, userId: agent, role: 'agent' };
const ownerB: TenantContext = { accountId: accountB, userId: ownerBUser, role: 'owner' };
const phone = `+9197${String(Date.now()).slice(-8)}`;
let owner: pg.Client;
let contactA = '', conversationA = '';

const worker = <T,>(fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId: accountA, role: 'owner' }, fn, getWorkerPrisma());

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('AI agents and reply ratings on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const app = await getPrisma().$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
    if (!/test/i.test(app[0].name) || app[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Agents test', 'test-only-hash' FROM unnest($1::uuid[]) x",
      [[admin, agent, ownerBUser]]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Agents A',$2),($3,'Agents B',$4)", [accountA, admin, accountB, ownerBUser]);
    await owner.query("INSERT INTO account_memberships(account_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'agent'),($4,$5,'owner')",
      [accountA, admin, agent, accountB, ownerBUser]);
    contactA = (await owner.query("INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,$3,'Asha') RETURNING id", [accountA, admin, phone])).rows[0].id;
    conversationA = (await owner.query('INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id', [accountA, admin, contactA])).rows[0].id;
  });
  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id = ANY($1::uuid[])', [[admin, agent, ownerBUser]]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('keeps the legacy single agent answering until an admin opens the list, then migrates it as the default', async () => {
    expect(await worker((tx) => pickAgentTx(tx, accountA, 'whatsapp', conversationA))).toEqual({ kind: 'legacy' });
    // A member below admin never creates rows.
    expect((await listAgents(agentA)).agents).toEqual([]);
    const { agents } = await listAgents(adminA);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ is_default: true, enabled: true, channels: ['whatsapp', 'instagram'] });
    // A second visit does not add another default.
    expect((await listAgents(adminA)).agents).toHaveLength(1);
  });

  it('lets only admins write agents (application check and row-level security)', async () => {
    await expect(createAgent(agentA, { name: 'Nope', instructions: 'x' })).rejects.toBeInstanceOf(AgentError);
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_agents(account_id,name) VALUES (${accountA}::uuid, 'Sneaky')`)).rejects.toThrow();
    const sales = await createAgent(adminA, { name: 'Sales', instructions: 'Sell', channels: ['whatsapp'], hours: { mode: 'during', from: '00:00', to: '23:59' } });
    expect(sales).toMatchObject({ enabled: false, is_default: false });
    await expect(createAgent(adminA, { name: 'sales', instructions: 'again' })).rejects.toMatchObject({ code: 'name_taken' });
    const rows = (await owner.query("SELECT count(*)::int AS n FROM audit_logs WHERE account_id=$1 AND action='ai.agent_created'", [accountA])).rows[0];
    expect(rows.n).toBe(1);
  });

  it('hides agents from other workspaces', async () => {
    const [first] = (await listAgents(adminA)).agents;
    expect(await getAgent(ownerB, first.id)).toBeNull();
    await expect(updateAgent(ownerB, first.id, { name: 'Taken over' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteAgent(ownerB, first.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(duplicateAgent(ownerB, first.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getAgent(adminA, first.id))?.name).toBe(first.name);
  });

  it('picks exactly one agent per channel and keeps the agent that already answered', async () => {
    const { agents } = await listAgents(adminA);
    const def = agents.find((a) => a.is_default)!;
    const sales = agents.find((a) => a.name === 'Sales')!;
    await updateAgent(adminA, sales.id, { enabled: true });
    await updateAgent(adminA, sales.id, { move: 'up' });
    // Sales is first now, on WhatsApp only; the default still covers Instagram.
    let pick = await worker((tx) => pickAgentTx(tx, accountA, 'whatsapp', conversationA));
    expect(pick).toMatchObject({ kind: 'agent', agent: { id: sales.id } });
    pick = await worker((tx) => pickAgentTx(tx, accountA, 'instagram', conversationA));
    expect(pick).toMatchObject({ kind: 'agent', agent: { id: def.id } });
    // The default answered this conversation on WhatsApp before: it keeps the conversation.
    await recordReplyEvent({ accountId: accountA, conversationId: conversationA, contactId: contactA, outcome: 'replied', reason: 'answered', agentId: def.id });
    pick = await worker((tx) => pickAgentTx(tx, accountA, 'whatsapp', conversationA));
    expect(pick).toMatchObject({ kind: 'agent', agent: { id: def.id } });
    // With every agent off, nobody answers (not the legacy path).
    await updateAgent(adminA, sales.id, { enabled: false });
    await updateAgent(adminA, def.id, { enabled: false });
    expect(await worker((tx) => pickAgentTx(tx, accountA, 'whatsapp', conversationA))).toEqual({ kind: 'none' });
    await updateAgent(adminA, def.id, { enabled: true });
  });

  it('copies an agent switched off and refuses to delete the default', async () => {
    const { agents } = await listAgents(adminA);
    const def = agents.find((a) => a.is_default)!;
    const copy = await duplicateAgent(adminA, def.id);
    expect(copy).toMatchObject({ is_default: false, enabled: false, name: `${def.name} copy` });
    await expect(deleteAgent(adminA, def.id)).rejects.toMatchObject({ code: 'default_agent' });
    await deleteAgent(adminA, copy.id);
    expect(await getAgent(adminA, copy.id)).toBeNull();
  });

  it('stores one rating per member per reply, writable only by that member, counted on the dashboard', async () => {
    const [event] = (await owner.query("SELECT id::text FROM ai_reply_events WHERE account_id=$1 AND outcome='replied' LIMIT 1", [accountA])).rows;
    expect(await withTenant(adminA, (tx) => setRating(tx, accountA, admin, { kind: 'agent', id: event.id }, 'down'))).toBe(true);
    expect(await withTenant(adminA, (tx) => setRating(tx, accountA, admin, { kind: 'agent', id: event.id }, 'up'))).toBe(true);
    expect(await withTenant(agentA, (tx) => setRating(tx, accountA, agent, { kind: 'agent', id: event.id }, 'down'))).toBe(true);
    const ratings = (await owner.query('SELECT user_id::text, vote FROM ai_reply_ratings WHERE account_id=$1 ORDER BY vote', [accountA])).rows;
    expect(ratings).toEqual([{ user_id: agent, vote: 'down' }, { user_id: admin, vote: 'up' }]);
    // RLS: a member cannot write a rating as somebody else.
    await expect(withTenant(agentA, (tx) => tx.$executeRaw`INSERT INTO ai_reply_ratings(account_id, reply_event_id, user_id, vote)
      VALUES (${accountA}::uuid, ${event.id}::uuid, ${admin}::uuid, 'down')`)).rejects.toThrow();
    // Another workspace cannot rate this reply.
    expect(await withTenant(ownerB, (tx) => setRating(tx, accountB, ownerBUser, { kind: 'agent', id: event.id }, 'up'))).toBe(false);
    const dash = await withTenant(adminA, (tx) => readQualityDashboard(tx, accountA, admin, 'agent'));
    expect(dash.ratings).toEqual({ up: 1, down: 1 });
    expect(dash.replies.find((r) => r.id === event.id)).toMatchObject({ my_vote: 'up', up: 1, down: 1 });
    // Clearing removes only the caller's rating.
    await withTenant(adminA, (tx) => setRating(tx, accountA, admin, { kind: 'agent', id: event.id }, null));
    expect((await owner.query('SELECT count(*)::int AS n FROM ai_reply_ratings WHERE account_id=$1', [accountA])).rows[0].n).toBe(1);
  });
});
