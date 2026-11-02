import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';

/**
 * Teams: named groups of workspace members. Used as a routing target
 * (routing_rules assign_to {mode:'team'}: round robin over the team's
 * eligible members) and as the inbox "My team" filter.
 *
 * Every member can list teams; only admins and owners change them (route
 * check plus RLS admin write). A member who leaves the workspace leaves every
 * team (membership foreign key cascade). Changes are audit-logged.
 */

export const MAX_TEAMS = 50;
export const MAX_TEAM_MEMBERS = 200;
export const MAX_TEAM_NAME = 80;

export interface Team {
  id: string;
  name: string;
  member_ids: string[];
  created_at: string;
}

export interface TeamInput {
  name?: string;
  member_ids?: string[];
}

export type TeamErrorCode = 'invalid_name' | 'invalid_members' | 'unknown_member' | 'duplicate_name' | 'limit' | 'not_found';

export class TeamError extends Error {
  constructor(readonly code: TeamErrorCode, readonly status: 400 | 404 | 409 = 400) {
    super(code);
    this.name = 'TeamError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Validates a create (`partial=false`: name required) or update body. */
export function parseTeamInput(body: unknown, partial: boolean): TeamInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TeamError('invalid_name');
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'name' && key !== 'member_ids')) throw new TeamError('invalid_name');
  const out: TeamInput = {};
  if (value.name !== undefined || !partial) {
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!name || name.length > MAX_TEAM_NAME) throw new TeamError('invalid_name');
    out.name = name;
  }
  if (value.member_ids !== undefined) {
    const ids = value.member_ids;
    if (!Array.isArray(ids) || ids.length > MAX_TEAM_MEMBERS || !ids.every(isUuid)) throw new TeamError('invalid_members');
    out.member_ids = [...new Set(ids.map((id) => id.toLowerCase()))];
  }
  return out;
}

type TeamRow = { id: string; name: string; member_ids: string[] | null; created_at: Date };

const toTeam = (row: TeamRow): Team => ({
  id: row.id,
  name: row.name,
  member_ids: row.member_ids ?? [],
  created_at: row.created_at.toISOString(),
});

async function selectTeams(tx: TenantTransaction, accountId: string, id?: string): Promise<Team[]> {
  const rows = await tx.$queryRaw<TeamRow[]>`SELECT t.id::text AS id,t.name,t.created_at,
      COALESCE(array_agg(m.user_id::text ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL),'{}') AS member_ids
    FROM teams t LEFT JOIN team_members m ON m.account_id=t.account_id AND m.team_id=t.id
    WHERE t.account_id=${accountId}::uuid AND (${id ?? null}::uuid IS NULL OR t.id=${id ?? null}::uuid)
    GROUP BY t.id ORDER BY lower(t.name),t.id`;
  return rows.map(toTeam);
}

/** Members of one team, in a stable order (the round-robin list). Empty when the team is gone. */
export async function teamMemberIds(tx: TenantTransaction, accountId: string, teamId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text AS user_id FROM team_members
    WHERE account_id=${accountId}::uuid AND team_id=${teamId}::uuid ORDER BY user_id LIMIT ${MAX_TEAM_MEMBERS}`;
  return rows.map((row) => row.user_id.toLowerCase());
}

export async function teamExists(tx: TenantTransaction, accountId: string, teamId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM teams
    WHERE account_id=${accountId}::uuid AND id=${teamId}::uuid`;
  return rows.length > 0;
}

async function assertMembers(tx: TenantTransaction, accountId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM account_memberships
    WHERE account_id=${accountId}::uuid AND user_id=ANY(${ids}::uuid[])`;
  if (rows[0]?.n !== ids.length) throw new TeamError('unknown_member');
}

async function assertNameFree(tx: TenantTransaction, accountId: string, name: string, exceptId?: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM teams
    WHERE account_id=${accountId}::uuid AND lower(btrim(name))=lower(btrim(${name}))
      AND (${exceptId ?? null}::uuid IS NULL OR id<>${exceptId ?? null}::uuid)`;
  if (rows.length) throw new TeamError('duplicate_name', 409);
}

