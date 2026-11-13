import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin',
  signedIn: true,
  mutationOk: true,
  calls: [] as { fn: string; args: unknown[] }[],
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
vi.mock('@/lib/analytics/saved-reports', async (original) => {
  const actual = await original<typeof import('@/lib/analytics/saved-reports')>();
  const fake = (fn: string, result: unknown) => async (...args: unknown[]) => {
    h.calls.push({ fn, args: args.slice(1) });
    if (h.fail) throw h.fail;
    return result;
  };
  return {
    ...actual,
    listSavedReports: fake('list', [{ id: 'r1' }]),
    createSavedReport: fake('create', { id: 'r2' }),
    updateSavedReport: fake('update', { id: 'r1' }),
    deleteSavedReport: fake('delete', undefined),
    duplicateSavedReport: fake('duplicate', { id: 'r3' }),
    previewSavedReport: fake('preview', { rows: [] }),
    exportSavedReport: fake('export', { bytes: new TextEncoder().encode('a,b\r\n'), filename: 'weekly_2026-11-01_2026-11-07.csv', format: 'csv' }),
    setSavedReportSchedule: fake('schedule', { id: 'r1' }),
    removeSavedReportSchedule: fake('unschedule', { id: 'r1' }),
  };
});

import { SavedReportError } from '@/lib/analytics/saved-reports';
import { ScheduleError } from '@/lib/analytics/report-schedules';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET as LIST, POST as CREATE } from './route';
import { DELETE, PATCH } from './[id]/route';
import { POST as DUPLICATE } from './[id]/duplicate/route';
import { GET as PREVIEW } from './[id]/preview/route';
import { GET as EXPORT } from './[id]/export/route';
import { DELETE as UNSCHEDULE, PUT as SCHEDULE } from './[id]/schedule/route';

const R = '44444444-4444-4444-8444-444444444444';
const ctx = { params: Promise.resolve({ id: R }) };
const req = (method: string, path = '', body?: unknown) =>
  new Request(`http://x/api/analytics/saved-reports${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  Object.assign(h, { role: 'admin', signedIn: true, mutationOk: true, calls: [], fail: null });
  __resetRateLimitForTests();
});

describe('saved report routes', () => {
  it('need a session and admin or owner, and mutations need the origin/CSRF check', async () => {
    h.signedIn = false;
    expect((await LIST(req('GET'))).status).toBe(401);
    h.signedIn = true;
    h.role = 'agent';
    expect((await LIST(req('GET'))).status).toBe(403);
    expect((await CREATE(req('POST', '', {}))).status).toBe(403);
    expect((await EXPORT(req('GET', `/${R}/export`), ctx)).status).toBe(403);
    h.role = 'owner';
    h.mutationOk = false;
    for (const response of [
      await CREATE(req('POST', '', {})), await PATCH(req('PATCH', `/${R}`, {}), ctx), await DELETE(req('DELETE', `/${R}`), ctx),
      await DUPLICATE(req('POST', `/${R}/duplicate`), ctx), await SCHEDULE(req('PUT', `/${R}/schedule`, {}), ctx),
      await UNSCHEDULE(req('DELETE', `/${R}/schedule`), ctx),
    ]) expect(response.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it('passes the body through and answers with the report', async () => {
    const created = await CREATE(req('POST', '', { name: 'Weekly' }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ report: { id: 'r2' } });
    expect((await PATCH(req('PATCH', `/${R}`, { name: 'X' }), ctx)).status).toBe(200);
    expect((await DELETE(req('DELETE', `/${R}`), ctx)).status).toBe(204);
    expect((await DUPLICATE(req('POST', `/${R}/duplicate`), ctx)).status).toBe(201);
    expect((await PREVIEW(req('GET', `/${R}/preview`), ctx)).status).toBe(200);
    await SCHEDULE(req('PUT', `/${R}/schedule`, { cadence: 'daily', hour_local: 9, minute_local: 15, recipients: ['u'] }), ctx);
    expect(h.calls.find((c) => c.fn === 'schedule')?.args).toEqual([R, { cadence: 'daily', hourLocal: 9, minuteLocal: 15, recipients: ['u'] }]);
    expect(h.calls.find((c) => c.fn === 'create')?.args).toEqual([{ name: 'Weekly' }]);
  });

  it('streams an export as a private attachment and refuses an unknown format', async () => {
    const file = await EXPORT(req('GET', `/${R}/export?format=csv`), ctx);
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Disposition')).toBe('attachment; filename="weekly_2026-11-01_2026-11-07.csv"');
    expect(file.headers.get('Cache-Control')).toBe('private, no-store');
    expect(file.headers.get('Content-Type')).toContain('text/csv');
    expect(await file.text()).toBe('a,b\r\n');
    expect((await EXPORT(req('GET', `/${R}/export?format=xlsx`), ctx)).status).toBe(400);
  });

  it('maps library errors to translated statuses', async () => {
    h.fail = new SavedReportError('duplicate_name', 409);
    expect((await CREATE(req('POST', '', {}))).status).toBe(409);
    h.fail = new SavedReportError('invalid', 400, 'metrics');
    const invalid = await CREATE(req('POST', '', {}));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).field).toBe('metrics');
    h.fail = new SavedReportError('not_found', 404);
    expect((await PATCH(req('PATCH', `/${R}`, {}), ctx)).status).toBe(404);
    expect((await PREVIEW(req('GET', `/${R}/preview`), ctx)).status).toBe(404);
    h.fail = new ScheduleError('too_many', 409);
    expect((await SCHEDULE(req('PUT', `/${R}/schedule`, {}), ctx)).status).toBe(409);
    h.fail = new Error('boom');
    const crash = await LIST(req('GET'));
    expect(crash.status).toBe(500);
    expect(await crash.text()).not.toContain('boom');
  });
});
