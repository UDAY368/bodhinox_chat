// GET /api/commerce/orders?status=&source=&contact_id=&conversation_id=&q=&from=&to=&limit=&cursor=
//   Orders, newest first (agents and above; viewers get 403).
//   200 { orders: OrderListItem[], next_cursor: string | null }; 400 { error } for a bad filter.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listOrders, orderErrorResponse, parseOrderFilters } from '@/lib/commerce/orders';
import { maskEmbeddedContact, resolvePhoneMask } from '@/lib/inbox/masking-apply';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const filters = parseOrderFilters(new URL(request.url).searchParams);
    const page = await listOrders(tenantOf(ctx), filters);
    const mask = await resolvePhoneMask(tenantOf(ctx));
    return NextResponse.json(mask ? { ...page, orders: page.orders.map((o) => maskEmbeddedContact(o, true)) } : page);
  } catch (error) {
    return orderErrorResponse(error);
  }
}
