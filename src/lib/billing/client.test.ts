import { expect, it, vi } from 'vitest';

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/client', () => ({ authFetch }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: null }) }));
import { invalidatePlan, loadPlan } from './client';

it('reads the plan once per page until it is invalidated (e.g. after an add-on purchase)', async () => {
  authFetch.mockImplementation(async () => new Response(JSON.stringify({ planName: 'Starter' })));
  await loadPlan('acc_1');
  await loadPlan('acc_1');
  expect(authFetch).toHaveBeenCalledTimes(1);
  invalidatePlan();
  await expect(loadPlan('acc_1')).resolves.toMatchObject({ planName: 'Starter' });
  expect(authFetch).toHaveBeenCalledTimes(2);
});
