// GET /api/commerce/orders?status=&source=&contact_id=&conversation_id=&q=&from=&to=&limit=&cursor=
//   Orders, newest first (agents and above; viewers get 403).
//   200 { orders: OrderListItem[], next_cursor: string | null }; 400 { error } for a bad filter.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listOrders, orderErrorResponse, parseOrderFilters } from '@/lib/commerce/orders';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const filters = parseOrderFilters(new URL(request.url).searchParams);
    return NextResponse.json(await listOrders(tenantOf(ctx), filters));
  } catch (error) {
    return orderErrorResponse(error);
  }
}
