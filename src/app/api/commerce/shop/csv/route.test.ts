import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  role: 'admin', limited: false, csrfOk: true,
  exportProductsCsv: vi.fn(), prepareImport: vi.fn(), importInline: vi.fn(), queueImport: vi.fn(), listImportJobs: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }),
  assertMutation: async () => { if (!h.csrfOk) { const { ForbiddenError } = await import('@/lib/auth/errors'); throw new ForbiddenError('csrf'); } },
}));
vi.mock('@/lib/auth/permissions', () => ({ requirePermission: async () => {} }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ tx: true }) }));
vi.mock('@/lib/commerce/catalogue/product-csv-import', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/catalogue/product-csv-import')>()),
  exportProductsCsv: h.exportProductsCsv, prepareImport: h.prepareImport, importInline: h.importInline,
  queueImport: h.queueImport, listImportJobs: h.listImportJobs,
}));

import { GET as EXPORT } from './export/route';
import { POST as PREVIEW } from './preview/route';
import { POST as IMPORT } from './import/route';
import { GET as JOBS } from './jobs/route';

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request('http://localhost/x', { method: 'POST', body, headers: { 'Content-Type': 'text/csv', ...headers } });
const get = () => new Request('http://localhost/x');
const prepared = (totalRows: number, planned = 1) => ({
  totalRows, ignoredColumns: 0, errors: [], categories: new Map(), existing: new Map(),
  plan: { planned: Array.from({ length: planned }, (_, i) => ({ row: { rowNumber: i + 2, sku: `A${i}` }, kind: 'create' })), errors: [], counts: { create: planned, update: 0, newProducts: planned } },
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h, { role: 'admin', limited: false, csrfOk: true });
  h.exportProductsCsv.mockResolvedValue({ csv: 'sku\r\nA1\r\n', rows: 1 });
  h.prepareImport.mockResolvedValue(prepared(2));
  h.importInline.mockResolvedValue({ mode: 'inline', created: 1, updated: 0, error_count: 0, errors: [], errors_capped: false });
  h.queueImport.mockResolvedValue({ mode: 'queued', import_id: 'job' });
  h.listImportJobs.mockResolvedValue([]);
});

describe('product CSV routes', () => {
  it('keep agents and viewers out of every one', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await EXPORT(get())).status).toBe(403);
      expect((await JOBS(get())).status).toBe(403);
      expect((await PREVIEW(post('sku\nA'))).status).toBe(403);
      expect((await IMPORT(post('sku\nA'))).status).toBe(403);
    }
    expect(h.exportProductsCsv).not.toHaveBeenCalled();
    expect(h.importInline).not.toHaveBeenCalled();
    expect(h.queueImport).not.toHaveBeenCalled();
  });

  it('refuse a write without the CSRF proof', async () => {
    h.csrfOk = false;
    expect((await PREVIEW(post('sku\nA'))).status).toBe(403);
    expect((await IMPORT(post('sku\nA'))).status).toBe(403);
    expect(h.importInline).not.toHaveBeenCalled();
  });

  it('export is a no-store attachment', async () => {
    const res = await EXPORT(get());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="products-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe('sku\r\nA1\r\n');
  });

  it('refuse a file over 5 MB before reading it all', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    for (const handler of [PREVIEW, IMPORT]) {
      const res = await handler(post(big));
      expect(res.status).toBe(413);
      expect((await res.json()).code).toBe('csv_too_large');
    }
    expect((await PREVIEW(post('x', { 'content-length': '99999999' }))).status).toBe(413);
    expect(h.prepareImport).not.toHaveBeenCalled();
  });

  it('turn an unreadable file into a coded refusal', async () => {
    const { CsvError } = await import('@/lib/commerce/catalogue/product-csv');
    h.prepareImport.mockRejectedValue(new CsvError('missing_sku_column'));
    const res = await PREVIEW(post('name\nA'));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('csv_missing_sku_column');
  });

  it('preview writes nothing and says how the file would apply', async () => {
    h.prepareImport.mockResolvedValue(prepared(500));
    const res = await PREVIEW(post('sku\nA'));
    expect(res.status).toBe(200);
    expect((await res.json()).preview).toMatchObject({ mode: 'queued', total_rows: 500, create: 1 });
    expect(h.importInline).not.toHaveBeenCalled();
    expect(h.queueImport).not.toHaveBeenCalled();
  });

  it('import applies a small file now and queues a big one with 202', async () => {
    expect((await IMPORT(post('sku\nA'))).status).toBe(200);
    expect(h.importInline).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT, userId: USER, role: 'admin' }), 'sku\nA');
    h.prepareImport.mockResolvedValue(prepared(201));
    const res = await IMPORT(post('sku\nB'));
    expect(res.status).toBe(202);
    expect((await res.json()).result).toEqual({ mode: 'queued', import_id: 'job' });
    expect(h.queueImport).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACCOUNT }), 'sku\nB', 201);
  });

  it('import with no usable row writes nothing and reports the errors', async () => {
    h.prepareImport.mockResolvedValue({ ...prepared(1, 0), errors: [{ row: 2, field: 'sku', code: 'required' }] });
    const res = await IMPORT(post('sku\n'));
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ created: 0, error_count: 1 });
    expect(h.importInline).not.toHaveBeenCalled();
    expect(h.queueImport).not.toHaveBeenCalled();
  });

  it('answer 409 while another import runs', async () => {
    const { CatalogueError } = await import('@/lib/commerce/catalogue/products');
    h.prepareImport.mockResolvedValue(prepared(300));
    h.queueImport.mockRejectedValue(new CatalogueError('import_running'));
    expect((await IMPORT(post('sku\nA'))).status).toBe(409);
  });
});
