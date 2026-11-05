import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ platformTenants: vi.fn(), platformTenant: vi.fn() }));
vi.mock('./db', () => db);

import { getTenant, isPurgeDue, listTenants, parsePageQuery } from './tenants';
import { parseLifecycleChange } from './lifecycle';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const row = (createdAt: string, extra: object = {}) => ({ accountId: ACCOUNT, name: 'A', createdAt, ownerEmail: null, planId: 'enterprise',
  planVersion: null, subscriptionStatus: null, lifecycleStatus: 'active', blockManual: false, purgeAfter: null, memberCount: 1, usage: {}, ...extra });

beforeEach(() => vi.clearAllMocks());

describe('console paging', () => {
  it('reads cursor and limit, refusing malformed values', () => {
    expect(parsePageQuery(new URLSearchParams())).toEqual({ cursor: null, limit: 50 });
    expect(parsePageQuery(new URLSearchParams('cursor=2026-11-01T00:00:00.000Z&limit=100'))).toEqual({ cursor: new Date('2026-11-01T00:00:00.000Z'), limit: 100 });
    for (const q of ['limit=0', 'limit=101', 'limit=2.5', 'limit=x', 'cursor=yesterday', `cursor=${'9'.repeat(41)}`])
      expect(parsePageQuery(new URLSearchParams(q))).toBeNull();
  });

  it('pages tenants by created_at and flags closing workspaces past their purge date', async () => {
    db.platformTenants.mockResolvedValueOnce([row('2026-11-02T00:00:00.000Z'),
      row('2026-11-01T00:00:00.000Z', { lifecycleStatus: 'closing', purgeAfter: '2026-10-01T00:00:00.000Z' })]);
    const page = await listTenants({ search: '  acme ', cursor: null, limit: 2 }, Date.parse('2026-11-05T00:00:00Z'));
    expect(db.platformTenants).toHaveBeenCalledWith({ search: 'acme', cursor: null, limit: 2 });
    expect(page.nextCursor).toBe('2026-11-01T00:00:00.000Z');
    expect(page.tenants.map((t) => t.purgeDue)).toEqual([false, true]);
    db.platformTenants.mockResolvedValueOnce([row('2026-11-02T00:00:00.000Z')]);
    expect((await listTenants({ search: '', cursor: null, limit: 2 })).nextCursor).toBeNull();
    expect(db.platformTenants).toHaveBeenLastCalledWith({ search: null, cursor: null, limit: 2 });
  });

  it('never lists a purge as due for an active workspace or before the date', () => {
    expect(isPurgeDue('active', '2020-01-01T00:00:00Z')).toBe(false);
    expect(isPurgeDue('closing', '2999-01-01T00:00:00Z')).toBe(false);
    expect(isPurgeDue('closing', null)).toBe(false);
  });

  it('looks up a tenant only for a well-formed id', async () => {
    expect(await getTenant('not-a-uuid')).toBeNull();
    expect(db.platformTenant).not.toHaveBeenCalled();
    db.platformTenant.mockResolvedValueOnce({ account_id: ACCOUNT });
    expect(await getTenant(ACCOUNT.toUpperCase())).toEqual({ account_id: ACCOUNT });
    expect(db.platformTenant).toHaveBeenCalledWith(ACCOUNT);
  });
});

describe('lifecycle change body', () => {
  it('accepts suspend / reactivate with a reason; closing and unknown fields are refused', () => {
    expect(parseLifecycleChange({ accountId: ACCOUNT, status: 'admin_suspended', blockManual: true, reason: ' Abuse report filed ' }))
      .toEqual({ accountId: ACCOUNT, status: 'admin_suspended', blockManual: true, reason: 'Abuse report filed' });
    expect(parseLifecycleChange({ accountId: ACCOUNT, status: 'active', reason: 'Review finished' }))
      .toEqual({ accountId: ACCOUNT, status: 'active', blockManual: false, reason: 'Review finished' });
    for (const bad of [
      { accountId: ACCOUNT, status: 'closing', reason: 'Owner wants to delete' },
      { accountId: ACCOUNT, status: 'active', reason: 'too short' },
      { accountId: ACCOUNT, status: 'active', reason: 'Review finished', blockManual: 'yes' },
      { accountId: ACCOUNT, status: 'active', reason: 'Review finished', adminEmail: 'x@y.z' },
      { accountId: 'nope', status: 'active', reason: 'Review finished' },
      null,
    ]) expect(parseLifecycleChange(bad)).toBeNull();
  });
});
