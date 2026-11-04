import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  signedIn: true,
  mutationOk: true,
  created: [] as unknown[],
  updated: [] as unknown[],
  deleted: [] as string[],
  fail: null as unknown,
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => {
    if (!h.signedIn) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
    return { userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111', role: h.role, sessionId: 's' };
  },
  assertMutation: async () => {
    if (!h.mutationOk) {
      const { UnauthorizedError } = await import('@/lib/auth/errors');
      throw new UnauthorizedError();
    }
  },
}));
vi.mock('@/lib/analytics/report-schedules', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/report-schedules')>()),
  listSchedules: async () => [{ id: 's1' }],
  createSchedule: async (_actor: unknown, input: unknown) => {
    if (h.fail) throw h.fail;
    h.created.push(input);
    return { id: 's2' };
  },
  updateSchedule: async (_actor: unknown, id: string, input: unknown) => {
    if (h.fail) throw h.fail;
    h.updated.push({ id, input });
    return { id };
  },
  deleteSchedule: async (_actor: unknown, id: string) => {
    if (h.fail) throw h.fail;
    h.deleted.push(id);
  },
}));

import { ScheduleError } from '@/lib/analytics/report-schedules';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';

const S = '44444444-4444-4444-8444-444444444444';
const post = (body: unknown) => POST(new Request('http://x/api/analytics/reports/schedules', { method: 'POST', body: JSON.stringify(body) }));
const patch = (body: unknown) => PATCH(new Request(`http://x/api/analytics/reports/schedules/${S}`, { method: 'PATCH', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: S }) });
const del = () => DELETE(new Request(`http://x/api/analytics/reports/schedules/${S}`, { method: 'DELETE' }), { params: Promise.resolve({ id: S }) });

beforeEach(() => {
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, created: [], updated: [], deleted: [], fail: null });
  __resetRateLimitForTests();
});

it('lists schedules for admins only, never cached', async () => {
  const res = await GET(new Request('http://x/api/analytics/reports/schedules'));
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(await res.json()).toEqual({ schedules: [{ id: 's1' }] });
  h.role = 'agent';
  expect((await GET(new Request('http://x/api/analytics/reports/schedules'))).status).toBe(403);
  h.signedIn = false;
  expect((await GET(new Request('http://x/api/analytics/reports/schedules'))).status).toBe(401);
});

it('creates with the mapped body; refuses agents and failed CSRF before creating', async () => {
  const res = await post({ kind: 'campaign_summary', format: 'pdf', cadence: 'weekly', hour_local: 9, recipients: ['u'] });
  expect(res.status).toBe(201);
  expect(h.created).toEqual([{ kind: 'campaign_summary', format: 'pdf', cadence: 'weekly', hourLocal: 9, recipients: ['u'] }]);
  h.role = 'viewer';
  expect((await post({})).status).toBe(403);
  h.role = 'admin';
  h.mutationOk = false;
  expect((await post({})).status).toBe(401);
  expect(h.created).toHaveLength(1);
});

it('maps schedule errors to 400, 404 and 409', async () => {
  h.fail = new ScheduleError('invalid_recipients', 400);
  expect((await post({ kind: 'x' })).status).toBe(400);
  h.fail = new ScheduleError('too_many', 409);
  expect((await post({ kind: 'x' })).status).toBe(409);
  h.fail = null;
  expect((await POST(new Request('http://x/api/analytics/reports/schedules', { method: 'POST', body: '[]' }))).status).toBe(400);
  h.fail = new ScheduleError('not_found', 404);
  expect((await patch({ paused: true })).status).toBe(404);
  h.fail = new ScheduleError('creator_lost_access', 409);
  expect((await patch({ paused: false })).status).toBe(409);
  h.fail = new ScheduleError('not_found', 404);
  expect((await del()).status).toBe(404);
});

it('pauses and deletes for admins, behind CSRF', async () => {
  expect((await patch({ paused: true, hour_local: 6 })).status).toBe(200);
  expect(h.updated).toEqual([{ id: S, input: { paused: true, recipients: undefined, hourLocal: 6, cadence: undefined, format: undefined } }]);
  expect((await del()).status).toBe(204);
  expect(h.deleted).toEqual([S]);
  h.mutationOk = false;
  expect((await del()).status).toBe(401);
  h.mutationOk = true;
  h.role = 'agent';
  expect((await patch({ paused: true })).status).toBe(403);
  expect(h.deleted).toEqual([S]);
});

it('rate limits schedule changes', async () => {
  for (let i = 0; i < 10; i++) await patch({ paused: true });
  expect((await patch({ paused: true })).status).toBe(429);
});
