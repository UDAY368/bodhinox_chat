// PATCH  /api/inbox/saved-filters/:id — rename, replace filters or move { name?, filters?, position? }.
//   200 { saved_filter }; 400 invalid; 404 not the caller's view.
// DELETE /api/inbox/saved-filters/:id — 200 { ok: true }; 404 not the caller's view.
// Only the member who saved a view can change it; another member's id is a 404.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  deleteSavedFilter,
  inboxPreferenceErrorResponse,
  parseSavedFilterPatch,
  PREFERENCE_WRITE_LIMIT,
  updateSavedFilter,
} from '@/lib/inbox/saved-filters-store';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(`inbox:saved-filters:${ctx.userId}`, PREFERENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const patch = parseSavedFilterPatch(await request.json().catch(() => null));
    return NextResponse.json({ saved_filter: await updateSavedFilter(tenantOf(ctx), id, patch) });
  } catch (error) {
    return inboxPreferenceErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(`inbox:saved-filters:${ctx.userId}`, PREFERENCE_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    await deleteSavedFilter(tenantOf(ctx), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return inboxPreferenceErrorResponse(error);
  }
}
