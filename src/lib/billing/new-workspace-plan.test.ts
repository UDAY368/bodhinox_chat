import { describe, expect, it, vi } from 'vitest';
import type { AuthTransaction } from '@/lib/auth/service';
import { assignInitialPlan, newWorkspacePlan } from './new-workspace-plan';

describe('NEW_WORKSPACE_PLAN', () => {
  it('does nothing while unset, so new workspaces stay on enterprise as today', async () => {
    const tx = { $queryRaw: vi.fn(), $executeRaw: vi.fn() } as unknown as AuthTransaction;
    expect(newWorkspacePlan({})).toBeNull();
    expect(newWorkspacePlan({ NEW_WORKSPACE_PLAN: '  ' })).toBeNull();
    expect(await assignInitialPlan(tx, 'acct', {})).toBe(false);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('assigns the configured plan through the definer when set', async () => {
    const queryRaw = vi.fn(async (...args: unknown[]) => (args.length ? [{ assigned: true }] : []));
    const tx = { $queryRaw: queryRaw, $executeRaw: vi.fn() } as unknown as AuthTransaction;
    expect(await assignInitialPlan(tx, '11111111-1111-4111-8111-111111111111', { NEW_WORKSPACE_PLAN: 'free' })).toBe(true);
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('billing_assign_initial_plan');
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111', 'free']);
  });

  it('refuses a malformed plan id instead of handing out a default', () => {
    expect(() => newWorkspacePlan({ NEW_WORKSPACE_PLAN: 'Free Plan' })).toThrow(/NEW_WORKSPACE_PLAN/);
  });
});
