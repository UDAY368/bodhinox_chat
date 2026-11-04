import { beforeEach, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const REPORT = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({
  role: 'owner',
  opened: [] as string[],
  fetched: [] as string[],
  fail: null as unknown,
  format: 'csv' as 'csv' | 'pdf',
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: '22222222-2222-4222-8222-222222222222', accountId: '11111111-1111-4111-8111-111111111111',
    role: h.role, sessionId: 's', user: { id: 'u', email: 'a@b.test', user_metadata: { full_name: 'A' } } }),
}));
vi.mock('@/lib/analytics/reports', async (original) => ({
  ...(await original<typeof import('@/lib/analytics/reports')>()),
  openReportDownload: async (_actor: unknown, id: string) => {
    if (h.fail) throw h.fail;
    h.opened.push(id);
    return { objectKey: `11111111-1111-4111-8111-111111111111/reports/${id}.${h.format}`,
      filename: `campaign_daily_2026-10-01_2026-10-07.${h.format}`, format: h.format };
  },
}));
vi.mock('@/lib/analytics/report-storage', async (original) => ({
  reportContentType: (await original<typeof import('@/lib/analytics/report-storage')>()).reportContentType,
  getReportFile: async (_account: string, key: string) => {
    h.fetched.push(key);
    return new Blob(['﻿"day"\r\n']).stream();
  },
}));

import { ReportError } from '@/lib/analytics/reports';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { GET } from './route';

const get = (id = REPORT) => GET(new Request(`http://x/api/analytics/reports/${id}/download`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'owner';
  h.opened = [];
  h.fetched = [];
  h.fail = null;
  h.format = 'csv';
  __resetRateLimitForTests();
});

it('streams the private file as a CSV attachment after the audited open', async () => {
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="campaign_daily_2026-10-01_2026-10-07.csv"');
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(await res.text()).toContain('"day"');
  expect(h.opened).toEqual([REPORT]);
  expect(h.fetched).toEqual([`${ACCOUNT}/reports/${REPORT}.csv`]);
});

it('refuses agents without opening anything', async () => {
  h.role = 'agent';
  expect((await get()).status).toBe(403);
  expect(h.opened).toEqual([]);
});

it('answers 404 for unknown reports and 409 for ones not ready', async () => {
  h.fail = new ReportError('not_found', 404);
  expect((await get('nope')).status).toBe(404);
  h.fail = new ReportError('not_ready', 409);
  expect((await get()).status).toBe(409);
  expect(h.fetched).toEqual([]);
});

it('serves a PDF report with the PDF content type and file name', async () => {
  h.format = 'pdf';
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="campaign_daily_2026-10-01_2026-10-07.pdf"');
  expect(h.fetched).toEqual([`${ACCOUNT}/reports/${REPORT}.pdf`]);
});
