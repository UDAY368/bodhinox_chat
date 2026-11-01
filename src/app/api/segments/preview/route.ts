// POST /api/segments/preview { filter } | { segmentId } — how many contacts
// match, and how many may receive marketing (not opted out, not blocked).
// Any member.

import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { AudienceFilterError } from '@/lib/audience/filter';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { previewAudience } from '@/lib/audience/segments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as { filter?: unknown; segmentId?: unknown } | null;
    if (typeof body?.segmentId === 'string') {
      if (!UUID.test(body.segmentId)) throw new AudienceFilterError('Segment is unavailable in this workspace');
      return NextResponse.json(await previewAudience(tenantOf(ctx), { segmentId: body.segmentId }));
    }
    return NextResponse.json(await previewAudience(tenantOf(ctx), { filter: body?.filter }));
  } catch (err) {
    return audienceError(err);
  }
}
