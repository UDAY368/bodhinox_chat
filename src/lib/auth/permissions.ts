/**
 * Per-feature permissions layered on top of workspace roles.
 *
 * Each feature has a role ceiling (FEATURE_PERMISSIONS): the lowest role that
 * may ever use it. A workspace can only take a feature away from a role
 * (role_permission_restrictions, one row = one denial); there is no row that
 * allows, so a permission never grants more than the role already has. Owners
 * are never restricted, and only an owner can restrict admins (enforced by
 * RLS as well as here).
 *
 * Routes keep their existing requireRole checks and call requirePermission
 * after them; RLS keeps enforcing roles underneath.
 */

import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { ForbiddenError } from './errors';
import { ACCOUNT_ROLES, hasMinRole, type AccountRole } from './roles';

export const FEATURE_PERMISSIONS = {
  'campaigns.send': 'agent',
  'contacts.export': 'admin',
  'flows.publish': 'agent',
  'templates.submit': 'admin',
  'settings.billing': 'admin',
} as const satisfies Record<string, AccountRole>;

export type FeaturePermission = keyof typeof FEATURE_PERMISSIONS;
export const PERMISSIONS = Object.keys(FEATURE_PERMISSIONS) as FeaturePermission[];
/** Roles a workspace may restrict (never the owner). */
export const RESTRICTABLE_ROLES = ['admin', 'agent', 'viewer'] as const satisfies readonly AccountRole[];
export type RestrictableRole = (typeof RESTRICTABLE_ROLES)[number];

export function isFeaturePermission(value: unknown): value is FeaturePermission {
  return typeof value === 'string' && Object.hasOwn(FEATURE_PERMISSIONS, value);
}

export function isRestrictableRole(value: unknown): value is RestrictableRole {
  return typeof value === 'string' && (RESTRICTABLE_ROLES as readonly string[]).includes(value);
}

/** The built-in ceiling: may this role ever use the feature? */
export function roleAllows(role: AccountRole, permission: FeaturePermission): boolean {
  return hasMinRole(role, FEATURE_PERMISSIONS[permission]);
}

/** May `actor` add or remove restrictions for `target`? Admins manage agent/viewer; owners manage all three. */
export function canRestrictRole(actor: AccountRole, target: RestrictableRole): boolean {
  return target === 'admin' ? actor === 'owner' : hasMinRole(actor, 'admin');
}

/**
 * Effective permission: the role ceiling AND not restricted. A restriction
 * row for a role that is not allowed anyway changes nothing.
 */
export function effectivePermission(
  role: AccountRole,
  permission: FeaturePermission,
  restricted: ReadonlySet<string>,
): boolean {
  if (!roleAllows(role, permission)) return false;
  if (role === 'owner') return true;
  return !restricted.has(`${role}:${permission}`);
}

export type PermissionMatrix = Record<AccountRole, Record<FeaturePermission, boolean>>;

/** The full role x feature grid for a workspace's restriction set. */
export function permissionMatrix(restricted: ReadonlySet<string>): PermissionMatrix {
  return Object.fromEntries(
    ACCOUNT_ROLES.map((role) => [role, Object.fromEntries(PERMISSIONS.map((p) => [p, effectivePermission(role, p, restricted)]))]),
  ) as PermissionMatrix;
}

export interface Restriction {
  role: RestrictableRole;
  permission: FeaturePermission;
}

export async function listRestrictions(tx: TenantTransaction, accountId: string): Promise<Restriction[]> {
  const rows = await tx.$queryRaw<{ role: string; permission: string }[]>`SELECT role,permission
    FROM role_permission_restrictions WHERE account_id=${accountId}::uuid ORDER BY role,permission`;
  return rows.flatMap((r) => (isRestrictableRole(r.role) && isFeaturePermission(r.permission) ? [{ role: r.role, permission: r.permission }] : []));
}

export const restrictionKeys = (rows: Restriction[]): Set<string> => new Set(rows.map((r) => `${r.role}:${r.permission}`));

/** Inside the caller's tenant transaction. */
export async function can(
  tx: TenantTransaction,
  ctx: { accountId: string; role: AccountRole },
  permission: FeaturePermission,
): Promise<boolean> {
  if (!roleAllows(ctx.role, permission)) return false;
  if (ctx.role === 'owner') return true;
  const rows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM role_permission_restrictions
    WHERE account_id=${ctx.accountId}::uuid AND role=${ctx.role} AND permission=${permission}`;
  return (rows[0]?.n ?? 0) === 0;
}

/** Throws ForbiddenError (403) unless the caller's role has the feature and it is not restricted. */
export async function requirePermission(tenant: TenantContext, permission: FeaturePermission): Promise<void> {
  const role = tenant.role;
  if (!role) throw new ForbiddenError('Insufficient workspace role');
  const allowed = roleAllows(role, permission)
    && (role === 'owner' || (await withTenant(tenant, (tx) => can(tx, { accountId: tenant.accountId, role }, permission))));
  if (!allowed) throw new ForbiddenError('This feature is turned off for your role');
}

/** Add (allowed=false) or remove (allowed=true) a restriction; audit-logged. Caller has already checked canRestrictRole. */
export async function setRestriction(
  tenant: TenantContext & { userId: string },
  role: RestrictableRole,
  permission: FeaturePermission,
  allowed: boolean,
): Promise<Restriction[]> {
  return withTenant(tenant, async (tx) => {
    const changed = allowed
      ? await tx.$executeRaw`DELETE FROM role_permission_restrictions
          WHERE account_id=${tenant.accountId}::uuid AND role=${role} AND permission=${permission}`
      : await tx.$executeRaw`INSERT INTO role_permission_restrictions(account_id,role,permission,created_by)
          VALUES(${tenant.accountId}::uuid,${role},${permission},${tenant.userId}::uuid) ON CONFLICT DO NOTHING`;
    if (changed)
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${tenant.accountId}::uuid,${tenant.userId}::uuid,'permissions.updated',${permission},
          ${JSON.stringify({ role, permission, allowed })}::jsonb)`;
    return listRestrictions(tx, tenant.accountId);
  });
}
