// GET /api/inbox/failed — every member, viewers included.
//   The inbox's "Failed" filter: 200 { conversationIds: [...] } for the
//   conversations the caller can see whose latest agent or bot message failed
//   to send (active in the last 30 days), newest first, at most 5000. Read-only.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { conversationsWithFailedLastOutbound } from '@/lib/inbox/failed-outbound';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const conversationIds = await conversationsWithFailedLastOutbound(tenantOf(ctx));
    return NextResponse.json({ conversationIds }, { headers: NO_STORE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
