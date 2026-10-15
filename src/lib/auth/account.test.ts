import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ require: vi.fn(), create: vi.fn() }));
vi.mock('./session', () => ({ requireSession: mocks.require }));
vi.mock('@/lib/data/server', () => ({ createClient: mocks.create }));
import {
  getCurrentAccount,
  requireRole,
  ForbiddenError,
  UnauthorizedError,
} from './account';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.require.mockResolvedValue({
    userId: 'user',
    accountId: 'tenant',
    role: 'agent',
  });
  mocks.create.mockResolvedValue({
    from: vi
      .fn()
      .mockReturnValue({
        select: vi
          .fn()
          .mockReturnValue({
            eq: vi
              .fn()
              .mockReturnValue({
                maybeSingle: async () => ({
                  data: { id: 'tenant', name: 'Workspace' },
                  error: null,
                }),
              }),
          }),
      }),
  });
});
describe('membership account authority', () => {
  it('uses server session membership role and scopes the account lookup', async () => {
    expect(await getCurrentAccount()).toMatchObject({
      userId: 'user',
      accountId: 'tenant',
      role: 'agent',
    });
    const db = await mocks.create.mock.results[0].value;
    expect(db.from).toHaveBeenCalledWith('accounts');
    expect(db.from().select().eq).toHaveBeenCalledWith('id', 'tenant');
  });
  it('rejects a missing session', async () => {
    mocks.require.mockRejectedValue(new UnauthorizedError());
    await expect(getCurrentAccount()).rejects.toBeInstanceOf(UnauthorizedError);
  });
  it('checks minimum roles against membership', async () => {
    await expect(requireRole('admin')).rejects.toBeInstanceOf(ForbiddenError);
  });
});
