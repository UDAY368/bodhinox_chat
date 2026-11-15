// GET /api/commerce/reviews?status=pending|published|hidden&before=<cursor> — product reviews, newest first (agents and above).
//   200 { reviews, next }; 400 invalid for an unknown status or cursor. The reviews hold the first-name initial only, never a phone number.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { listReviews, parseReviewCursor } from '@/lib/commerce/review-data';
import { isReviewStatus } from '@/lib/commerce/reviews';
import { storeErrorResponse, StoreError } from '@/lib/commerce/store-settings';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const params = new URL(request.url).searchParams;
    const status = params.get('status');
    if (status !== null && status !== '' && !isReviewStatus(status)) throw new StoreError('invalid', { field: 'status' });
    const cursor = params.get('before');
    const before = cursor ? parseReviewCursor(cursor) : null;
    if (cursor && !before) throw new StoreError('invalid', { field: 'before' });
    return NextResponse.json(await listReviews(tenantOf(ctx), { status: status ? (status as 'pending') : null, before }));
  } catch (error) {
    return storeErrorResponse(error);
  }
}
