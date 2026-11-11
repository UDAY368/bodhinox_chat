// GET /api/inbox/handled-by?member=<user id> — every member, viewers included.
//   The inbox's "Handled by" filter: 200 { conversationIds: [...] } for the
//   conversations the caller can see that the member handled (assigned now or
//   ever, resolved, assigned by them, or a message they sent), newest first,
//   at most 5000. A malformed or foreign member id answers an empty list.
//   Read-only.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { conversationsHandledBy } from '@/lib/inbox/handling-history';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const member = new URL(request.url).searchParams.get('member') ?? '';
    const conversationIds = await conversationsHandledBy(tenantOf(ctx), member);
    return NextResponse.json({ conversationIds }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
