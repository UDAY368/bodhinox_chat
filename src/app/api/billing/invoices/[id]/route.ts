// GET /api/billing/invoices/{id} — admins: one tax invoice.
//   default        JSON { invoice }
//   ?format=html   a self-contained printable page (the browser saves it as PDF);
//                  ?download=1 asks the browser to save the HTML file instead.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { billingErrorResponse, NO_STORE } from '@/lib/billing/http';
import { getInvoice, renderInvoiceHtml, sellerDetails } from '@/lib/billing/invoices';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await context.params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
    const invoice = await withTenant(tenantOf(ctx), (tx) => getInvoice(tx, ctx.accountId, id));
    if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
    const url = new URL(request.url);
    if (url.searchParams.get('format') !== 'html') return NextResponse.json({ invoice }, { headers: NO_STORE });
    const filename = `invoice-${invoice.number.replace(/[^A-Za-z0-9-]+/g, '-')}.html`;
    return new Response(renderInvoiceHtml(invoice, sellerDetails()), {
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/html; charset=utf-8',
        // The page has no scripts or external assets.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename="${filename}"`,
      },
    });
  } catch (error) {
    return billingErrorResponse(error);
  }
}
