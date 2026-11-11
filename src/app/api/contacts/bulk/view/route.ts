// GET /api/contacts/bulk/view?segmentId=|listId=|tagIds=a,b&search=&channel=whatsapp|instagram&subscribed=1&offset=&limit=
//   (any member) — one page of the contacts a bulk action on that view would reach, plus the
//   total match count. The contacts page lists through this while its Stage 5 channel filter or
//   "subscribed only" switch is on, so the count it shows is the count POST /api/contacts/bulk
//   checks. 400 for an invalid view; a list or segment of another workspace is 404.
import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { scopeContacts, scopeFromQuery } from '@/lib/contacts/bulk';

const int = (value: string | null, fallback: number, max: number) => {
  const n = Number(value);
  return value !== null && value !== '' && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const query = new URL(request.url).searchParams;
    return NextResponse.json(
      await scopeContacts(tenantOf(ctx), scopeFromQuery(query), {
        offset: int(query.get('offset'), 0, 1_000_000),
        limit: int(query.get('limit'), 25, 100) || 25,
      }),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (err) {
    return audienceError(err);
  }
}
