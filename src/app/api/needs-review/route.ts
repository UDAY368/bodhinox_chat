// GET /api/needs-review?kind=&page= (admins and owners) — sends whose outcome is uncertain, newest
//   first, a page at a time, with the total from the same SQL (src/lib/needs-review/review.ts).
//   200 { items, total, page, page_size }; 400 { code: 'invalid_request' } for an unknown kind or page.
//   ?count=1 answers { total } only (the Settings badge). Rows carry ids, a kind, a reason code, the
//   contact's name and times; never message text.
import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { countNeedsReview, isNeedsReviewKind, listNeedsReview } from '@/lib/needs-review/review';

const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Reviewing sends requires an admin role');
    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    const params = new URL(request.url).searchParams;
    if (params.get('count') === '1') return NextResponse.json({ total: await countNeedsReview(tenant) }, { headers: noStore });
    const kind = params.get('kind');
    const page = Number(params.get('page') ?? '0');
    if ((kind !== null && !isNeedsReviewKind(kind)) || !Number.isInteger(page) || page < 0 || page > 10_000)
      return NextResponse.json({ error: 'Invalid request', code: 'invalid_request' }, { status: 400 });
    return NextResponse.json(await listNeedsReview(tenant, { kind, page }), { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}
