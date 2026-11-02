import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectDatabases, getPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { requirePermission, setRestriction } from '@/lib/auth/permissions';
import { listAuditLog } from '@/lib/audit/audit-log';
import { createRoutingRule, pickRoutingRule } from '@/lib/inbox/routing';
import { createTeam, deleteTeam, listTeams, TeamError, updateTeam } from './teams';

const configured = config({ path: '.env.test', quiet: true }).parsed;
const ownerUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL || configured?.DATABASE_URL;
const workerUrl = process.env.TEST_WORKER_DATABASE_URL || configured?.WORKER_DATABASE_URL;
if (appUrl) process.env.DATABASE_URL = appUrl;
if (workerUrl) process.env.WORKER_DATABASE_URL = workerUrl;

const accountA = randomUUID(), accountB = randomUUID();
const ownerA = randomUUID(), adminA = randomUUID(), agentA = randomUUID(), agent2A = randomUUID(), viewerA = randomUUID(), ownerB = randomUUID();
const users = [ownerA, adminA, agentA, agent2A, viewerA, ownerB];
const asOwner: TenantContext & { userId: string } = { accountId: accountA, userId: ownerA, role: 'owner' };
const asAdmin: TenantContext & { userId: string } = { accountId: accountA, userId: adminA, role: 'admin' };
const asAgent: TenantContext = { accountId: accountA, userId: agentA, role: 'agent' };
const asB: TenantContext = { accountId: accountB, userId: ownerB, role: 'owner' };
let owner: pg.Client;

const fails = (work: Promise<unknown>) => work.then(() => false, () => true);
const routeContext = { tagIds: new Set<string>(), text: 'hello', whatsappConfigId: null, withinWorkingHours: true };

