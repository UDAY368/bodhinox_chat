// GET /api/lists/[id]/contacts?offset=&limit=&search= — one page of a
// list's contacts plus the total count (any member).

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { listContacts } from '@/lib/audience/lists';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const int = (value: string | null, fallback: number, max: number) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    const query = new URL(request.url).searchParams;
    const page = UUID.test(id)
      ? await listContacts(tenantOf(ctx), id, {
          offset: int(query.get('offset'), 0, 1_000_000),
          limit: int(query.get('limit'), 25, 100) || 25,
          search: (query.get('search') ?? '').slice(0, 200),
        })
      : null;
    return page ? NextResponse.json(page) : NextResponse.json({ error: 'List not found' }, { status: 404 });
  } catch (err) {
    return audienceError(err);
  }
}
