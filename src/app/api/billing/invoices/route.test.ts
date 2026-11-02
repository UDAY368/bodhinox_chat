import { beforeEach, expect, it, vi } from 'vitest';

const ctx = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'admin' };
const INVOICE = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ requireRole: vi.fn(), list: vi.fn(), get: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: { status?: number }) => Response.json({ error: 'denied' }, { status: e?.status ?? 500 }),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: (_c: unknown, op: (tx: unknown) => unknown) => op({}) }));
vi.mock('@/lib/billing/invoices', async (orig) => ({
  ...(await orig<typeof import('@/lib/billing/invoices')>()),
  listInvoices: h.list,
  getInvoice: h.get,
  sellerDetails: () => ({ name: 'Bodhinox', gstin: null, address: 'Bengaluru', stateCode: '29' }),
}));

import { GET as LIST } from './route';
import { GET as ONE } from './[id]/route';

const one = (id: string, query = '') => ONE(new Request(`http://localhost/api/billing/invoices/${id}${query}`), { params: Promise.resolve({ id }) });
const detail = {
  id: INVOICE, number: 'BX/2026-27/000007', issuedAt: '2026-11-02T10:00:00Z', periodStart: null, periodEnd: null, currency: 'INR',
  totalMinor: 118000, status: 'paid', subtotalMinor: 100000, cgstMinor: 0, sgstMinor: 0, igstMinor: 18000, placeOfSupply: '27',
  gstin: null, billTo: { legal_name: 'Acme <b>' }, lines: [], paidAt: '2026-11-02T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue(ctx);
  h.list.mockResolvedValue([{ id: INVOICE, number: 'BX/2026-27/000007' }]);
  h.get.mockResolvedValue(detail);
});

it('lists and shows invoices to admins of the workspace', async () => {
  expect(await (await LIST()).json()).toEqual({ invoices: [{ id: INVOICE, number: 'BX/2026-27/000007' }] });
  expect(h.list).toHaveBeenCalledWith({}, ctx.accountId);
  expect((await (await one(INVOICE)).json()).invoice.number).toBe('BX/2026-27/000007');
  expect(h.get).toHaveBeenCalledWith({}, ctx.accountId, INVOICE);
});

it('renders a printable page with a locked-down CSP and escaped values', async () => {
  const res = await one(INVOICE, '?format=html&download=1');
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(res.headers.get('content-disposition')).toBe('attachment; filename="invoice-BX-2026-27-000007.html"');
  const html = await res.text();
  expect(html).toContain('Acme &lt;b&gt;');
  expect(html).toContain('IGST @ 18%');
});

it('is admin only and hides other workspaces and bad ids as not found', async () => {
  h.get.mockResolvedValue(null);
  expect((await one(INVOICE)).status).toBe(404);
  expect((await one('../etc')).status).toBe(404);
  h.requireRole.mockRejectedValue(Object.assign(new Error('role'), { status: 403 }));
  expect((await LIST()).status).toBe(403);
  expect((await one(INVOICE)).status).toBe(403);
});
