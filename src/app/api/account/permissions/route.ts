// GET /api/account/permissions (admins and owners) — the role x feature grid:
//   200 { permissions: [{ key, minimum_role }], roles, restrictions: [{ role, permission }],
//         matrix: { [role]: { [permission]: boolean } }, editable_roles }.
// PUT /api/account/permissions (admins and owners) — { role, permission, allowed }.
//   allowed=false turns a feature off for a role; allowed=true removes that
//   restriction. It can never give a role more than its built-in ceiling.
//   Owners cannot be restricted; only an owner can restrict admins.
//   200 (same shape as GET); 400 invalid; 403 not allowed to change that role.

import { NextResponse } from 'next/server';

import { ForbiddenError, requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { ACCOUNT_ROLES, type AccountRole } from '@/lib/auth/roles';
import {
  canRestrictRole, FEATURE_PERMISSIONS, isFeaturePermission, isRestrictableRole, listRestrictions, PERMISSIONS,
  permissionMatrix, RESTRICTABLE_ROLES, restrictionKeys, setRestriction, type Restriction,
} from '@/lib/auth/permissions';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';

const t = getT('Validation.permissions');
const noStore = { 'Cache-Control': 'private, no-store' };

function view(role: AccountRole, restrictions: Restriction[]) {
  return {
    permissions: PERMISSIONS.map((key) => ({ key, minimum_role: FEATURE_PERMISSIONS[key] })),
    roles: ACCOUNT_ROLES,
    restrictions,
    matrix: permissionMatrix(restrictionKeys(restrictions)),
    editable_roles: RESTRICTABLE_ROLES.filter((r) => canRestrictRole(role, r)),
  };
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const restrictions = await withTenant(tenantOf(ctx), (tx) => listRestrictions(tx, ctx.accountId));
    return NextResponse.json(view(ctx.role, restrictions), { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`permissions:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const role = body?.role;
    const permission = body?.permission;
    if (!isRestrictableRole(role) || !isFeaturePermission(permission) || typeof body?.allowed !== 'boolean')
      return NextResponse.json({ error: t('invalid'), code: 'invalid' }, { status: 400 });
    if (!canRestrictRole(ctx.role, role)) throw new ForbiddenError(t('ownerOnly'));
    const restrictions = await setRestriction({ ...tenantOf(ctx), userId: ctx.userId }, role, permission, body.allowed);
    return NextResponse.json(view(ctx.role, restrictions), { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}
