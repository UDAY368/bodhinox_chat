// GET /api/commerce/orders/manual-options?q= — what a manual order can sell (agents and above): published,
//   active, priced catalogue variants with their catalogue price and free stock, by product name or SKU.
//   200 { variants: SellableVariant[], currency: string | null }.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listSellableVariants } from '@/lib/commerce/manual-orders';
import { orderErrorResponse } from '@/lib/commerce/orders';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const q = new URL(request.url).searchParams.get('q');
    return NextResponse.json(await listSellableVariants(tenantOf(ctx), q), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return orderErrorResponse(error);
  }
}
