import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getCurrentAccount: vi.fn(), requireRole: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount, requireRole: mocks.requireRole,
  toErrorResponse: (error: { status?: number }) => Response.json({ error: 'Denied' }, { status: error.status ?? 500 }),
}));
import { GET, PATCH } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  const builder = { select: () => builder, update: mocks.update, eq: mocks.eq, single: async () => ({ data: { reply_target_minutes: 15 }, error: null }) };
  mocks.update.mockReturnValue(builder); mocks.eq.mockReturnValue(builder);
  const ctx = { accountId: 'tenant-a', db: { from: () => builder } };
  mocks.getCurrentAccount.mockResolvedValue(ctx); mocks.requireRole.mockResolvedValue(ctx);
});
const request = (value: unknown) => new Request('http://local.test/api/account/inbox', { method: 'PATCH', body: JSON.stringify({ reply_target_minutes: value }) });
it('reads only the caller workspace with private caching', async () => {
  const response = await GET();
  expect(await response.json()).toEqual({ reply_target_minutes: 15 });
  expect(response.headers.get('Cache-Control')).toContain('private');
  expect(mocks.eq).toHaveBeenCalledWith('id', 'tenant-a');
});
it('requires admin for updates and scopes the write', async () => {
  expect((await PATCH(request(15))).status).toBe(200);
  expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  expect(mocks.update).toHaveBeenCalledWith({ reply_target_minutes: 15 });
  expect(mocks.eq).toHaveBeenCalledWith('id', 'tenant-a');
});
it.each([0, 1441, 1.5, true, null, '1e2', ''])('rejects invalid target %s without writing', async value => {
  expect((await PATCH(request(value))).status).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('does not write when authorization rejects the caller', async () => {
  mocks.requireRole.mockRejectedValue({ status: 403 });
  expect((await PATCH(request(15))).status).toBe(403);
  expect(mocks.update).not.toHaveBeenCalled();
});
