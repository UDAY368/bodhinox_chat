import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/lib/auth/client', () => ({ authFetch: h.authFetch }));

import { exportOrders, listOrders, orderFilterParams } from './order-api';

const filters = { status: 'paid', source: 'storefront', q: ' 3F2A9C1B ', tag: 'vip', codConfirmation: 'pending' } as const;

beforeEach(() => h.authFetch.mockReset());

describe('order filters', () => {
  it('sends every list filter, trimmed, and leaves out empty ones', () => {
    expect(Object.fromEntries(orderFilterParams(filters))).toEqual({
      status: 'paid', source: 'storefront', q: '3F2A9C1B', tag: 'vip', cod_confirmation: 'pending',
    });
    expect(orderFilterParams({ status: '', source: '', q: '  ', tag: '', codConfirmation: '' }).toString()).toBe('');
  });

  it('gives the export exactly the filters the list uses', async () => {
    h.authFetch.mockResolvedValue(Response.json({ orders: [], next_cursor: null }));
    await listOrders({ ...filters, cursor: 'c1' });
    const listUrl = new URL(h.authFetch.mock.calls[0][0], 'http://x');
    h.authFetch.mockResolvedValue(new Response('"order"\r\n', { headers: { 'Content-Disposition': 'attachment; filename="orders-2026-11-19.csv"' } }));
    const out = await exportOrders(filters);
    const exportUrl = new URL(h.authFetch.mock.calls[1][0], 'http://x');
    expect(exportUrl.pathname).toBe('/api/commerce/orders/export');
    listUrl.searchParams.delete('cursor');
    expect(Object.fromEntries(exportUrl.searchParams)).toEqual(Object.fromEntries(listUrl.searchParams));
    expect(out).toMatchObject({ filename: 'orders-2026-11-19.csv', truncated: false });
  });
});

describe('exportOrders', () => {
  it('reports when the server stopped at its row cap', async () => {
    h.authFetch.mockResolvedValue(new Response('"order"\r\n', { headers: { 'X-Truncated': '1', 'X-Rows': '5000' } }));
    const out = await exportOrders({});
    expect(out.truncated).toBe(true);
    expect(out.filename).toBe('orders.csv');
    expect(await out.blob.text()).toContain('order');
  });

  it('throws on a refused export instead of saving an error page', async () => {
    h.authFetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(exportOrders({})).rejects.toThrow('403');
  });
});
