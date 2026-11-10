import { describe, expect, it, vi } from 'vitest';
import type { AuthTransaction } from '@/lib/auth/service';
import { assignInitialPlan, newWorkspacePlan } from './new-workspace-plan';

function fakeTx() {
  const queryRaw = vi.fn(async (...args: unknown[]) => (args.length ? [{ assigned: true }] : []));
  return { tx: { $queryRaw: queryRaw, $executeRaw: vi.fn() } as unknown as AuthTransaction, queryRaw };
}

describe('NEW_WORKSPACE_PLAN', () => {
  it('while unset, still gives a new workspace a plan: the lowest one (NULL to the definer), never enterprise by default', async () => {
    expect(newWorkspacePlan({})).toBeNull();
    expect(newWorkspacePlan({ NEW_WORKSPACE_PLAN: '  ' })).toBeNull();
    const { tx, queryRaw } = fakeTx();
    expect(await assignInitialPlan(tx, '11111111-1111-4111-8111-111111111111', {})).toBe(true);
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('billing_assign_initial_plan');
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111', null]);
  });

  it('assigns the configured plan through the definer when set', async () => {
    const { tx, queryRaw } = fakeTx();
    expect(await assignInitialPlan(tx, '11111111-1111-4111-8111-111111111111', { NEW_WORKSPACE_PLAN: 'free' })).toBe(true);
    const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('billing_assign_initial_plan');
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111', 'free']);
  });

  it('refuses a malformed plan id instead of handing out a default', () => {
    expect(() => newWorkspacePlan({ NEW_WORKSPACE_PLAN: 'Free Plan' })).toThrow(/NEW_WORKSPACE_PLAN/);
  });
});
