// GET /api/search?q=&limit=
//   (any member) — the header search: up to `limit` (default 5, at most 8) contacts, orders, products
//   and bookings matching q, each { id, title, subtitle, href, at? }. Orders and products only for
//   agents and above (as their list routes). A q shorter than 2 characters returns empty groups.
//   200 { contacts, orders, products, bookings }; 400 for a bad q or limit.
import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { GLOBAL_SEARCH_DEFAULT_LIMIT, GLOBAL_SEARCH_MAX_LIMIT, globalSearch } from '@/lib/search/global';
import { parseLimit, parseQuery } from '@/lib/search/normalise';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const params = new URL(request.url).searchParams;
    const result = await globalSearch(tenantOf(ctx), {
      q: parseQuery(params.get('q')),
      limit: parseLimit(params.get('limit'), GLOBAL_SEARCH_DEFAULT_LIMIT, GLOBAL_SEARCH_MAX_LIMIT),
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return audienceError(err);
  }
}
