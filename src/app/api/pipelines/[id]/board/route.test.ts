// Board, stage page and deal-by-id routes: any member reads (requireRole('viewer')),
// filters are validated before any query, a refused caller reads nothing, and an
// unknown or other-workspace id is a 404.
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn(), loadBoard: vi.fn(), loadStageDeals: vi.fn(), getDeal: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: { status?: number }) => Response.json({ error: 'Denied' }, { status: error.status ?? 500 }),
}));
vi.mock('@/lib/pipelines/board', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pipelines/board')>();
  return { ...actual, loadBoard: mocks.loadBoard, loadStageDeals: mocks.loadStageDeals, getDeal: mocks.getDeal };
});

import { BoardError } from '@/lib/pipelines/board';
import { GET as board } from './route';
import { GET as stageDeals } from '../deals/route';
import { GET as dealById } from '../../../deals/[id]/route';

const PIPE = '11111111-1111-4111-8111-111111111111';
const STAGE = '22222222-2222-4222-8222-222222222222';
const ctx = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', role: 'viewer' };
const params = <T,>(value: T) => ({ params: Promise.resolve(value) });
const get = (path: string) => new Request(`http://local.test${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(ctx);
  mocks.loadBoard.mockResolvedValue({ stages: [], deals: [], overview: [] });
  mocks.loadStageDeals.mockResolvedValue({ deals: [], hasMore: false });
});

it('lets any member read the board in their own workspace, uncached', async () => {
  const res = await board(get(`/api/pipelines/${PIPE}/board?view=won&owner=none&q=acme`), params({ id: PIPE }));
  expect(res.status).toBe(200);
  expect(mocks.requireRole).toHaveBeenCalledWith('viewer');
  expect(mocks.loadBoard).toHaveBeenCalledWith({ accountId: ctx.accountId, userId: ctx.userId, role: 'viewer' }, PIPE,
    { view: 'won', owner: 'none', q: 'acme' });
  expect(res.headers.get('Cache-Control')).toContain('no-store');
  expect((await res.json()).pageSize).toBe(25);
});

it.each(['view=all', 'owner=someone', `q=${'x'.repeat(101)}`])('rejects %s before any query', async (query) => {
  expect((await board(get(`/api/pipelines/${PIPE}/board?${query}`), params({ id: PIPE }))).status).toBe(400);
  expect(mocks.loadBoard).not.toHaveBeenCalled();
});

it('rejects a bad offset on the stage page', async () => {
  for (const offset of ['-1', '1.5', 'x', '20000']) {
    expect((await stageDeals(get(`/api/pipelines/${PIPE}/deals?stage=${STAGE}&offset=${offset}`), params({ id: PIPE }))).status).toBe(400);
  }
  expect(mocks.loadStageDeals).not.toHaveBeenCalled();
  expect((await stageDeals(get(`/api/pipelines/${PIPE}/deals?stage=${STAGE}&offset=25`), params({ id: PIPE }))).status).toBe(200);
  expect(mocks.loadStageDeals).toHaveBeenCalledWith(expect.anything(), PIPE, STAGE, { view: 'open', owner: 'all', q: '' }, 25);
});

it('reads nothing when the caller is refused', async () => {
  mocks.requireRole.mockRejectedValue({ status: 401 });
  expect((await board(get(`/api/pipelines/${PIPE}/board`), params({ id: PIPE }))).status).toBe(401);
  expect((await dealById(get(`/api/deals/${PIPE}`), params({ id: PIPE }))).status).toBe(401);
  expect(mocks.loadBoard).not.toHaveBeenCalled();
  expect(mocks.getDeal).not.toHaveBeenCalled();
});

it('answers 404 for a deal or pipeline outside the workspace', async () => {
  mocks.getDeal.mockRejectedValue(new BoardError('not_found', 404));
  const res = await dealById(get(`/api/deals/${PIPE}`), params({ id: PIPE }));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: 'not_found', code: 'not_found' });
  mocks.loadBoard.mockRejectedValue(new BoardError('not_found', 404));
  expect((await board(get(`/api/pipelines/${PIPE}/board`), params({ id: PIPE }))).status).toBe(404);
});
