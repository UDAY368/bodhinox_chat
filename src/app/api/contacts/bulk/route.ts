// POST /api/contacts/bulk — add to / remove from a list, add a tag, or delete
// every contact matching the contacts page's view:
// { scope: { segmentId? | listId? | tagIds?, search? }, action: { type, listId? | tagId? }, expected }.
// Agents and above; the proxy enforces Origin and CSRF on every API mutation.
// 409 when the match count is no longer `expected`.

import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { BulkCountChangedError, bulkContactAction } from '@/lib/contacts/bulk';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await request.json().catch(() => null);
    return NextResponse.json(await bulkContactAction(tenantOf(ctx), body));
  } catch (err) {
    if (err instanceof BulkCountChangedError)
      return NextResponse.json({ error: err.message, matched: err.matched }, { status: 409 });
    return audienceError(err);
  }
}
