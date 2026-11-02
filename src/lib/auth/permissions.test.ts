import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ restricted: 0, queries: 0 }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_t: unknown, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: async () => { h.queries++; return [{ n: h.restricted }]; } }),
}));

import { ACCOUNT_ROLES, hasMinRole, type AccountRole } from './roles';
import {
  canRestrictRole, effectivePermission, FEATURE_PERMISSIONS, isFeaturePermission, isRestrictableRole, permissionMatrix,
  PERMISSIONS, requirePermission, RESTRICTABLE_ROLES, roleAllows,
} from './permissions';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const everyRestriction = new Set(RESTRICTABLE_ROLES.flatMap((r) => PERMISSIONS.map((p) => `${r}:${p}`)));

beforeEach(() => {
  h.restricted = 0;
  h.queries = 0;
});

describe('feature permissions', () => {
  it('never grants beyond the role ceiling, whatever the restriction set', () => {
    for (const restricted of [new Set<string>(), everyRestriction, new Set(['viewer:campaigns.send', 'agent:contacts.export'])])
      for (const role of ACCOUNT_ROLES)
        for (const p of PERMISSIONS)
          if (effectivePermission(role, p, restricted)) expect(hasMinRole(role, FEATURE_PERMISSIONS[p])).toBe(true);
  });

  it('defaults to the role ceiling and restrictions only take away', () => {
    const open = permissionMatrix(new Set());
    const closed = permissionMatrix(everyRestriction);
    for (const role of ACCOUNT_ROLES)
      for (const p of PERMISSIONS) {
        expect(open[role][p]).toBe(roleAllows(role, p));
        if (closed[role][p]) expect(open[role][p]).toBe(true);
      }
    expect(open.viewer['campaigns.send']).toBe(false);
    expect(open.agent['contacts.export']).toBe(false);
    expect(open.agent['campaigns.send']).toBe(true);
  });

  it('never restricts the owner', () => {
    for (const p of PERMISSIONS) expect(effectivePermission('owner', p, new Set([`owner:${p}`]))).toBe(true);
    expect(isRestrictableRole('owner')).toBe(false);
  });

  it('lets admins restrict agents and viewers, and only owners restrict admins', () => {
    expect(canRestrictRole('admin', 'agent')).toBe(true);
    expect(canRestrictRole('admin', 'viewer')).toBe(true);
    expect(canRestrictRole('admin', 'admin')).toBe(false);
    expect(canRestrictRole('owner', 'admin')).toBe(true);
    for (const actor of ['agent', 'viewer'] as AccountRole[])
      for (const target of RESTRICTABLE_ROLES) expect(canRestrictRole(actor, target)).toBe(false);
  });

  it('rejects unknown permission keys, including prototype names', () => {
    expect(isFeaturePermission('campaigns.send')).toBe(true);
    for (const bad of ['toString', '__proto__', 'campaigns', '', null, 1]) expect(isFeaturePermission(bad)).toBe(false);
  });
});

describe('requirePermission', () => {
  const tenant = (role: AccountRole) => ({ accountId: ACCOUNT, userId: ACCOUNT, role });

  it('refuses a role below the ceiling without consulting the database', async () => {
    await expect(requirePermission(tenant('viewer'), 'campaigns.send')).rejects.toMatchObject({ status: 403 });
    await expect(requirePermission({ accountId: ACCOUNT }, 'campaigns.send')).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toBe(0);
  });

  it('refuses a restricted role and allows an unrestricted one', async () => {
    await expect(requirePermission(tenant('agent'), 'campaigns.send')).resolves.toBeUndefined();
    h.restricted = 1;
    await expect(requirePermission(tenant('agent'), 'campaigns.send')).rejects.toMatchObject({ status: 403 });
  });

  it('allows the owner even when a restriction row exists', async () => {
    h.restricted = 1;
    await expect(requirePermission(tenant('owner'), 'settings.billing')).resolves.toBeUndefined();
    expect(h.queries).toBe(0);
  });
});
