// GET /api/billing/invoices — admins: the workspace's tax invoices, newest first
// { invoices: [{ id, number, issuedAt, periodStart, periodEnd, currency, totalMinor, status }] }.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { billingErrorResponse, NO_STORE } from '@/lib/billing/http';
import { listInvoices } from '@/lib/billing/invoices';

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const invoices = await withTenant(tenantOf(ctx), (tx) => listInvoices(tx, ctx.accountId));
    return NextResponse.json({ invoices }, { headers: NO_STORE });
  } catch (error) {
    return billingErrorResponse(error);
  }
}
