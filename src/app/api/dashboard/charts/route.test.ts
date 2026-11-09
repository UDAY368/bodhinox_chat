import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ account: vi.fn(), load: vi.fn(), limit: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({ getCurrentAccount: mocks.account, toErrorResponse: (error: { status?: number }) => new Response(null, { status: error.status ?? 500 }) }));
vi.mock('@/lib/dashboard/charts', () => ({ CHART_RANGES: [7, 30, 90], loadDashboardCharts: mocks.load }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.limit, rateLimitResponse: () => new Response(null, { status: 429 }) }));
import { GET } from './route';
beforeEach(() => {
  vi.clearAllMocks(); mocks.account.mockResolvedValue({ accountId: 'a', userId: 'u', role: 'agent' });
  mocks.load.mockResolvedValue({ series: [] }); mocks.limit.mockReturnValue({ success: true });
});
it('passes only authenticated tenant identity and validated range to aggregation', async () => {
  const response = await GET(new Request('http://local.test/api/dashboard/charts?days=30&accountId=other'));
  expect(response.status).toBe(200);
  expect(mocks.load).toHaveBeenCalledWith({ accountId: 'a', userId: 'u', role: 'agent' }, 30);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
});
it.each(['0', '1', '100', 'oops'])('rejects unsupported range %s', async days => {
  expect((await GET(new Request(`http://local.test/api/dashboard/charts?days=${days}`))).status).toBe(400);
  expect(mocks.load).not.toHaveBeenCalled();
});
it('does not aggregate for unauthenticated or rate-limited requests', async () => {
  mocks.account.mockRejectedValueOnce({ status: 401 });
  expect((await GET(new Request('http://local.test'))).status).toBe(401);
  mocks.limit.mockReturnValue({ success: false });
  expect((await GET(new Request('http://local.test'))).status).toBe(429);
  expect(mocks.load).not.toHaveBeenCalled();
});
