// GET /api/broadcasts/sales?ids=<uuid>,<uuid>… — the orders and revenue each campaign brought in
// (any member; the attribution rule is in src/lib/broadcasts/attribution.ts). One query for the
// whole visible page of campaigns. Unknown ids, or another workspace's, read as no sales.

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { campaignSales, MAX_SALES_CAMPAIGNS } from '@/lib/broadcasts/attribution';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const ids = (new URL(request.url).searchParams.get('ids') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    if (!ids.length || ids.length > MAX_SALES_CAMPAIGNS || !ids.every((id) => UUID.test(id))) {
      return NextResponse.json({ error: 'invalid_ids' }, { status: 400 });
    }
    const sales = await withTenant(tenantOf(ctx), (tx) => campaignSales(tx, ctx.accountId, ids.map((id) => id.toLowerCase())));
    return NextResponse.json({ sales }, { headers: { 'Cache-Control': 'private, max-age=60' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
