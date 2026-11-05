import { describe, expect, it, vi } from 'vitest';
import { PlanLimitError } from './entitlements';
import { isSuspended, requireSendingAllowed, suspensionReason, WorkspaceSuspendedError } from './suspension';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const tx = (lifecycle: string | null, billing: boolean) => ({ $queryRaw: vi.fn(async () => [{ lifecycle, billing }]) }) as never;

describe('suspension reasons', () => {
  it('is not suspended with no lifecycle row and no suspended subscription (every existing workspace)', async () => {
    expect(await suspensionReason(tx(null, false), ACCOUNT)).toBeNull();
    expect(await isSuspended(tx('active', false), ACCOUNT)).toBe(false);
    await requireSendingAllowed(tx(null, false), ACCOUNT);
  });

  it('orders admin suspension before closing before billing', async () => {
    expect(await suspensionReason(tx('admin_suspended', true), ACCOUNT)).toBe('admin');
    expect(await suspensionReason(tx('closing', true), ACCOUNT)).toBe('closing');
    expect(await suspensionReason(tx('active', true), ACCOUNT)).toBe('billing');
    expect(await isSuspended(tx('closing', false), ACCOUNT)).toBe(true);
  });

  it('keeps the billing code and gives admin suspension and closing their own codes (402 each)', async () => {
    const refusal = (lifecycle: string | null, billing: boolean) => requireSendingAllowed(tx(lifecycle, billing), ACCOUNT).catch((e) => e);
    const billing = await refusal(null, true);
    expect(billing).toBeInstanceOf(WorkspaceSuspendedError);
    expect(billing).toBeInstanceOf(PlanLimitError);
    expect(billing).toMatchObject({ status: 402, code: 'plan_limit', reason: 'billing' });
    expect(await refusal('admin_suspended', false)).toMatchObject({ status: 402, code: 'workspace_admin_suspended', reason: 'admin' });
    expect(await refusal('closing', false)).toMatchObject({ status: 402, code: 'workspace_closing', reason: 'closing' });
    // The admin message never tells the workspace to pay.
    expect(new WorkspaceSuspendedError('admin').message).not.toBe(new WorkspaceSuspendedError('billing').message);
  });
});
