import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const h = vi.hoisted(() => ({ role: 'agent', getCommerceDocument: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({ requireSession: async () => ({ userId: USER, accountId: ACCOUNT, role: h.role, sessionId: 's' }) }));
vi.mock('@/lib/data/server', () => ({
  createClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: ACCOUNT, name: 'Acme' }, error: null });
      return b;
    },
  }),
}));
vi.mock('@/lib/commerce/documents', async (original) => ({
  ...(await original<typeof import('@/lib/commerce/documents')>()),
  getCommerceDocument: h.getCommerceDocument,
}));

import { GET } from './route';

const params = () => ({ params: Promise.resolve({ id: DOC }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'agent';
  h.getCommerceDocument.mockResolvedValue({
    id: DOC, kind: 'receipt', number: 'RCPT/2026-27/1', fy: '2026-27', currency: 'INR', order_id: null, appointment_id: null,
    payment_id: null, refund_id: null, seller: { legal_name: 'Shop', gstin: null, address: null, state_code: null },
    buyer: { name: '<i>x</i>' }, address: null, line_items: [], subtotal_minor: 100, discount_minor: 0, shipping_minor: 0,
    tax_minor: 0, cgst_minor: 0, sgst_minor: 0, igst_minor: 0, total_minor: 100, tax_inclusive: null, issued_at: '2026-11-03T00:00:00Z',
  });
});

describe('GET /api/commerce/documents/[id]', () => {
  it('serves escaped printable HTML under a CSP with no scripts', async () => {
    const res = await GET(new Request('http://localhost/d'), params());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('RCPT/2026-27/1');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
  });

  it('refuses viewers and hides missing or foreign documents as 404', async () => {
    h.role = 'viewer';
    expect((await GET(new Request('http://localhost/d'), params())).status).toBe(403);
    h.role = 'agent';
    h.getCommerceDocument.mockResolvedValueOnce(null);
    expect((await GET(new Request('http://localhost/d'), params())).status).toBe(404);
  });
});