const lock = (tx: TenantTransaction, accountId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`teams:${accountId}`}, 0))`;

async function replaceMembers(tx: TenantTransaction, accountId: string, teamId: string, ids: string[]): Promise<void> {
  await tx.$executeRaw`DELETE FROM team_members WHERE account_id=${accountId}::uuid AND team_id=${teamId}::uuid
    AND NOT (user_id=ANY(${ids}::uuid[]))`;
  if (ids.length)
    await tx.$executeRaw`INSERT INTO team_members(account_id,team_id,user_id)
      SELECT ${accountId}::uuid,${teamId}::uuid,u FROM unnest(${ids}::uuid[]) AS u ON CONFLICT DO NOTHING`;
}

const audit = (tx: TenantTransaction, tenant: TenantContext, action: string, teamId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${tenant.accountId}::uuid,${tenant.userId ?? null}::uuid,${action},${teamId},${JSON.stringify(metadata)}::jsonb)`;

export async function listTeams(tenant: TenantContext): Promise<Team[]> {
  return withTenant(tenant, (tx) => selectTeams(tx, tenant.accountId));
}

export async function createTeam(tenant: TenantContext, input: TeamInput): Promise<Team> {
  return withTenant(tenant, async (tx) => {
    await lock(tx, tenant.accountId);
    const count = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM teams WHERE account_id=${tenant.accountId}::uuid`;
    if ((count[0]?.n ?? 0) >= MAX_TEAMS) throw new TeamError('limit', 409);
    const name = (input.name ?? '').trim();
    await assertNameFree(tx, tenant.accountId, name);
    const members = input.member_ids ?? [];
    await assertMembers(tx, tenant.accountId, members);
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO teams(account_id,name)
      VALUES(${tenant.accountId}::uuid,${name}) RETURNING id::text AS id`;
    const id = rows[0].id;
    await replaceMembers(tx, tenant.accountId, id, members);
    await audit(tx, tenant, 'team.created', id, { members: members.length });
    return (await selectTeams(tx, tenant.accountId, id))[0];
  });
}

export async function updateTeam(tenant: TenantContext, id: string, input: TeamInput): Promise<Team> {
  if (!isUuid(id)) throw new TeamError('not_found', 404);
  return withTenant(tenant, async (tx) => {
    await lock(tx, tenant.accountId);
    if (!(await teamExists(tx, tenant.accountId, id))) throw new TeamError('not_found', 404);
    if (input.name !== undefined) {
      await assertNameFree(tx, tenant.accountId, input.name, id);
      await tx.$executeRaw`UPDATE teams SET name=${input.name.trim()} WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid`;
    }
    if (input.member_ids !== undefined) {
      await assertMembers(tx, tenant.accountId, input.member_ids);
      await replaceMembers(tx, tenant.accountId, id, input.member_ids);
    }
    await audit(tx, tenant, 'team.updated', id, {
      renamed: input.name !== undefined,
      ...(input.member_ids !== undefined ? { members: input.member_ids.length } : {}),
    });
    return (await selectTeams(tx, tenant.accountId, id))[0];
  });
}

/** Deletes the team and its memberships; routing rules that named it match nobody until edited. */
export async function deleteTeam(tenant: TenantContext, id: string): Promise<void> {
  if (!isUuid(id)) throw new TeamError('not_found', 404);
  await withTenant(tenant, async (tx) => {
    const deleted = await tx.$executeRaw`DELETE FROM teams WHERE account_id=${tenant.accountId}::uuid AND id=${id}::uuid`;
    if (!deleted) throw new TeamError('not_found', 404);
    await audit(tx, tenant, 'team.deleted', id, {});
  });
}
