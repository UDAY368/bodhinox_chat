// GET /api/commerce/orders/export?<the list's filters> — the orders as a CSV download (admins and
//   owners only; agents get 403). At most 5000 newest orders; X-Truncated: 1 when more matched. Formula cells are
//   defused, numbers follow the member's phone masking, internal notes are not included.

import { NextResponse } from 'next/server';

import { tenantOf } from '@/lib/audience/http';
import { requireRole } from '@/lib/auth/account';
import { exportOrdersCsv } from '@/lib/commerce/order-export';
import { orderErrorResponse, parseOrderFilters } from '@/lib/commerce/orders';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = await checkRateLimit(`orders:export:${ctx.userId}`, { limit: 5, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const filters = parseOrderFilters(new URL(request.url).searchParams);
    const { csv, rows, truncated } = await exportOrdersCsv(tenantOf(ctx), filters);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'private, no-store', 'X-Rows': String(rows), ...(truncated ? { 'X-Truncated': '1' } : {}),
      },
    });
  } catch (error) {
    return orderErrorResponse(error);
  }
}
