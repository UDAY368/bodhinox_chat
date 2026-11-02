// GET  /api/inbox/saved-filters — the caller's own saved inbox views (any member).
//   200 { saved_filters: SavedFilter[] }
// POST /api/inbox/saved-filters — save a view { name, filters }.
//   201 { saved_filter }; 400 invalid; 409 at the per-member cap.
// Views are private to the member who saved them.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  createSavedFilter,
  inboxPreferenceErrorResponse,
  listSavedFilters,
  parseSavedFilterCreate,
  PREFERENCE_WRITE_LIMIT,
} from '@/lib/inbox/saved-filters-store';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    return NextResponse.json({ saved_filters: await listSavedFilters(tenantOf(ctx)) });
  } catch (error) {
    return inboxPreferenceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(`inbox:saved-filters:${ctx.userId}`, PREFERENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseSavedFilterCreate(await request.json().catch(() => null));
    return NextResponse.json({ saved_filter: await createSavedFilter(tenantOf(ctx), input) }, { status: 201 });
  } catch (error) {
    return inboxPreferenceErrorResponse(error);
  }
}