describe.skipIf(!ownerUrl || !appUrl || !workerUrl)('teams and feature permissions on PostgreSQL', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    if (!/test/i.test((await owner.query('SELECT current_database() AS name')).rows[0].name)) throw new Error('Requires an isolated test database');
    const role = await getPrisma().$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    if (role[0].role !== 'bodhinox_app') throw new Error('Requires constrained test app credentials');
    await owner.query("INSERT INTO auth_users(id,email,full_name,password_hash) SELECT x, x::text || '@example.invalid', 'Teams test', 'test-only-hash' FROM unnest($1::uuid[]) x", [users]);
    await owner.query("INSERT INTO accounts(id,name,owner_user_id) VALUES($1,'Teams A',$2),($3,'Teams B',$4)", [accountA, ownerA, accountB, ownerB]);
    await owner.query(`INSERT INTO account_memberships(account_id,user_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'admin'),($1,$4,'agent'),($1,$5,'agent'),($1,$6,'viewer'),($7,$8,'owner')`,
    [accountA, ownerA, adminA, agentA, agent2A, viewerA, accountB, ownerB]);
  });

  afterAll(async () => {
    if (owner) {
      await owner.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [[accountA, accountB]]);
      await owner.query('DELETE FROM auth_users WHERE id=ANY($1::uuid[])', [users]);
      await owner.end();
    }
    await disconnectDatabases();
  });

  it('lets admins manage teams, members read them, and keeps them per workspace', async () => {
    const team = await createTeam(asAdmin, { name: 'Support', member_ids: [agentA, agent2A, viewerA] });
    expect(team.member_ids).toEqual([agentA, agent2A, viewerA].sort());
    expect((await listTeams(asAgent)).map((t) => t.name)).toEqual(['Support']);
    expect(await listTeams(asB)).toEqual([]);
    await expect(createTeam(asAdmin, { name: ' support ' })).rejects.toMatchObject({ code: 'duplicate_name' });
    await expect(createTeam(asAdmin, { name: 'X', member_ids: [ownerB] })).rejects.toBeInstanceOf(TeamError);
    // RLS: an agent cannot write teams even bypassing the route, nor can another workspace touch them.
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`INSERT INTO teams(account_id,name) VALUES(${accountA}::uuid,'Rogue')`))).toBe(true);
    expect(await fails(updateTeam(asB, team.id, { name: 'Taken' }))).toBe(true);
    const renamed = await updateTeam(asAdmin, team.id, { name: 'Support desk', member_ids: [agentA, agent2A, viewerA] });
    expect(renamed.name).toBe('Support desk');
  });

  it('round-robins a team routing rule over eligible members only, and leaving the workspace leaves the team', async () => {
    const [team] = await listTeams(asAdmin);
    await expect(createRoutingRule(asAdmin, {
      name: 'Bad team', enabled: true, conditions: {}, assign_to: { mode: 'team', team_id: randomUUID() }, reassign_after_minutes: null,
    })).rejects.toMatchObject({ code: 'unknown_team' });
    await createRoutingRule(asAdmin, {
      name: 'To support', enabled: true, conditions: {}, assign_to: { mode: 'team', team_id: team.id }, reassign_after_minutes: null,
    });
    const pick = () => withTenant({ accountId: accountA, role: 'owner' }, (tx) => pickRoutingRule(tx, accountA, routeContext), getWorkerPrisma());
    const picks = [(await pick())?.assignee, (await pick())?.assignee, (await pick())?.assignee];
    expect(new Set(picks)).toEqual(new Set([agentA, agent2A]));
    expect(picks).not.toContain(viewerA);
    expect(picks[0]).not.toBe(picks[1]);

    await owner.query('DELETE FROM account_memberships WHERE account_id=$1 AND user_id=$2', [accountA, agent2A]);
    expect((await listTeams(asAdmin))[0].member_ids).not.toContain(agent2A);
    expect((await pick())?.assignee).toBe(agentA);

    await deleteTeam(asAdmin, team.id);
    expect(await pick()).toBeNull();
  });

  it('restricts but never grants, and only an owner restricts admins', async () => {
    await expect(requirePermission(asAgent, 'campaigns.send')).resolves.toBeUndefined();
    await setRestriction(asAdmin, 'agent', 'campaigns.send', false);
    await expect(requirePermission(asAgent, 'campaigns.send')).rejects.toMatchObject({ status: 403 });
    await expect(requirePermission(asAdmin, 'campaigns.send')).resolves.toBeUndefined();
    // Another workspace's agents are unaffected.
    await expect(requirePermission({ accountId: accountB, userId: ownerB, role: 'agent' }, 'campaigns.send')).resolves.toBeUndefined();

    // RLS: admins cannot restrict their own role; agents cannot write restrictions; owners are never restrictable.
    expect(await fails(setRestriction(asAdmin, 'admin', 'settings.billing', false))).toBe(true);
    expect(await fails(withTenant(asAgent, (tx) => tx.$executeRaw`DELETE FROM role_permission_restrictions WHERE account_id=${accountA}::uuid`))).toBe(false);
    await expect(requirePermission(asAgent, 'campaigns.send')).rejects.toMatchObject({ status: 403 });
    expect(await fails(withTenant(asOwner, (tx) => tx.$executeRaw`INSERT INTO role_permission_restrictions(account_id,role,permission)
      VALUES(${accountA}::uuid,'owner','settings.billing')`))).toBe(true);
    await setRestriction(asOwner, 'admin', 'settings.billing', false);
    await expect(requirePermission(asAdmin, 'settings.billing')).rejects.toMatchObject({ status: 403 });
    await expect(requirePermission(asOwner, 'settings.billing')).resolves.toBeUndefined();

    // Lifting a restriction cannot lift a role above its ceiling.
    await setRestriction(asAdmin, 'viewer', 'contacts.export', true);
    await expect(requirePermission({ accountId: accountA, userId: viewerA, role: 'viewer' }, 'contacts.export')).rejects.toMatchObject({ status: 403 });
    await setRestriction(asAdmin, 'agent', 'campaigns.send', true);
    await expect(requirePermission(asAgent, 'campaigns.send')).resolves.toBeUndefined();
  });

  it('shows the audit trail to admins only, with identifiers and counts', async () => {
    const page = await listAuditLog(asAdmin, { limit: 100 });
    const actions = page.entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['team.created', 'team.updated', 'team.deleted', 'permissions.updated']));
    expect(page.entries.find((e) => e.action === 'team.created')?.metadata).toEqual({ members: 3 });
    const prefixed = await listAuditLog(asAdmin, { action: 'team.', limit: 2 });
    expect(prefixed.entries.every((e) => e.action.startsWith('team.'))).toBe(true);
    expect(prefixed.next_cursor).not.toBeNull();
    const next = await listAuditLog(asAdmin, { action: 'team.', limit: 2, cursor: (await import('@/lib/audit/audit-log')).decodeCursor(prefixed.next_cursor!) });
    expect(next.entries.map((e) => e.id)).not.toEqual(expect.arrayContaining(prefixed.entries.map((e) => e.id)));
    expect((await listAuditLog(asAgent, { limit: 100 })).entries).toEqual([]);
    expect((await listAuditLog(asB, { limit: 100 })).entries).toEqual([]);
  });
});
