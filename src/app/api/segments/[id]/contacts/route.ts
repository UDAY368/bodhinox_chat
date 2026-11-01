// GET /api/segments/[id]/contacts?offset=&limit=&search= — one page of a
// segment's contacts plus the total match count (any member).

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { segmentContacts } from '@/lib/audience/segments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const int = (value: string | null, fallback: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!UUID.test(id)) return NextResponse.json({ error: 'Segment not found' }, { status: 404 });
    const query = new URL(request.url).searchParams;
    const search = (query.get('search') ?? '').slice(0, 200);
    return NextResponse.json(
      await segmentContacts(tenantOf(ctx), id, {
        offset: int(query.get('offset'), 0, 1_000_000),
        limit: int(query.get('limit'), 25, 100) || 25,
        search,
      }),
    );
  } catch (err) {
    return audienceError(err);
  }
}
